/**
 * In-app updates (docs/self-update.md). The backend takes a database dump and
 * files a request; the updater on the host does the update and reports through
 * a status file the backend relays here.
 */
import { api } from '../config/api';

/** What the updater wrote last (updater/picpeak-updater.sh, write_status). */
export interface SelfUpdateAgentStatus {
  contract: number | null;
  updater_version: string | null;
  packaging: 'host' | 'container' | string | null;
  state: 'idle' | 'running' | 'succeeded' | 'up_to_date' | 'refused' | 'failed' | 'rolled_back' | null;
  reason: string | null;
  step: string | null;
  message: string | null;
  from_version: string | null;
  to_version: string | null;
  image: string | null;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string | null;
}

/** The backend's part, before the updater takes over. Lost on restart by design. */
/** Only `phase` reaches callers who cannot request an update themselves. */
export interface SelfUpdateJob {
  id: string;
  phase: 'backing_up' | 'backup_failed' | 'request_failed' | 'requested' | 'withdrawn' | 'expired';
  started_at: string;
  requested_at?: string;
  requested_by: string;
  backup: { file: string; size: number } | null;
  error: string | null;
}

export interface SelfUpdateStatus {
  enabled: boolean;
  available: boolean;
  reason: 'disabled' | 'no_agent' | 'unsupported_contract' | 'request_dir_not_writable' | 'busy' | null;
  contract: number;
  agent: SelfUpdateAgentStatus | null;
  job: SelfUpdateJob | null;
  currentVersion: string;
  can_request: boolean;
  request_block: 'not_super_admin' | 'no_local_password' | null;
}

export const selfUpdateService = {
  async getStatus(): Promise<SelfUpdateStatus> {
    const { data } = await api.get<SelfUpdateStatus>('/admin/system/updates/self-update');
    return data;
  },

  async requestUpdate(password: string): Promise<SelfUpdateJob> {
    const { data } = await api.post<{ job: SelfUpdateJob }>('/admin/system/updates/self-update', { password });
    return data.job;
  },

  /** Cancels a request the updater has not taken yet. */
  async withdrawRequest(): Promise<void> {
    await api.delete('/admin/system/updates/self-update');
  },
};
