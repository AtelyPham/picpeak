/**
 * The Photos tab's line for a gallery on an external folder: which folder,
 * whether it is watched, when it was last scanned, and a one-click Rescan.
 * The folder itself is chosen in Settings → Photo source, never here.
 */
import React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'react-toastify';
import { FolderOpen, FolderTree, RefreshCw } from 'lucide-react';
import type { Event } from '../../../types';
import { Button, useConfirm } from '../../../components/common';
import { invalidateFolderViews } from '../../../components/admin/folders/folderQueries';
import { foldersService } from '../../../services/folders.service';
import { usePermission } from '../../../hooks/usePermission';
import { useLocalizedDate } from '../../../hooks/useLocalizedDate';
import { externalMediaService } from '../../../services/externalMedia.service';
import { toBoolean } from '../../../utils/parsers';

export const ExternalSourceBar: React.FC<{ event: Event; onChangeFolder: () => void }> = ({ event, onChangeFolder }) => {
  const { t } = useTranslation();
  const { formatDistanceToNow } = useLocalizedDate();
  const queryClient = useQueryClient();
  const canImport = usePermission('photos.upload');
  const canChangeFolder = usePermission('events.edit') && !event.is_archived;
  const watched = toBoolean(event.external_watch, false);
  const confirm = useConfirm();
  // Folder structure switched on after the first import (issue 1786): the
  // photos already imported are still flat until this mirrors the folder.
  const canApplyStructure = usePermission('folders.manage') && canImport
    && toBoolean(event.folder_structure, false) && !event.is_archived;

  const { data: status } = useQuery({
    queryKey: ['external-import-status', event.id],
    queryFn: () => externalMediaService.getImportStatus(event.id),
    // While an import runs (a rescan, the watcher, or the first import right
    // after creating the gallery) keep the line and the grid moving.
    refetchInterval: (query) => (query.state.data?.is_running ? 3000 : false),
  });

  const refreshPhotos = () => {
    queryClient.invalidateQueries({ queryKey: ['admin-event', String(event.id)] });
    queryClient.invalidateQueries({ queryKey: ['admin-event-photos', String(event.id)] });
    queryClient.invalidateQueries({ queryKey: ['admin-event-filter-summary', String(event.id)] });
    queryClient.invalidateQueries({ queryKey: ['admin-photo-credits', event.id] });
  };

  // When a running import finishes, show what it brought in.
  const wasRunning = React.useRef(false);
  React.useEffect(() => {
    if (status?.is_running) wasRunning.current = true;
    else if (wasRunning.current) {
      wasRunning.current = false;
      refreshPhotos();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status?.is_running]);

  const rescan = useMutation({
    mutationFn: () => externalMediaService.rescanEvent(event.id),
    onSuccess: (result) => {
      toast.success(t('events.externalSource.rescanDone', 'Rescan done: {{count}} new photos', { count: result?.imported ?? 0 }));
      refreshPhotos();
      queryClient.invalidateQueries({ queryKey: ['external-import-status', event.id] });
    },
    onError: (error: unknown) => {
      const e = error as { response?: { status?: number; data?: { error?: string } } };
      toast.error(e.response?.status === 409
        ? t('events.externalSource.alreadyRunning', 'An import of this folder is already running.')
        : e.response?.data?.error || t('events.externalSource.rescanFailed', 'Rescan failed'));
      queryClient.invalidateQueries({ queryKey: ['external-import-status', event.id] });
    },
  });

  const applyStructure = useMutation({
    mutationFn: () => foldersService.applyExternalStructure(event.id),
    onSuccess: (result) => {
      toast.success(result.moved > 0
        ? t('events.externalSource.structureApplied', '{{count}} photos moved into folders', { count: result.moved })
        : t('events.externalSource.structureNothing', 'Every photo from a subfolder is in a folder already'));
      invalidateFolderViews(queryClient, event.id);
    },
    onError: (error: unknown) => {
      const e = error as { response?: { data?: { error?: string } } };
      toast.error(e.response?.data?.error || t('events.externalSource.structureFailed', 'The folder structure could not be applied'));
    },
  });

  const handleApplyStructure = async () => {
    const ok = await confirm({
      title: t('events.externalSource.applyStructureTitle', 'Apply the folder structure?'),
      message: t(
        'events.externalSource.applyStructureMessage',
        "Photos that are not in a gallery folder yet move into folders that mirror the external folder's subfolders. Photos already in a folder stay where they are."
      ),
      confirmLabel: t('events.externalSource.applyStructure', 'Apply folder structure'),
    });
    if (ok) applyStructure.mutate();
  };

  const running = rescan.isPending || status?.is_running === true;
  // A failed run is recorded as its outcome; without this it would read as a
  // finished scan of an empty folder.
  const failed = !running && status?.last_result?.failed === true;
  // The server stores a code, never the fs message (that quotes host paths).
  const failureText = (() => {
    switch (status?.last_result?.error) {
      case 'folder_missing':
        return t('events.externalSource.failedMissing', 'The last import failed: the folder can no longer be found.');
      case 'permission_denied':
        return t('events.externalSource.failedPermission', 'The last import failed: PicPeak is not allowed to read the folder.');
      default:
        return t('events.externalSource.failedGeneric', 'The last import failed.');
    }
  })();
  const lastScan = status?.finished_at
    ? t('events.externalSource.lastScan', 'Last scan {{when}}', { when: formatDistanceToNow(new Date(status.finished_at), { addSuffix: true }) })
    : t('events.externalSource.neverScanned', 'Not scanned yet');

  return (
    <div className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-line bg-panel px-4 py-3">
      <FolderOpen className="w-5 h-5 text-accent shrink-0" />
      <span className="text-sm text-heading min-w-0">
        {t('events.externalSource.source', 'Source')}{' '}
        <code className="px-1.5 py-0.5 rounded bg-inset text-xs break-all">/external-media/{event.external_path}</code>
      </span>
      {watched && (
        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-300">
          {t('events.externalSource.watching', 'Watching for new files')}
        </span>
      )}
      {failed ? (
        <span className="text-xs text-red-700 dark:text-red-400" role="alert">
          {failureText}
        </span>
      ) : (
        <span className="text-xs text-soft" role="status">
          {running ? t('events.externalSource.importing', 'Importing…') : lastScan}
        </span>
      )}
      <div className="ml-auto flex flex-wrap items-center gap-2">
        {canImport && (
          <Button
            variant="outline"
            size="sm"
            leftIcon={<RefreshCw className={`w-4 h-4 ${running ? 'animate-spin' : ''}`} />}
            onClick={() => rescan.mutate()}
            disabled={running || !!event.is_archived}
          >
            {failed
              ? t('events.externalSource.retry', 'Try again')
              : status?.finished_at ? t('events.externalSource.rescan', 'Rescan') : t('events.externalSource.importNow', 'Import now')}
          </Button>
        )}
        {canApplyStructure && (
          <Button
            variant="outline"
            size="sm"
            leftIcon={<FolderTree className="w-4 h-4" />}
            onClick={handleApplyStructure}
            disabled={running || applyStructure.isPending}
            isLoading={applyStructure.isPending}
            title={t('events.externalSource.applyStructureHint', 'Mirror the subfolders onto photos imported before folder structure was on')}
          >
            {t('events.externalSource.applyStructure', 'Apply folder structure')}
          </Button>
        )}
        {canChangeFolder && (
          <Button variant="ghost" size="sm" onClick={onChangeFolder}>
            {t('events.externalSource.changeFolder', 'Change folder')}
          </Button>
        )}
      </div>
    </div>
  );
};
