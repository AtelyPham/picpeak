/**
 * Admin folder tree helpers (issue 1786): breadcrumb chain, recursive
 * counts, inherited download blocks, and where a folder may be moved
 * without a cycle or going past the depth limit.
 */
import { describe, expect, it } from 'vitest';

import {
  childFolders,
  downloadsBlockedBy,
  folderAncestry,
  folderPathLabel,
  moveTargetsFor,
  recursivePhotoCount,
  subtreeHeight,
} from '../folderTree';

const folders = [
  { id: 1, name: 'Friday', parent_id: null, photo_count: 2, allow_downloads: false },
  { id: 2, name: 'Activity A', parent_id: 1, photo_count: 5, allow_downloads: true },
  { id: 3, name: 'Part 1', parent_id: 2, photo_count: 1, allow_downloads: true },
  { id: 4, name: 'Saturday', parent_id: null, photo_count: 3, allow_downloads: true },
];

describe('folderTree', () => {
  it('walks children, ancestry and path labels', () => {
    expect(childFolders(folders, null).map((f) => f.id)).toEqual([1, 4]);
    expect(folderAncestry(folders, 3).map((f) => f.id)).toEqual([1, 2, 3]);
    expect(folderPathLabel(folders, 3)).toBe('Friday › Activity A › Part 1');
    expect(folderAncestry(folders, null)).toEqual([]);
  });

  it('counts photos through the subtree', () => {
    expect(recursivePhotoCount(folders, 1)).toBe(8);
    expect(recursivePhotoCount(folders, 4)).toBe(3);
    expect(subtreeHeight(folders, 1)).toBe(2);
  });

  it('finds the ancestor that blocks downloads', () => {
    expect(downloadsBlockedBy(folders, 3)?.id).toBe(1);
    expect(downloadsBlockedBy(folders, 1)).toBeNull();
    expect(downloadsBlockedBy(folders, 4)).toBeNull();
  });

  it('never offers a folder its own subtree, nor a target that breaks the depth limit', () => {
    // Activity A carries one level below it: under a top-level folder it
    // reaches depth 3, never under itself or its own Part 1.
    expect([...moveTargetsFor(folders, 2, 3)]).toEqual([1, 4]);
    expect([...moveTargetsFor(folders, 2, 2)]).toEqual([]);
    // Friday is three levels tall: only the top level fits, no folder does.
    expect([...moveTargetsFor(folders, 1, 3)]).toEqual([]);
  });

  it('survives a cyclic parent chain', () => {
    const cyclic = [
      { id: 1, name: 'a', parent_id: 2 },
      { id: 2, name: 'b', parent_id: 1 },
    ];
    expect(folderAncestry(cyclic, 1).length).toBe(2);
  });
});
