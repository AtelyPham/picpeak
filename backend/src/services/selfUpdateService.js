/**
 * The backend half of the in-app updater (docs/self-update.md).
 *
 * The updater (host agent or container, updater/picpeak-updater.sh) does the
 * actual `pull && up -d`. The backend's whole part in it:
 *   - take a database dump first, so a release whose migrations go wrong can be
 *     restored from Settings -> Backup;
 *   - then create update/request/update-requested (existence is the request);
 *   - withdraw that request again if nothing picks it up in time, or when an
 *     admin cancels it, so it never runs unattended days later;
 *   - read update/status/status.json, which only the updater writes and which
 *     this container mounts read-only, and report it.
 *
 * There is no version argument and nothing else to send: whoever controls this
 * process can trigger an update to the published channel tag and nothing more.
 * Every rule (no downgrade, no source build, manual-only releases) is enforced
 * by the updater itself, because this process is the one assumed compromised.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const logger = require('../utils/logger');
const { logActivity } = require('../database/db');
const { getAppSetting, upsertAppSetting } = require('../utils/appSettings');
const { getCurrentVersion } = require('./updateCheckService');

const CONTRACT_VERSION = 1;
const STATUS_MAX_BYTES = 64 * 1024;
const FIELD_MAX_LENGTH = 2000;
const LAST_LOGGED_RUN_KEY = 'self_update_last_logged_run';

// Mirrors write_status in updater/picpeak-updater.sh. Anything else in the
// file is ignored rather than passed through to the browser.
const STATES = new Set(['idle', 'running', 'succeeded', 'up_to_date', 'refused', 'failed', 'rolled_back']);
const TERMINAL_STATES = new Set(['succeeded', 'up_to_date', 'refused', 'failed', 'rolled_back']);
const STRING_FIELDS = [
  'updater_version', 'packaging', 'state', 'reason', 'step', 'message',
  'from_version', 'to_version', 'image', 'started_at', 'finished_at', 'updated_at'
];

// Backend-side phases, before the updater takes over.
//   backing_up     the database dump is running
//   backup_failed  the dump failed; no request was filed
//   request_failed the dump succeeded but the request file could not be written
//   requested      the request file exists and waits for the updater
//   withdrawn      an admin cancelled the request before the updater took it
//   expired        nothing took the request in time; the backend removed it
// Once the updater has taken the request, its status file is authoritative.
const ACTIVE_PHASES = new Set(['backing_up']);

const REASON_MESSAGES = {
  disabled: 'In-app updates are not enabled on this installation.',
  no_agent: 'The updater is not installed or not reachable.',
  unsupported_contract: 'The installed updater speaks a different file contract than this version of PicPeak.',
  request_dir_not_writable: 'PicPeak cannot write to its update request directory.',
  busy: 'An update is already in progress.'
};

class SelfUpdateError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

class SelfUpdateService {
  constructor() {
    this.job = null;
    this.starting = false;
    this.expiryTimer = null;
    this.lastLoggedRun = null;
  }

  get updateDir() {
    return process.env.PICPEAK_UPDATE_DIR || '/app/update';
  }

  get requestFile() {
    return path.join(this.updateDir, 'request', 'update-requested');
  }

  get statusFile() {
    return path.join(this.updateDir, 'status', 'status.json');
  }

  // How long a filed request may wait for the updater. Below the updater's own
  // limit (PICPEAK_UPDATER_REQUEST_MAX_AGE, 15 minutes), so the backend
  // normally withdraws first and can say so.
  get requestTtlMs() {
    const minutes = Number.parseInt(process.env.PICPEAK_SELF_UPDATE_REQUEST_TTL_MINUTES, 10);
    return (Number.isFinite(minutes) && minutes > 0 ? minutes : 10) * 60 * 1000;
  }

  // Fail closed: only the exact string enables it. An unset or mistyped value
  // keeps the feature off, as the issue agreed.
  isEnabled() {
    return process.env.PICPEAK_SELF_UPDATE === 'true';
  }

  /**
   * The updater's status, or null when there is none (no agent installed, or
   * the mounts are missing). Validated field by field: the file is written by
   * a root process, but it is still input, and only known fields reach the UI.
   */
  async readAgentStatus() {
    let raw;
    try {
      const handle = await fs.promises.open(this.statusFile, 'r');
      try {
        const { size } = await handle.stat();
        if (size > STATUS_MAX_BYTES) {
          logger.warn('Self-update status file is unexpectedly large; ignoring it', { size });
          return null;
        }
        raw = await handle.readFile('utf8');
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        logger.warn('Could not read the self-update status file', { error: error.message });
      }
      return null;
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      logger.warn('Self-update status file is not valid JSON; ignoring it');
      return null;
    }
    if (!parsed || typeof parsed !== 'object') return null;

    const status = { contract: Number.isInteger(parsed.contract) ? parsed.contract : null };
    for (const field of STRING_FIELDS) {
      const value = parsed[field];
      status[field] = typeof value === 'string' ? value.slice(0, FIELD_MAX_LENGTH) : null;
    }
    if (!STATES.has(status.state)) status.state = null;
    return status;
  }

  jobActive() {
    return Boolean(this.starting || (this.job && ACTIVE_PHASES.has(this.job.phase)));
  }

  // The pending request's lstat, or null. lstat, so a dangling link counts as
  // present too: the updater treats any entry there as a request.
  async pendingRequest() {
    try {
      return await fs.promises.lstat(this.requestFile);
    } catch {
      return null;
    }
  }

  async requestDirWritable() {
    try {
      await fs.promises.access(path.dirname(this.requestFile), fs.constants.W_OK);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Removes the pending request. The backend owns request/, so this only
   * unlinks the name it wrote; ENOENT means the updater took it first.
   * Returns true when this call removed it.
   */
  async removeRequest() {
    try {
      await fs.promises.unlink(this.requestFile);
      return true;
    } catch (error) {
      if (error.code !== 'ENOENT') {
        logger.error('Self-update: could not remove the update request', { error: error.message });
      }
      return false;
    }
  }

  /**
   * Withdraws a request nothing picked up within the TTL. Runs on a timer
   * after filing and again on every status read, which also covers a request
   * filed before a backend restart (the timer and the job are gone then, the
   * file's mtime is not).
   */
  async expireStaleRequest() {
    const stat = await this.pendingRequest();
    if (!stat || Date.now() - stat.mtimeMs < this.requestTtlMs) return;
    if (!(await this.removeRequest())) return;
    const job = this.job && this.job.phase === 'requested' ? this.job : null;
    if (job) job.phase = 'expired';
    logger.warn('Self-update: nothing picked up the update request in time; it was withdrawn');
    await logActivity('self_update_expired', { job_id: job?.id || null, minutes: this.requestTtlMs / 60000 });
  }

  /**
   * One activity row per finished updater run, so the result of the action
   * that restarts the stack is on record even though this process is replaced
   * mid-way. Keyed on the run's start time, persisted so a restart does not
   * log it twice.
   */
  async recordAgentResult(agent) {
    if (!agent || !TERMINAL_STATES.has(agent.state) || !agent.started_at) return;
    if (this.lastLoggedRun === agent.started_at) return;
    this.lastLoggedRun = agent.started_at;
    try {
      if ((await getAppSetting(LAST_LOGGED_RUN_KEY)) === agent.started_at) return;
      await upsertAppSetting(LAST_LOGGED_RUN_KEY, JSON.stringify(agent.started_at), 'string');
      await logActivity('self_update_finished', {
        state: agent.state,
        reason: agent.reason,
        from_version: agent.from_version,
        to_version: agent.to_version
      });
    } catch (error) {
      logger.warn('Self-update: could not record the updater result', { error: error.message });
    }
  }

  /**
   * Whether an update can be requested now, and why not when it cannot.
   * `detailed` is for callers who may request one; everyone else gets the
   * phase and state only, not who asked, the dump's name or raw errors.
   */
  async getStatus({ detailed = true } = {}) {
    const enabled = this.isEnabled();
    const agent = enabled ? await this.readAgentStatus() : null;

    let reason = null;
    if (!enabled) reason = 'disabled';
    else if (!agent) reason = 'no_agent';
    else if (agent.contract !== CONTRACT_VERSION) reason = 'unsupported_contract';
    else if (!(await this.requestDirWritable())) reason = 'request_dir_not_writable';
    else {
      await this.expireStaleRequest();
      if (agent.state === 'running' || this.jobActive() || await this.pendingRequest()) reason = 'busy';
    }
    if (enabled) await this.recordAgentResult(agent);

    const status = {
      enabled,
      available: reason === null,
      reason,
      contract: CONTRACT_VERSION,
      agent,
      job: this.job ? { ...this.job } : null
    };
    if (detailed) return status;
    return {
      ...status,
      agent: agent && { contract: agent.contract, state: agent.state, step: agent.step },
      job: this.job && { phase: this.job.phase }
    };
  }

  /**
   * Starts the backup-then-request job and returns it immediately; the caller
   * polls getStatus(). Throws SelfUpdateError when an update cannot start.
   */
  async requestUpdate({ admin }) {
    // Claimed before the first await: two confirmed requests arriving together
    // must not both pass the busy check below.
    if (this.jobActive()) throw new SelfUpdateError('busy', REASON_MESSAGES.busy, 409);
    this.starting = true;
    let job;
    try {
      const status = await this.getStatus();
      if (status.reason && status.reason !== 'busy') {
        throw new SelfUpdateError(status.reason, REASON_MESSAGES[status.reason], status.reason === 'disabled' ? 403 : 409);
      }
      // getStatus counts this call's own claim as busy; anything else that
      // makes it busy is real.
      if (status.agent?.state === 'running' || await this.pendingRequest()) {
        throw new SelfUpdateError('busy', REASON_MESSAGES.busy, 409);
      }
      job = {
        id: crypto.randomUUID(),
        phase: 'backing_up',
        started_at: new Date().toISOString(),
        requested_by: admin.username,
        backup: null,
        error: null
      };
      this.job = job;
    } finally {
      this.starting = false;
    }

    // Not awaited: a dump of a large database outlives any reverse proxy's
    // request timeout. The UI polls the status instead.
    this._run(job, admin).catch((error) => {
      logger.error('Self-update job failed unexpectedly', { error: error.message });
    });
    return { ...job };
  }

  async _run(job, admin) {
    const actor = { type: 'admin', id: admin.id, name: admin.username };
    // Required before the update, not best-effort: without it there is
    // nothing to restore if the new version's migrations go wrong.
    const { databaseBackupService } = require('./databaseBackup');
    try {
      const result = await databaseBackupService.backup({});
      job.backup = {
        file: path.basename(result.path),
        size: result.size
      };
    } catch (error) {
      job.phase = 'backup_failed';
      job.error = error.message;
      logger.error('Self-update: the database backup failed, no update was requested', { error: error.message });
      await logActivity('self_update_backup_failed', { job_id: job.id, error: error.message }, null, actor);
      return;
    }

    try {
      await this.writeRequestFile();
    } catch (error) {
      job.phase = 'request_failed';
      job.error = error.message;
      logger.error('Self-update: could not write the update request', { error: error.message });
      await logActivity('self_update_request_failed', { job_id: job.id, error: error.message }, null, actor);
      return;
    }

    job.phase = 'requested';
    job.requested_at = new Date().toISOString();
    logger.info('Self-update requested', { by: job.requested_by, backup: job.backup.file });
    await logActivity('self_update_requested', {
      job_id: job.id,
      backup_file: job.backup.file,
      from_version: await getCurrentVersion()
    }, null, actor);

    clearTimeout(this.expiryTimer);
    this.expiryTimer = setTimeout(() => {
      this.expireStaleRequest().catch((error) => {
        logger.error('Self-update: expiring the request failed', { error: error.message });
      });
    }, this.requestTtlMs + 1000);
    this.expiryTimer.unref?.();
  }

  /**
   * Cancels a request the updater has not taken yet. Throws SelfUpdateError
   * when there is nothing left to cancel (never filed, or already taken).
   */
  async withdrawRequest({ admin }) {
    if (!(await this.removeRequest())) {
      throw new SelfUpdateError('nothing_to_withdraw', 'There is no waiting update request to cancel.', 409);
    }
    clearTimeout(this.expiryTimer);
    const job = this.job && this.job.phase === 'requested' ? this.job : null;
    if (job) job.phase = 'withdrawn';
    await logActivity('self_update_withdrawn', { job_id: job?.id || null }, null,
      { type: 'admin', id: admin.id, name: admin.username });
  }

  /**
   * Temp file plus rename, so the updater never sees a half-written marker
   * (it only checks existence, but the rename is what makes that true even
   * on filesystems that expose a file before the write completes).
   */
  async writeRequestFile() {
    const dir = path.dirname(this.requestFile);
    const tmp = path.join(dir, `.update-requested.${crypto.randomBytes(8).toString('hex')}.tmp`);
    await fs.promises.writeFile(tmp, `${new Date().toISOString()}\n`, { flag: 'wx', mode: 0o640 });
    try {
      await fs.promises.rename(tmp, this.requestFile);
    } catch (error) {
      await fs.promises.unlink(tmp).catch(() => {});
      throw error;
    }
  }

  // Tests only.
  _reset() {
    this.job = null;
    this.starting = false;
    this.lastLoggedRun = null;
    clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
  }
}

module.exports = new SelfUpdateService();
module.exports.SelfUpdateError = SelfUpdateError;
module.exports.CONTRACT_VERSION = CONTRACT_VERSION;
