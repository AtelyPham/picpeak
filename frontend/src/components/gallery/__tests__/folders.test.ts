/**
 * Gallery folders (#1160) — the containment rule.
 *
 * The whole point of the feature: a foldered photo is ABSENT from the root grid
 * and only appears inside its folder. A filter category keeps today's behaviour.
 *
 * The suites below the "nested folders" heading cover issue 1786, where a
 * photo's folder lives in `folder_id`. The older suites use the issue 1160
 * payload (a folder as `category_id`, no `folder_id` field at all), which the
 * helpers still read as a fallback for an older backend.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  childFolders,
  filterCategories,
  folderAncestors,
  folderSubtreeIds,
  folderTree,
  photoFolderId,
  photosInSubtree,
  photosInView,
  readViewParam,
  writeViewParam,
  peopleInScope,
  SELECTED_DOWNLOAD_LIMIT,
  findFolderByKey,
  folderKey,
  folderCategoryIds,
  folderTiles,
  photosInScope,
  readFolderParam,
  writeFolderParam,
} from '../folders';
import type { Photo, PhotoCategory } from '../../../types';

const cat = (over: Partial<PhotoCategory> & { id: number; slug: string }): PhotoCategory => ({
  name: over.slug,
  is_global: false,
  ...over,
});

const photo = (id: number, category_id?: number | null): Photo =>
  ({ id, filename: `${id}.jpg`, category_id: category_id ?? null } as unknown as Photo);

const CATEGORIES: PhotoCategory[] = [
  cat({ id: 1, slug: 'ceremony' }),
  cat({ id: 2, slug: 'selects', is_folder: true }),
  cat({ id: 3, slug: 'bw', is_folder: true }),
];

// 2 finals (one categorised, one loose), 3 in a folder, 1 in another folder.
const PHOTOS: Photo[] = [
  photo(10, 1),
  photo(11, null),
  photo(20, 2),
  photo(21, 2),
  photo(22, 2),
  photo(30, 3),
];

describe('photosInScope', () => {
  it('drops every foldered photo from the root grid', () => {
    const ids = photosInScope(PHOTOS, CATEGORIES, null).map((p) => p.id);
    expect(ids).toEqual([10, 11]);
  });

  it('keeps uncategorised photos at root', () => {
    expect(photosInScope(PHOTOS, CATEGORIES, null).map((p) => p.id)).toContain(11);
  });

  it('shows only that folder’s photos inside a folder', () => {
    expect(photosInScope(PHOTOS, CATEGORIES, 2).map((p) => p.id)).toEqual([20, 21, 22]);
    expect(photosInScope(PHOTOS, CATEGORIES, 3).map((p) => p.id)).toEqual([30]);
  });

  it('leaves a gallery without folders completely unchanged', () => {
    const filtersOnly = [cat({ id: 1, slug: 'ceremony' })];
    expect(photosInScope(PHOTOS, filtersOnly, null)).toHaveLength(PHOTOS.length);
  });

  // Callers sort the result in place. Returning `photos` itself on the
  // no-folders fast path sorted the React Query cache for every other consumer.
  it('never hands back the caller’s own array', () => {
    const filtersOnly = [cat({ id: 1, slug: 'ceremony' })];
    const out = photosInScope(PHOTOS, filtersOnly, null);
    expect(out).not.toBe(PHOTOS);
    out.sort((a, b) => b.id - a.id);
    expect(PHOTOS.map((p) => p.id)).toEqual([10, 11, 20, 21, 22, 30]);
  });

  it('treats a category as a filter until is_folder is set', () => {
    const asFilter = [cat({ id: 2, slug: 'selects' })];
    expect(photosInScope(PHOTOS, asFilter, null)).toHaveLength(PHOTOS.length);
  });
});

describe('folderTiles', () => {
  it('builds one tile per non-empty folder with its count, sorted by name', () => {
    const tiles = folderTiles(CATEGORIES, PHOTOS);
    expect(tiles.map((t) => [t.category.slug, t.count])).toEqual([
      ['bw', 1],
      ['selects', 3],
    ]);
  });

  it('hides empty folders — a guest must not hit a dead end', () => {
    const tiles = folderTiles([...CATEGORIES, cat({ id: 4, slug: 'empty', is_folder: true })], PHOTOS);
    expect(tiles.map((t) => t.category.slug)).not.toContain('empty');
  });

  it('prefers the category hero as the cover, else the first photo', () => {
    const withHero = [cat({ id: 2, slug: 'selects', is_folder: true, hero_photo_id: 22 })];
    expect(folderTiles(withHero, PHOTOS)[0].coverPhoto?.id).toBe(22);
    expect(folderTiles([CATEGORIES[1]], PHOTOS)[0].coverPhoto?.id).toBe(20);
  });

  it('falls back to the first photo when the hero left the folder', () => {
    const staleHero = [cat({ id: 2, slug: 'selects', is_folder: true, hero_photo_id: 999 })];
    expect(folderTiles(staleHero, PHOTOS)[0].coverPhoto?.id).toBe(20);
  });
});

describe('findFolderByKey / folderKey', () => {
  it('resolves an open folder', () => {
    expect(findFolderByKey(CATEGORIES, 'selects-2')?.id).toBe(2);
  });

  it('falls back to root for an unknown key rather than emptying the gallery', () => {
    expect(findFolderByKey(CATEGORIES, 'nope')).toBeNull();
  });

  it('refuses to open a filter category as a folder', () => {
    expect(findFolderByKey(CATEGORIES, 'ceremony')).toBeNull();
  });

  // Regression: adminCategories slugs with `[^\w\s-]` stripping, and `\w` is
  // ASCII-only — "Избранное" slugs to "". Keying on the slug made such a
  // folder's photos unreachable: gone from the root grid, and the empty param
  // neither wrote nor resolved.
  it('keys a folder by id when its name slugs to nothing', () => {
    const cyrillic = cat({ id: 7, slug: '', name: 'Избранное', is_folder: true });
    expect(folderKey(cyrillic)).toBe('7');
    expect(findFolderByKey([cyrillic], '7')?.id).toBe(7);
  });

  // A rename rewrites the slug, so a link already shared with a client must not
  // silently dump them at the gallery root.
  it('still resolves a link shared before the folder was renamed', () => {
    const renamed = cat({ id: 2, slug: 'final-selects', is_folder: true });
    expect(findFolderByKey([renamed], 'selects-2')?.id).toBe(2);
  });

  it('keeps the slug in the key so links stay readable', () => {
    expect(folderKey(CATEGORIES[1])).toBe('selects-2');
  });

  // Regression: UNIQUE is (slug, event_id), so a global folder and an
  // event-specific folder can share a slug. Keying on the slug alone made the
  // second one unopenable — every lookup matched the first.
  it('distinguishes two folders that share a slug across scopes', () => {
    const globalSelects = cat({ id: 20, slug: 'selects', is_global: true, is_folder: true });
    const eventSelects = cat({ id: 21, slug: 'selects', is_folder: true });
    const both = [globalSelects, eventSelects];
    expect(folderKey(globalSelects)).not.toBe(folderKey(eventSelects));
    expect(findFolderByKey(both, folderKey(eventSelects))?.id).toBe(21);
    expect(findFolderByKey(both, folderKey(globalSelects))?.id).toBe(20);
  });
});

describe('filterCategories / folderCategoryIds', () => {
  it('offers only filter categories to the filter UI', () => {
    expect(filterCategories(CATEGORIES).map((c) => c.slug)).toEqual(['ceremony']);
  });

  it('collects folder ids', () => {
    expect([...folderCategoryIds(CATEGORIES)]).toEqual([2, 3]);
  });
});

describe('peopleInScope', () => {
  // photo 10 -> Anna; 11 -> Anna+Ben; folder photos 20,21 -> Chris; 30 -> Ben
  const withPeople: Photo[] = [
    { ...photo(10, 1), person_ids: [1] },
    { ...photo(11, null), person_ids: [1, 2] },
    { ...photo(20, 2), person_ids: [3] },
    { ...photo(21, 2), person_ids: [3] },
    { ...photo(22, 2), person_ids: [] },
    { ...photo(30, 3), person_ids: [2] },
  ] as unknown as Photo[];

  const PEOPLE = [
    { id: 1, face_count: 99 },
    { id: 2, face_count: 99 },
    { id: 3, face_count: 99 },
  ];

  it('recounts against the photos actually on screen', () => {
    const atRoot = peopleInScope(PEOPLE, photosInScope(withPeople, CATEGORIES, null));
    expect(atRoot).toEqual([
      { id: 1, face_count: 2 },
      { id: 2, face_count: 1 },
    ]);
  });

  it('drops a person whose photos all live in a folder — no dead chip at root', () => {
    const atRoot = peopleInScope(PEOPLE, photosInScope(withPeople, CATEGORIES, null));
    expect(atRoot.map((p) => p.id)).not.toContain(3);
  });

  it('counts only the folder’s photos while inside it', () => {
    const inFolder = peopleInScope(PEOPLE, photosInScope(withPeople, CATEGORIES, 2));
    expect(inFolder).toEqual([{ id: 3, face_count: 2 }]);
  });

  // PeopleStrip only shows the first 12 inline, so keeping /people's event-wide
  // ordering after rescoping could push a folder's most-photographed person
  // behind "Show all".
  it('re-sorts by the recomputed scoped count', () => {
    const people = [
      { id: 3, face_count: 99 }, // 2 in the folder
      { id: 1, face_count: 99 }, // 0 in the folder
      { id: 2, face_count: 99 }, // 0 in the folder
    ];
    const inFolder = peopleInScope(people, photosInScope(withPeople, CATEGORIES, 2));
    expect(inFolder.map((p) => p.id)).toEqual([3]);

    const atRoot = peopleInScope(people, photosInScope(withPeople, CATEGORIES, null));
    expect(atRoot.map((p) => [p.id, p.face_count])).toEqual([[1, 2], [2, 1]]);
  });

  it('is a no-op for a gallery without folders', () => {
    const noFolders = [cat({ id: 1, slug: 'ceremony' })];
    const scoped = peopleInScope(PEOPLE, photosInScope(withPeople, noFolders, null));
    expect(scoped.map((p) => [p.id, p.face_count]).sort()).toEqual([[1, 2], [2, 2], [3, 2]]);
  });
});

describe('SELECTED_DOWNLOAD_LIMIT', () => {
  // Mirrors the server-side `.slice(0, 500)` in gallery.js's /download-selected
  // and /download-jobs. If the backend cap moves and this doesn't, the folder
  // button silently promises more than the archive will contain.
  it('matches the cap the backend enforces', () => {
    expect(SELECTED_DOWNLOAD_LIMIT).toBe(500);
  });
});

describe('URL round-trip', () => {
  const original = window.location.href;

  beforeEach(() => window.history.replaceState({}, '', '/gallery/wed?token=abc&admin_preview=1'));
  afterEach(() => window.history.replaceState({}, '', original));

  it('reflects the open folder without dropping token or admin_preview', () => {
    writeFolderParam('selects');
    const params = new URLSearchParams(window.location.search);
    expect(params.get('folder')).toBe('selects');
    expect(params.get('token')).toBe('abc');
    expect(params.get('admin_preview')).toBe('1');
    expect(readFolderParam()).toBe('selects');
  });

  it('clears the param on the way back to root', () => {
    writeFolderParam('selects');
    writeFolderParam(null);
    expect(readFolderParam()).toBeNull();
    expect(new URLSearchParams(window.location.search).get('token')).toBe('abc');
  });
});

// ---------------------------------------------------------------------------
// Nested folders (issue 1786)
// ---------------------------------------------------------------------------

const folder = (id: number, name: string, parent_id: number | null = null, over: Partial<PhotoCategory> = {}): PhotoCategory =>
  ({ id, name, slug: name.toLowerCase().replace(/\s+/g, '-'), is_global: false, is_folder: true, parent_id, ...over });

const inFolder = (id: number, folder_id: number | null, category_id: number | null = null): Photo =>
  ({ id, filename: `${id}.jpg`, folder_id, category_id } as unknown as Photo);

// Friday (10) › Activity A (11)
// Saturday (20) › Activity B (21) › Part 1 (22)
// Day 10 (30), Day 2 (31) — natural order check
// Portraits (1) is a filter category.
const TREE: PhotoCategory[] = [
  cat({ id: 1, slug: 'portraits' }),
  folder(20, 'Saturday'),
  folder(21, 'Activity B', 20),
  folder(22, 'Part 1', 21),
  folder(10, 'Friday'),
  folder(11, 'Activity A', 10),
  folder(30, 'Day 10'),
  folder(31, 'Day 2'),
];

const TREE_PHOTOS: Photo[] = [
  inFolder(100, null),
  inFolder(101, null, 1),
  inFolder(110, 10),
  inFolder(111, 11, 1),
  inFolder(112, 11),
  inFolder(200, 20),
  inFolder(210, 21),
  inFolder(220, 22, 1),
  inFolder(221, 22),
  inFolder(300, 30),
  inFolder(310, 31),
];

const ids = (photos: Photo[]) => photos.map((p) => p.id);

describe('nested folders: tree helpers', () => {
  it('lists the direct children of a level, sorted naturally by name', () => {
    expect(childFolders(TREE, null).map((f) => f.name)).toEqual(['Day 2', 'Day 10', 'Friday', 'Saturday']);
    expect(childFolders(TREE, 20).map((f) => f.name)).toEqual(['Activity B']);
    expect(childFolders(TREE, 22)).toEqual([]);
  });

  it('never lists a filter category as a folder', () => {
    expect(childFolders(TREE, null).map((f) => f.id)).not.toContain(1);
  });

  it('builds the breadcrumb trail from the top down', () => {
    expect(folderAncestors(TREE, 22).map((f) => f.name)).toEqual(['Saturday', 'Activity B', 'Part 1']);
    expect(folderAncestors(TREE, 10).map((f) => f.name)).toEqual(['Friday']);
    expect(folderAncestors(TREE, null)).toEqual([]);
    expect(folderAncestors(TREE, 999)).toEqual([]);
  });

  it('collects a folder and everything below it', () => {
    expect([...folderSubtreeIds(TREE, 20)].sort()).toEqual(['20', '21', '22']);
    expect([...folderSubtreeIds(TREE, 22)]).toEqual(['22']);
  });

  // A parent missing from the payload would strand its children out of reach.
  it('hangs a folder whose parent is missing off the root', () => {
    const orphaned = [folder(5, 'Orphan', 404)];
    expect(childFolders(orphaned, null).map((f) => f.id)).toEqual([5]);
  });

  it('survives a parent cycle without hanging', () => {
    const cyclic = [folder(1, 'A', 2), folder(2, 'B', 1)];
    expect(folderAncestors(cyclic, 1).length).toBeLessThanOrEqual(2);
    expect([...folderSubtreeIds(cyclic, 1)].sort()).toEqual(['1', '2']);
  });

  it('resolves a nested folder key at any depth', () => {
    expect(findFolderByKey(TREE, 'part-1-22')?.name).toBe('Part 1');
  });
});

describe('nested folders: scope', () => {
  it('shows only loose photos at the root', () => {
    expect(ids(photosInScope(TREE_PHOTOS, TREE, null))).toEqual([100, 101]);
  });

  it('shows only the photos DIRECTLY in an open folder', () => {
    expect(ids(photosInScope(TREE_PHOTOS, TREE, 20))).toEqual([200]);
    expect(ids(photosInScope(TREE_PHOTOS, TREE, 21))).toEqual([210]);
    expect(ids(photosInScope(TREE_PHOTOS, TREE, 22))).toEqual([220, 221]);
  });

  // The whole point of the own slot: a filter category no longer hides a
  // photo from its folder.
  it('keys containment on folder_id, not on the filter category', () => {
    expect(ids(photosInScope(TREE_PHOTOS, TREE, 11))).toEqual([111, 112]);
    expect(ids(photosInScope(TREE_PHOTOS, TREE, null))).toContain(101);
  });

  it('turns containment off in "All photos"', () => {
    const all = photosInView(TREE_PHOTOS, TREE, null, true);
    expect(ids(all)).toEqual(ids(TREE_PHOTOS));
    expect(all).not.toBe(TREE_PHOTOS);
    expect(ids(photosInView(TREE_PHOTOS, TREE, 20, false))).toEqual([200]);
  });

  it('collects a whole subtree for the folder download', () => {
    expect(ids(photosInSubtree(TREE_PHOTOS, TREE, 20))).toEqual([200, 210, 220, 221]);
    expect(ids(photosInSubtree(TREE_PHOTOS, TREE, 22))).toEqual([220, 221]);
  });

  it('puts a photo whose folder is not in the payload at the root', () => {
    const stray = [inFolder(900, 404)];
    expect(ids(photosInScope(stray, TREE, null))).toEqual([900]);
  });
});

describe('nested folders: legacy payload fallback', () => {
  const folderIds = new Set(['2', '3']);

  it('reads category_id as the folder when folder_id is absent', () => {
    expect(photoFolderId({ category_id: 2 }, folderIds)).toBe('2');
    expect(photoFolderId({ category_id: 1 }, folderIds)).toBeNull();
  });

  it('trusts folder_id once the field is there, even when null', () => {
    expect(photoFolderId({ folder_id: null, category_id: 2 }, folderIds)).toBeNull();
    expect(photoFolderId({ folder_id: 3, category_id: 1 }, folderIds)).toBe('3');
  });
});

describe('nested folders: tiles', () => {
  it('counts recursively and counts direct subfolders', () => {
    const root = folderTiles(TREE, TREE_PHOTOS, null);
    const saturday = root.find((t) => t.category.id === 20);
    expect(saturday?.count).toBe(4);
    expect(saturday?.subfolderCount).toBe(1);
    const friday = root.find((t) => t.category.id === 10);
    expect(friday?.count).toBe(3);
    expect(friday?.subfolderCount).toBe(1);
    expect(root.find((t) => t.category.id === 30)?.subfolderCount).toBe(0);
  });

  it('shows the subfolders of an open folder', () => {
    expect(folderTiles(TREE, TREE_PHOTOS, 20).map((t) => [t.category.name, t.count])).toEqual([['Activity B', 3]]);
    expect(folderTiles(TREE, TREE_PHOTOS, 22)).toEqual([]);
  });

  it('covers with the hero when it is anywhere in the subtree, else the first photo there', () => {
    const withHero = TREE.map((c) => (c.id === 20 ? { ...c, hero_photo_id: 221 } : c));
    expect(folderTiles(withHero, TREE_PHOTOS).find((t) => t.category.id === 20)?.coverPhoto?.id).toBe(221);
    const staleHero = TREE.map((c) => (c.id === 20 ? { ...c, hero_photo_id: 100 } : c));
    expect(folderTiles(staleHero, TREE_PHOTOS).find((t) => t.category.id === 20)?.coverPhoto?.id).toBe(200);
  });

  it('follows the order the photos arrive in for the fallback cover', () => {
    const reordered = [...TREE_PHOTOS].reverse();
    expect(folderTiles(TREE, reordered).find((t) => t.category.id === 20)?.coverPhoto?.id).toBe(221);
  });

  it('drops a parent whose subtree holds no photos', () => {
    const empty = [...TREE, folder(40, 'Sunday'), folder(41, 'Empty child', 40)];
    expect(folderTiles(empty, TREE_PHOTOS).map((t) => t.category.id)).not.toContain(40);
  });

  it('builds the sidebar tree with recursive counts', () => {
    const tree = folderTree(TREE, TREE_PHOTOS);
    const saturday = tree.find((n) => n.category.id === 20);
    expect(saturday?.count).toBe(4);
    expect(saturday?.children.map((n) => [n.category.id, n.count])).toEqual([[21, 3]]);
    expect(saturday?.children[0].children.map((n) => [n.category.id, n.count])).toEqual([[22, 2]]);
  });
});

describe('view param round-trip', () => {
  const original = window.location.href;

  beforeEach(() => window.history.replaceState({}, '', '/gallery/wed?token=abc&folder=saturday-20'));
  afterEach(() => window.history.replaceState({}, '', original));

  it('switches to All photos, leaving the folder and keeping the token', () => {
    writeViewParam('all');
    const params = new URLSearchParams(window.location.search);
    expect(params.get('view')).toBe('all');
    expect(params.get('folder')).toBeNull();
    expect(params.get('token')).toBe('abc');
    expect(readViewParam()).toBe('all');
  });

  it('reads anything but "all" as the folders view', () => {
    window.history.replaceState({}, '', '/gallery/wed?view=nonsense');
    expect(readViewParam()).toBe('folders');
  });

  it('leaves All photos when a folder is opened', () => {
    writeViewParam('all');
    writeFolderParam('friday-10');
    expect(readViewParam()).toBe('folders');
    expect(readFolderParam()).toBe('friday-10');
  });

  it('drops the param on the way back to folders', () => {
    writeViewParam('all');
    writeViewParam('folders');
    expect(new URLSearchParams(window.location.search).get('view')).toBeNull();
  });
});
