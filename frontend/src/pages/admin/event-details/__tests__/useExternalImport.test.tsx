/**
 * The import status request needs photos.view (the permission its route
 * checks), and a caller that will not show it can switch it off. Without
 * either, a role that may not see it got a 403 on every render.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { useExternalImport } from '../useExternalImport';
import type { Event } from '../../../../types';

const perms = vi.hoisted(() => ({ granted: new Set<string>() }));
const getImportStatus = vi.hoisted(() => vi.fn());

vi.mock('../../../../hooks/usePermission', () => ({ usePermission: (p: string) => perms.granted.has(p) }));
vi.mock('../../../../hooks/useLocalizedDate', () => ({ useLocalizedDate: () => ({ formatDistanceToNow: () => 'just now' }) }));
vi.mock('../../../../services/externalMedia.service', () => ({
  externalMediaService: { getImportStatus, rescanEvent: vi.fn() },
}));
vi.mock('react-toastify', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_k: string, fallback?: unknown) => (typeof fallback === 'string' ? fallback : _k), i18n: { language: 'en' } }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

const event = { id: 5, source_mode: 'reference', external_path: 'shoot' } as unknown as Event;

function run(options?: { enabled?: boolean }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return renderHook(() => useExternalImport(event, options), { wrapper });
}

describe('useExternalImport — status request', () => {
  beforeEach(() => {
    getImportStatus.mockReset();
    getImportStatus.mockResolvedValue({ is_running: false, finished_at: null });
  });

  it('asks for the status with photos.view', async () => {
    perms.granted = new Set(['photos.view', 'photos.upload']);
    const { result } = run();
    await waitFor(() => expect(getImportStatus).toHaveBeenCalledWith(5));
    expect(result.current.canImport).toBe(true);
  });

  it('does not ask without photos.view', async () => {
    perms.granted = new Set(['photos.upload']);
    run();
    await new Promise((r) => setTimeout(r, 30));
    expect(getImportStatus).not.toHaveBeenCalled();
  });

  it('does not ask when the caller switches it off', async () => {
    perms.granted = new Set(['photos.view', 'photos.upload']);
    run({ enabled: false });
    await new Promise((r) => setTimeout(r, 30));
    expect(getImportStatus).not.toHaveBeenCalled();
  });
});
