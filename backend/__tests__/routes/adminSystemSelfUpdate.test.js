/**
 * In-app updates, backend half (docs/self-update.md, issue 1776).
 *
 * The backend only takes a database dump and then creates
 * update/request/update-requested; the updater does the rest. These cases pin
 * the gates in front of that file: PICPEAK_SELF_UPDATE=true, super_admin, the
 * password again, a limiter on wrong guesses, and "busy" while an update is in
 * flight. They also pin that no request is filed when the dump fails.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-selfupdate-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'selfupdate-test-secret';

const request = require('supertest');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const { bootCrmDb, buildRouteApp } = require('../integration/helpers/crmDb');

const PASSWORD = 'Passw0rd!-update';

describe('/admin/system/updates/self-update', () => {
  let db; let cleanup; let app; let updateDir;
  let selfUpdateService; let databaseBackupService;
  const tokens = {};

  const statusPath = () => path.join(updateDir, 'status', 'status.json');
  const requestPath = () => path.join(updateDir, 'request', 'update-requested');

  const writeAgentStatus = (fields) => fs.writeFileSync(statusPath(), JSON.stringify({
    contract: 1,
    updater_version: '1.0.0',
    packaging: 'host',
    state: 'idle',
    ...fields,
  }));

  const makeAdmin = async (username, roleName, extra = {}) => {
    const role = await db('roles').where({ name: roleName }).first();
    const inserted = await db('admin_users').insert({
      username,
      email: `${username}@example.com`,
      password_hash: await bcrypt.hash(PASSWORD, 4),
      role_id: role.id,
      is_active: 1,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      ...extra,
    }).returning('id');
    const id = inserted[0]?.id ?? inserted[0];
    return jwt.sign(
      { id, username, type: 'admin', role: roleName, loginTime: Date.now() },
      process.env.JWT_SECRET,
      { expiresIn: '1h', issuer: 'picpeak-auth' },
    );
  };

  const getStatus = (who = 'super') => request(app)
    .get('/admin/system/updates/self-update')
    .set('Authorization', `Bearer ${tokens[who]}`);

  const requestUpdate = (who = 'super', password = PASSWORD) => request(app)
    .post('/admin/system/updates/self-update')
    .set('Authorization', `Bearer ${tokens[who]}`)
    .send({ password });

  // Refusals count against the per-admin limiter, so each case that collects
  // some uses an admin of its own.
  let freshCount = 0;
  const freshSuper = async () => {
    freshCount += 1;
    const name = `update-super-fresh-${freshCount}`;
    tokens[name] = await makeAdmin(name, 'super_admin');
    return name;
  };

  const withdraw = (who = 'super') => request(app)
    .delete('/admin/system/updates/self-update')
    .set('Authorization', `Bearer ${tokens[who]}`);

  const activities = (type) => db('activity_logs').where({ activity_type: type });

  // The job runs after the 202; wait until it leaves `backing_up`.
  const settled = async () => {
    for (let i = 0; i < 100; i += 1) {
      if (!selfUpdateService.jobActive()) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('self-update job did not settle');
  };

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    selfUpdateService = require('../../src/services/selfUpdateService');
    ({ databaseBackupService } = require('../../src/services/databaseBackup'));

    tokens.super = await makeAdmin('update-super', 'super_admin');
    tokens.super2 = await makeAdmin('update-super-2', 'super_admin');
    tokens.admin = await makeAdmin('update-admin', 'admin');
    tokens.sso = await makeAdmin('update-sso', 'super_admin', { auth_provider: 'oidc' });
    // A role with no permissions at all: not even the update UI's.
    await db('roles').insert({ name: 'update-nobody', display_name: 'Nobody', is_system: 0 });
    tokens.nobody = await makeAdmin('update-nobody', 'update-nobody');

    app = buildRouteApp('/admin/system', require('../../src/routes/adminSystem'));
  }, 120000);

  afterAll(async () => { await cleanup(); });

  beforeEach(async () => {
    await db('activity_logs').del();
    updateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-update-dir-'));
    fs.mkdirSync(path.join(updateDir, 'request'));
    fs.mkdirSync(path.join(updateDir, 'status'));
    process.env.PICPEAK_UPDATE_DIR = updateDir;
    process.env.PICPEAK_SELF_UPDATE = 'true';
    selfUpdateService._reset();
    jest.spyOn(databaseBackupService, 'backup').mockResolvedValue({
      success: true, path: '/backup/database/picpeak-db-20261005.sql.gz', size: 1234,
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    delete process.env.PICPEAK_SELF_UPDATE;
    fs.rmSync(updateDir, { recursive: true, force: true });
  });

  describe('status', () => {
    it('is unavailable unless PICPEAK_SELF_UPDATE is exactly "true"', async () => {
      writeAgentStatus({});
      for (const value of [undefined, '1', 'TRUE', 'yes']) {
        if (value === undefined) delete process.env.PICPEAK_SELF_UPDATE;
        else process.env.PICPEAK_SELF_UPDATE = value;
        const res = await getStatus();
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ enabled: false, available: false, reason: 'disabled', agent: null });
      }
    });

    it('is unavailable without an updater status file', async () => {
      const res = await getStatus();
      expect(res.body).toMatchObject({ enabled: true, available: false, reason: 'no_agent' });
    });

    it('is available with an idle updater, and says who may request it', async () => {
      writeAgentStatus({});
      const res = await getStatus();
      expect(res.body).toMatchObject({ available: true, reason: null, can_request: true });
      expect(res.body.agent).toMatchObject({ contract: 1, state: 'idle', packaging: 'host', updater_version: '1.0.0' });

      const asAdmin = await getStatus('admin');
      expect(asAdmin.body).toMatchObject({ available: true, can_request: false });
    });

    it('refuses an updater that speaks another contract', async () => {
      writeAgentStatus({ contract: 2 });
      const res = await getStatus();
      expect(res.body).toMatchObject({ available: false, reason: 'unsupported_contract' });
    });

    it('passes only known fields and known states through', async () => {
      writeAgentStatus({ state: 'pwned', message: 'x'.repeat(5000), extra: '<script>' });
      const res = await getStatus();
      expect(res.body.agent.state).toBeNull();
      expect(res.body.agent.message).toHaveLength(2000);
      expect(res.body.agent).not.toHaveProperty('extra');
    });

    it('ignores a status file that is not JSON or is oversized', async () => {
      fs.writeFileSync(statusPath(), 'not json');
      expect((await getStatus()).body.reason).toBe('no_agent');
      fs.writeFileSync(statusPath(), JSON.stringify({ contract: 1, state: 'idle', pad: 'y'.repeat(70 * 1024) }));
      expect((await getStatus()).body.reason).toBe('no_agent');
    });

    it('needs authentication and the update UI permissions', async () => {
      writeAgentStatus({});
      expect((await request(app).get('/admin/system/updates/self-update')).status).toBe(401);
      expect((await getStatus('nobody')).status).toBe(403);
    });

    it('gives callers who cannot request only the phase and state', async () => {
      writeAgentStatus({ state: 'running', step: 'pull', message: 'secret detail', image: 'x' });
      selfUpdateService.job = {
        id: 'j', phase: 'requested', started_at: new Date().toISOString(), requested_by: 'update-super',
        backup: { file: 'picpeak-db.sql.gz', size: 1 }, error: null,
      };
      const res = await getStatus('admin');
      expect(res.body.can_request).toBe(false);
      expect(res.body.request_block).toBe('not_super_admin');
      expect(res.body.job).toEqual({ phase: 'requested' });
      expect(res.body.agent).toEqual({ contract: 1, state: 'running', step: 'pull' });
    });

    it('tells an SSO-only super admin why there is no form', async () => {
      writeAgentStatus({});
      const res = await getStatus('sso');
      expect(res.body).toMatchObject({ can_request: false, request_block: 'no_local_password' });
    });

    it('says so before any dump when the request directory is not writable', async () => {
      if (process.getuid && process.getuid() === 0) return; // root ignores the mode
      writeAgentStatus({});
      fs.chmodSync(path.join(updateDir, 'request'), 0o500);
      try {
        expect((await getStatus()).body).toMatchObject({ available: false, reason: 'request_dir_not_writable' });
        const name = await freshSuper();
        const res = await requestUpdate(name);
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('SELF_UPDATE_REQUEST_DIR_NOT_WRITABLE');
        expect(databaseBackupService.backup).not.toHaveBeenCalled();
      } finally {
        fs.chmodSync(path.join(updateDir, 'request'), 0o700);
      }
    });

    it('withdraws a request nothing picked up in time', async () => {
      writeAgentStatus({});
      fs.writeFileSync(requestPath(), '');
      const old = new Date(Date.now() - 11 * 60 * 1000);
      fs.utimesSync(requestPath(), old, old);
      const res = await getStatus();
      expect(res.body).toMatchObject({ available: true, reason: null });
      expect(fs.existsSync(requestPath())).toBe(false);
      expect(await activities('self_update_expired')).toHaveLength(1);
    });

    it('records the result of an updater run once', async () => {
      writeAgentStatus({ state: 'succeeded', started_at: '2026-10-06T08:00:00Z', from_version: '3.162.0', to_version: '3.163.0' });
      await getStatus();
      // The stored marker round-trips through getAppSetting as the plain
      // string, which is what the restart case below compares against.
      const { getAppSetting } = require('../../src/utils/appSettings');
      expect(await getAppSetting('self_update_last_logged_run')).toBe('2026-10-06T08:00:00Z');
      selfUpdateService._reset(); // as after a restart: only the stored marker remains
      await getStatus('admin');
      const rows = await activities('self_update_finished');
      expect(rows).toHaveLength(1);
      expect(JSON.parse(rows[0].metadata)).toMatchObject({ state: 'succeeded', from_version: '3.162.0', to_version: '3.163.0' });
    });

    it('is busy while the updater runs or a request is pending', async () => {
      writeAgentStatus({ state: 'running', step: 'pull' });
      expect((await getStatus()).body).toMatchObject({ available: false, reason: 'busy' });

      writeAgentStatus({ state: 'succeeded' });
      fs.writeFileSync(requestPath(), '');
      expect((await getStatus()).body).toMatchObject({ available: false, reason: 'busy' });
    });
  });

  describe('request', () => {
    it('takes the database dump, then files the request', async () => {
      writeAgentStatus({});
      const res = await requestUpdate();
      expect(res.status).toBe(202);
      expect(res.body.job).toMatchObject({ phase: 'backing_up', requested_by: 'update-super' });

      await settled();
      expect(databaseBackupService.backup).toHaveBeenCalledTimes(1);
      expect(fs.existsSync(requestPath())).toBe(true);
      // Only the marker: no temp file left beside it.
      expect(fs.readdirSync(path.dirname(requestPath()))).toEqual(['update-requested']);

      const status = await getStatus();
      expect(status.body.job).toMatchObject({
        phase: 'requested',
        backup: { file: 'picpeak-db-20261005.sql.gz', size: 1234 },
      });
      expect(status.body.reason).toBe('busy');

      const logged = await activities('self_update_requested');
      expect(logged).toHaveLength(1);
      expect(logged[0].actor_name).toBe('update-super');
      expect(JSON.parse(logged[0].metadata)).toMatchObject({ backup_file: 'picpeak-db-20261005.sql.gz' });
    });

    it('lets two confirmed requests start only one update', async () => {
      writeAgentStatus({});
      const other = await freshSuper();
      const [a, b] = await Promise.all([requestUpdate(), requestUpdate(other)]);
      expect([a.status, b.status].sort()).toEqual([202, 409]);
      await settled();
      expect(databaseBackupService.backup).toHaveBeenCalledTimes(1);
      expect((await getStatus()).body.job.phase).toBe('requested');
    });

    it('can be cancelled while it waits, and only then', async () => {
      writeAgentStatus({});
      expect((await requestUpdate()).status).toBe(202);
      await settled();

      expect((await withdraw('admin')).status).toBe(403);
      const res = await withdraw();
      expect(res.status).toBe(200);
      expect(fs.existsSync(requestPath())).toBe(false);
      expect((await getStatus()).body.job.phase).toBe('withdrawn');
      expect(await activities('self_update_withdrawn')).toHaveLength(1);

      const again = await withdraw();
      expect(again.status).toBe(409);
      expect(again.body.code).toBe('SELF_UPDATE_NOTHING_TO_WITHDRAW');
    });

    it('files nothing when the database dump fails', async () => {
      writeAgentStatus({});
      databaseBackupService.backup.mockRejectedValueOnce(new Error('disk full'));
      expect((await requestUpdate()).status).toBe(202);
      await settled();
      expect(fs.existsSync(requestPath())).toBe(false);
      const status = await getStatus();
      expect(status.body.job).toMatchObject({ phase: 'backup_failed', error: 'disk full' });
      // A failed attempt does not block the next one.
      expect(status.body.available).toBe(true);
      // Nothing was filed, so nothing is logged as requested.
      expect(await activities('self_update_requested')).toHaveLength(0);
      expect(await activities('self_update_backup_failed')).toHaveLength(1);
    });

    it('reports a request file it could not write', async () => {
      writeAgentStatus({});
      jest.spyOn(selfUpdateService, 'writeRequestFile').mockRejectedValueOnce(new Error('EROFS'));
      expect((await requestUpdate()).status).toBe(202);
      await settled();
      expect((await getStatus()).body.job.phase).toBe('request_failed');
      expect(await activities('self_update_request_failed')).toHaveLength(1);
    });

    it('is refused while disabled, before the password is even checked', async () => {
      writeAgentStatus({});
      delete process.env.PICPEAK_SELF_UPDATE;
      const res = await requestUpdate(await freshSuper(), 'wrong');
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('SELF_UPDATE_DISABLED');
      expect(databaseBackupService.backup).not.toHaveBeenCalled();
    });

    it('needs super_admin', async () => {
      writeAgentStatus({});
      const res = await requestUpdate('admin');
      expect(res.status).toBe(403);
      expect(databaseBackupService.backup).not.toHaveBeenCalled();
    });

    it('is refused while busy, without a second dump, and the refusal is logged', async () => {
      writeAgentStatus({ state: 'running' });
      const res = await requestUpdate(await freshSuper());
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('SELF_UPDATE_BUSY');
      expect(databaseBackupService.backup).not.toHaveBeenCalled();
      const refused = await activities('self_update_refused');
      expect(JSON.parse(refused[0].metadata)).toEqual({ code: 'busy' });
    });

    it('is refused for an SSO-only super admin', async () => {
      writeAgentStatus({});
      const res = await requestUpdate('sso');
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('SELF_UPDATE_NO_LOCAL_PASSWORD');
      expect(databaseBackupService.backup).not.toHaveBeenCalled();
    });

    it('is refused without an updater', async () => {
      const res = await requestUpdate(await freshSuper());
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('SELF_UPDATE_NO_AGENT');
    });

    it('needs the password, and limits wrong guesses per admin', async () => {
      writeAgentStatus({});
      expect((await requestUpdate('super2', '')).status).toBe(400);
      for (let i = 0; i < 4; i += 1) {
        const res = await requestUpdate('super2', 'wrong');
        // Not 401: the admin client treats that as an expired session.
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('SELF_UPDATE_BAD_PASSWORD');
      }
      const limited = await requestUpdate('super2', PASSWORD);
      expect(limited.status).toBe(429);
      expect(databaseBackupService.backup).not.toHaveBeenCalled();
      expect(fs.existsSync(requestPath())).toBe(false);
    });
  });
});
