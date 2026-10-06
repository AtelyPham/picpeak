import { api } from '../config/api';

export interface ExternalEntry {
  name: string;
  type: 'dir' | 'file';
  size?: number;
  mtime?: string;
}

export interface ExternalMediaListResponse {
  path: string;
  entries: ExternalEntry[];
  canNavigateUp: boolean;
}

export interface ExternalMediaImportOptions {
  recursive?: boolean;
  map?: { individual?: string; collages?: string };
}

export interface ExternalMediaImportResult {
  imported: number;
  skipped: number;
  thumbnailsQueued: number;
}

export interface ExternalImportStatus {
  is_running: boolean;
  /** When the last import of the gallery's folder finished (ISO), or null. */
  finished_at: string | null;
  /** The last run's outcome; `failed` with an `error` code when it threw. */
  last_result: {
    imported?: number;
    skipped?: number;
    failed?: boolean;
    error?: 'folder_missing' | 'permission_denied' | 'import_failed';
  } | null;
}

export const externalMediaService = {
  async list(pathRel: string = ''): Promise<ExternalMediaListResponse> {
    const params = new URLSearchParams();
    if (pathRel) params.set('path', pathRel);
    const res = await api.get<ExternalMediaListResponse>(`/admin/external-media/list?${params.toString()}`);
    return res.data;
  },

  async importEvent(
    eventId: number,
    externalPath: string,
    options?: ExternalMediaImportOptions
  ): Promise<ExternalMediaImportResult> {
    const res = await api.post<ExternalMediaImportResult>(
      `/admin/external-media/events/${eventId}/import-external`,
      {
        external_path: externalPath,
        recursive: options?.recursive ?? true,
        map: options?.map
      }
    );
    return res.data;
  },

  /** Import, or rescan, the folder the gallery's Photo source points at. */
  async rescanEvent(eventId: number): Promise<ExternalMediaImportResult> {
    const res = await api.post<ExternalMediaImportResult>(
      `/admin/external-media/events/${eventId}/import-external`,
      { recursive: true }
    );
    return res.data;
  },

  async getImportStatus(eventId: number): Promise<ExternalImportStatus> {
    const res = await api.get<ExternalImportStatus>(`/admin/external-media/events/${eventId}/status`);
    return res.data;
  }
};
