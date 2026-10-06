/**
 * Pure helpers over an event's flat folder list (issue 1786) for the admin
 * folder browser and pickers. Folders arrive as rows with parent_id; these
 * walk that list without building a tree object.
 */

export interface FolderNode {
  id: number;
  name: string;
  parent_id: number | null;
  photo_count?: number;
  allow_downloads?: boolean;
}

/** Direct children of `parentId` (null = top level), in the order given. */
export function childFolders<T extends FolderNode>(folders: T[], parentId: number | null): T[] {
  return folders.filter((f) => (f.parent_id ?? null) === parentId);
}

/** The chain from the top level down to `id`, `id` included. Stops on a broken or cyclic chain. */
export function folderAncestry<T extends FolderNode>(folders: T[], id: number | null): T[] {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const chain: T[] = [];
  const seen = new Set<number>();
  let current = id == null ? undefined : byId.get(id);
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    chain.unshift(current);
    current = current.parent_id == null ? undefined : byId.get(current.parent_id);
  }
  return chain;
}

/** `id` and every folder below it. */
export function subtreeIds(folders: FolderNode[], id: number): Set<number> {
  const out = new Set<number>([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const f of folders) {
      if (f.parent_id != null && out.has(f.parent_id) && !out.has(f.id)) {
        out.add(f.id);
        grew = true;
      }
    }
  }
  return out;
}

/** Photos in a folder and all its subfolders. */
export function recursivePhotoCount(folders: FolderNode[], id: number): number {
  const ids = subtreeIds(folders, id);
  return folders.reduce((sum, f) => sum + (ids.has(f.id) ? f.photo_count ?? 0 : 0), 0);
}

/** 1 for a top-level folder. */
export function folderDepth(folders: FolderNode[], id: number): number {
  return folderAncestry(folders, id).length;
}

/** Levels below `id`: 0 for a folder without subfolders. */
export function subtreeHeight(folders: FolderNode[], id: number): number {
  const kids = childFolders(folders, id);
  if (kids.length === 0) return 0;
  return 1 + Math.max(...kids.map((k) => subtreeHeight(folders, k.id)));
}

/** "Saturday › Activity B" */
export function folderPathLabel(folders: FolderNode[], id: number | null, separator = ' › '): string {
  return folderAncestry(folders, id).map((f) => f.name).join(separator);
}

/**
 * Downloads inherit (issue 1786): the most restrictive setting along the
 * ancestor chain wins. Returns the closest ancestor (not the folder itself)
 * that blocks downloads, or null.
 */
export function downloadsBlockedBy<T extends FolderNode>(folders: T[], id: number): T | null {
  const chain = folderAncestry(folders, id).slice(0, -1);
  for (let i = chain.length - 1; i >= 0; i -= 1) {
    if (chain[i].allow_downloads === false) return chain[i];
  }
  return null;
}

/**
 * Folders a folder may be moved under: not itself or its own subtree, and
 * deep enough room for its subtree within `maxDepth`. null (top level) is
 * always allowed when the subtree fits.
 */
export function moveTargetsFor(folders: FolderNode[], id: number, maxDepth: number): Set<number> {
  const excluded = subtreeIds(folders, id);
  const height = subtreeHeight(folders, id);
  const allowed = new Set<number>();
  for (const f of folders) {
    if (excluded.has(f.id)) continue;
    if (folderDepth(folders, f.id) + 1 + height <= maxDepth) allowed.add(f.id);
  }
  return allowed;
}
