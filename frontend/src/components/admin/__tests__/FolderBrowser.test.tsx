/**
 * Folder bar on the event's Photos tab (issue 1786).
 *
 * Pins:
 *  - breadcrumb + the current level's subfolders with recursive counts;
 *    clicking filters the grid by folder id, "Gallery root" by 'root'
 *  - editing controls only with folders.manage (can_manage)
 *  - deleting asks first, says photos and subfolders move to the parent,
 *    and returns the view to the parent
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FolderBrowser } from '../folders/FolderBrowser';
import { ConfirmDialogProvider } from '../../common';
import type { GalleryFolder } from '../../../services/folders.service';

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  const interpolate = (text: string, opts?: Record<string, unknown>) =>
    text.replace(/{{(\w+)}}/g, (_, k) => String(opts?.[k] ?? ''));
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, fallback?: unknown, opts?: Record<string, unknown>) =>
        (typeof fallback === 'string' ? interpolate(fallback, opts) : key),
      i18n: { language: 'en' },
    }),
  };
});

vi.mock('react-toastify', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const { remove } = vi.hoisted(() => ({ remove: vi.fn() }));
vi.mock('../../../services/folders.service', async () => {
  const actual = await vi.importActual<typeof import('../../../services/folders.service')>('../../../services/folders.service');
  return { ...actual, foldersService: { ...actual.foldersService, remove } };
});

const folder = (id: number, name: string, parent_id: number | null, photo_count: number): GalleryFolder => ({
  id, name, slug: name.toLowerCase(), parent_id, source_path: null, hero_photo_id: null, allow_downloads: true, photo_count,
});
const folders = [folder(1, 'Friday', null, 2), folder(2, 'Activity A', 1, 5), folder(3, 'Saturday', null, 4)];

const renderBar = (props: Partial<React.ComponentProps<typeof FolderBrowser>> = {}) => {
  const onChange = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ConfirmDialogProvider>
        <FolderBrowser
          eventId={7}
          folders={folders}
          canManage
          maxDepth={3}
          value={undefined}
          onChange={onChange}
          pendingPhotoCount={0}
          {...props}
        />
      </ConfirmDialogProvider>
    </QueryClientProvider>
  );
  return { onChange };
};

describe('FolderBrowser', () => {
  beforeEach(() => remove.mockReset());

  it('lists the top level with recursive counts and filters by folder', async () => {
    const { onChange } = renderBar();

    expect(screen.getByRole('button', { name: /Friday\s*7/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Saturday\s*4/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Friday/ }));
    expect(onChange).toHaveBeenCalledWith(1);
    await userEvent.click(screen.getByRole('button', { name: 'Gallery root' }));
    expect(onChange).toHaveBeenCalledWith('root');
  });

  it('shows the breadcrumb and the subfolders of the open folder', () => {
    renderBar({ value: 1 });

    const path = screen.getByRole('navigation', { name: 'Folder path' });
    expect(path).toHaveTextContent('Gallery root');
    expect(path).toHaveTextContent('Friday');
    expect(screen.getByRole('button', { name: /Activity A\s*5/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /New subfolder/ })).toBeInTheDocument();
    expect(screen.getByText(/Subfolders inherit this/)).toBeInTheDocument();
  });

  it('hides editing without folders.manage', () => {
    renderBar({ value: 1, canManage: false });

    expect(screen.queryByRole('button', { name: /New subfolder/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Delete folder/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('confirms a delete, explains where the content goes, and opens the parent', async () => {
    remove.mockResolvedValue({ moved_photos: 5, folders: [] });
    const { onChange } = renderBar({ value: 2 });

    await userEvent.click(screen.getByRole('button', { name: /Delete folder/ }));
    expect(await screen.findByText('Its photos (5) and subfolders (0) move to "Friday". No photo is deleted.')).toBeInTheDocument();
    const confirmButtons = screen.getAllByRole('button', { name: 'Delete folder' });
    await userEvent.click(confirmButtons[confirmButtons.length - 1]);

    await waitFor(() => expect(remove).toHaveBeenCalledWith(7, 2));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(1));
  });
});
