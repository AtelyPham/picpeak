import type { QueryClient } from '@tanstack/react-query';
import { folderQueryKey } from '../../../services/folders.service';

/**
 * Everything a folder change can move (issue 1786): the folder tree and its
 * requests, the photo grid (photos change folder), the event's counters and
 * the category lists (folders are photo_categories rows, cached by
 * EventDetailsPage and by EventCategoryManager under different keys).
 */
export function invalidateFolderViews(queryClient: QueryClient, eventId: number): void {
  queryClient.invalidateQueries({ queryKey: folderQueryKey(eventId) });
  queryClient.invalidateQueries({ queryKey: ['admin-event-photos', String(eventId)] });
  queryClient.invalidateQueries({ queryKey: ['admin-event', String(eventId)] });
  queryClient.invalidateQueries({ queryKey: ['admin-event-categories', String(eventId)] });
  queryClient.invalidateQueries({ queryKey: ['event-categories', eventId] });
}

/** The server's reason for a refused folder change, when it gave one. */
export function folderErrorMessage(error: unknown): string | undefined {
  const e = error as { response?: { data?: { error?: string } } };
  return e?.response?.data?.error;
}
