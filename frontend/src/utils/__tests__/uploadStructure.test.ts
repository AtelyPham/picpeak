/**
 * Folder uploads (issues 1786 + 1562): regrouping picked files by the
 * server's resolve answer, and the counts of the structure preview.
 *
 * Pins:
 *  - one group per placement (folder, folder request, first look), files in
 *    hidden directories left out, loose files to the chosen loose folder
 *  - the filter category rides on every group
 *  - the preview counts recursively, marks the skipped outer folder, the
 *    first-look marker, folding past max depth, and where an upload-only
 *    role's missing folders wait
 */
import { describe, expect, it } from 'vitest';

import { buildUploadPreview, groupFilesByPlacement, hasDirectories, uniqueDirectories } from '../uploadStructure';
import type { PickedFile } from '../droppedFiles';
import type { ResolveResponse } from '../../services/folders.service';

const picked = (dir: string, name: string): PickedFile => ({ file: new File(['x'], name, { type: 'image/jpeg' }), dir });
const names = (files: File[]) => files.map((f) => f.name);

describe('uniqueDirectories / hasDirectories', () => {
  it('lists each directory once, loose files as ""', () => {
    const files = [picked('A/B', '1'), picked('', '2'), picked('A/B', '3'), picked('A', '4')];
    expect(uniqueDirectories(files)).toEqual(['', 'A', 'A/B']);
    expect(hasDirectories(files)).toBe(true);
    expect(hasDirectories([picked('', 'x')])).toBe(false);
  });
});

describe('groupFilesByPlacement', () => {
  const results: ResolveResponse['results'] = {
    '': { segments: [], first_look: false, folder_id: null, status: 'root' },
    'Export/Friday': { segments: ['Friday'], first_look: false, folder_id: 11, status: 'exists' },
    'Export/Friday/Activity A': { segments: ['Friday', 'Activity A'], first_look: false, folder_id: 12, status: 'created' },
    'Export/Saturday': { segments: ['Saturday'], first_look: false, folder_id: null, folder_request_id: 7, status: 'requested' },
    'Export/FirstLook': { segments: [], first_look: true, folder_id: null, status: 'root' },
    'Export/.hidden': { segments: null, first_look: false, folder_id: null, status: 'skipped' },
  };

  it('makes one group per placement and leaves hidden directories out', () => {
    const files = [
      picked('Export/Friday', 'f1.jpg'),
      picked('Export/Friday/Activity A', 'a1.jpg'),
      picked('Export/Friday', 'f2.jpg'),
      picked('Export/Saturday', 's1.jpg'),
      picked('Export/FirstLook', 'fl1.jpg'),
      picked('Export/.hidden', 'h.jpg'),
      picked('', 'loose.jpg'),
    ];

    const { groups, skipped } = groupFilesByPlacement(files, results, { categoryId: 5, looseFolderId: 99 });

    expect(names(skipped)).toEqual(['h.jpg']);
    expect(groups.map((g) => [g.placement, names(g.files)])).toEqual([
      [{ categoryId: 5, folderId: 11, folderRequestId: null, firstLook: false }, ['f1.jpg', 'f2.jpg']],
      [{ categoryId: 5, folderId: 12, folderRequestId: null, firstLook: false }, ['a1.jpg']],
      [{ categoryId: 5, folderId: null, folderRequestId: 7, firstLook: false }, ['s1.jpg']],
      [{ categoryId: 5, folderId: null, folderRequestId: null, firstLook: true }, ['fl1.jpg']],
      [{ categoryId: 5, folderId: 99 }, ['loose.jpg']],
    ]);
  });

  it('treats a directory the answer does not cover as loose', () => {
    const { groups } = groupFilesByPlacement([picked('Unknown', 'u.jpg')], results, { categoryId: null, looseFolderId: null });

    expect(groups).toEqual([{ placement: { categoryId: null, folderId: null }, files: [expect.any(File)] }]);
  });
});

describe('buildUploadPreview', () => {
  // Mockup screen 3b: an upload-only role, Friday exists, the rest does not.
  const resolve: ResolveResponse = {
    can_manage: false,
    single_root: 'Export',
    max_depth: 3,
    results: {
      'Export': { segments: [], first_look: false, folder_id: null, status: 'root' },
      'Export/Sommerlager (FirstLook)': { segments: [], first_look: true, folder_id: null, status: 'root' },
      'Export/Friday/Activity A': { segments: ['Friday', 'Activity A'], first_look: false, folder_id: 12, status: 'exists' },
      'Export/Friday/Activity B': { segments: ['Friday', 'Activity B'], first_look: false, folder_id: 11, status: 'needs_admin' },
      'Export/Saturday/Activity B/Part 1/raw': {
        segments: ['Saturday', 'Activity B', 'Part 1'], first_look: false, folder_id: null, status: 'needs_admin',
      },
      'Export/.thumbs': { segments: null, first_look: false, folder_id: null, status: 'skipped' },
    },
    nodes: {
      Friday: 'exists',
      'Friday/Activity A': 'exists',
      'Friday/Activity B': 'needs_admin',
      Saturday: 'needs_admin',
      'Saturday/Activity B': 'needs_admin',
      'Saturday/Activity B/Part 1': 'needs_admin',
    },
  };
  const files = [
    picked('Export', 'loose.jpg'),
    picked('Export/Sommerlager (FirstLook)', 'fl1.jpg'),
    picked('Export/Sommerlager (FirstLook)', 'fl2.jpg'),
    picked('Export/Friday/Activity A', 'a.jpg'),
    picked('Export/Friday/Activity B', 'b1.jpg'),
    picked('Export/Friday/Activity B', 'b2.jpg'),
    picked('Export/Saturday/Activity B/Part 1/raw', 'p.jpg'),
    picked('Export/.thumbs', 't.jpg'),
  ];

  it('counts recursively and marks the first look, the skipped outer folder and folding', () => {
    const preview = buildUploadPreview(files, resolve, { skipOuter: true, keepStructure: true });

    expect(preview.skippedOuter).toBe('Export');
    expect(preview.firstLook).toEqual({ name: 'Sommerlager (FirstLook)', count: 2 });
    expect(preview.looseCount).toBe(1);
    expect(preview.hiddenCount).toBe(1);
    expect(preview.folded).toBe(true);
    expect(preview.tree.map((n) => [n.name, n.count])).toEqual([['Friday', 3], ['Saturday', 1]]);
    expect(preview.tree[0].children.map((n) => [n.name, n.count, n.status])).toEqual([
      ['Activity A', 1, 'exists'],
      ['Activity B', 2, 'needs_admin'],
    ]);
    expect(preview.folderCount).toBe(6);
  });

  it('says where the top of each missing chain waits, and how many folders need an admin', () => {
    const preview = buildUploadPreview(files, resolve, { skipOuter: true, keepStructure: true });
    const [friday, saturday] = preview.tree;

    expect(friday.waitsIn).toBeUndefined();
    expect(friday.children[1].waitsIn).toBe('Friday');
    expect(saturday.waitsIn).toBeNull();
    // Only the top of a missing chain names its fallback.
    expect(saturday.children[0].waitsIn).toBeUndefined();
    expect(preview.requestedFolders).toBe(4);
    expect(preview.waitingFiles).toBe(3);
    expect(preview.newFolders).toBe(0);
  });

  it('does not strike the outer folder when it is kept', () => {
    expect(buildUploadPreview(files, resolve, { skipOuter: false, keepStructure: true }).skippedOuter).toBeNull();
  });

  it('names the outer folder as the marker when it is the first-look folder itself', () => {
    const marker: ResolveResponse = {
      can_manage: true,
      single_root: 'Wedding_FirstLook',
      max_depth: 3,
      results: { Wedding_FirstLook: { segments: [], first_look: true, folder_id: null, status: 'root' } },
      nodes: {},
    };
    const preview = buildUploadPreview([picked('Wedding_FirstLook', 'x.jpg')], marker, { skipOuter: true, keepStructure: true });

    expect(preview.firstLook).toEqual({ name: 'Wedding_FirstLook', count: 1 });
    expect(preview.skippedOuter).toBeNull();
    expect(preview.tree).toEqual([]);
  });
});
