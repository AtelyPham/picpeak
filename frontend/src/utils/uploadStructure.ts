/**
 * Folder uploads (issues 1786 + 1562): from picked files with their relative
 * directories and the server's answer to POST …/folders/resolve, to the
 * upload batches and to the structure preview of the upload modal.
 *
 * Pure functions; the server decides every mapping (skip-outer, first-look
 * keyword, depth folding, which folders exist). These only regroup files by
 * that answer and count them.
 */
import type { PickedFile } from './droppedFiles';
import type { FolderNodeStatus, ResolvedDirectory, ResolveResponse } from '../services/folders.service';
import type { UploadPlacement } from '../services/photos.service';

/** Distinct directories of a selection, '' (loose files) included. */
export const uniqueDirectories = (files: PickedFile[]): string[] =>
  [...new Set(files.map((f) => f.dir))].sort();

/** Whether any file came from inside a folder. */
export const hasDirectories = (files: PickedFile[]): boolean => files.some((f) => f.dir !== '');

export interface PlacementGroup {
  placement: UploadPlacement;
  files: File[];
}

export interface GroupOptions {
  /** Filter category for every file. */
  categoryId: number | null;
  /** Where loose files go (files with no folder of their own); null = root. */
  looseFolderId: number | null;
}

const isLoose = (r: ResolvedDirectory | undefined): boolean =>
  !r || (r.segments !== null && r.segments.length === 0 && !r.first_look && !r.folder_request_id && r.folder_id == null);

/**
 * One group per distinct placement, in the order the files came. Files in a
 * hidden directory (segments null) are left out and returned as `skipped`.
 * A directory missing from `results` is treated as loose.
 */
export function groupFilesByPlacement(
  files: PickedFile[],
  results: Record<string, ResolvedDirectory>,
  { categoryId, looseFolderId }: GroupOptions
): { groups: PlacementGroup[]; skipped: File[] } {
  const groups = new Map<string, PlacementGroup>();
  const skipped: File[] = [];
  for (const { file, dir } of files) {
    const r = results[dir];
    if (r && r.segments === null) {
      skipped.push(file);
      continue;
    }
    const placement: UploadPlacement = isLoose(r)
      ? { categoryId, folderId: looseFolderId }
      : {
          categoryId,
          folderId: r!.folder_id,
          folderRequestId: r!.folder_request_id ?? null,
          firstLook: r!.first_look,
        };
    const key = `${placement.folderId ?? ''}|${placement.folderRequestId ?? ''}|${placement.firstLook ? 1 : 0}`;
    const group = groups.get(key);
    if (group) group.files.push(file);
    else groups.set(key, { placement, files: [file] });
  }
  return { groups: [...groups.values()], skipped };
}

export interface PreviewFolderNode {
  name: string;
  /** Target path, segments joined with '/'. */
  path: string;
  status: FolderNodeStatus | null;
  /** Files in this folder and below. */
  count: number;
  /**
   * For the topmost folder of a missing chain an upload-only role cannot
   * create: the closest existing folder the files wait in (null = root).
   * undefined everywhere else.
   */
  waitsIn?: string | null;
  children: PreviewFolderNode[];
}

export interface UploadPreview {
  /** The single outer folder that is left out ("Skip the outer folder"). */
  skippedOuter: string | null;
  /** Top-level first-look keyword folder(s) and how many files they hold. */
  firstLook: { name: string; count: number } | null;
  tree: PreviewFolderNode[];
  looseCount: number;
  hiddenCount: number;
  /** Some paths were deeper than max_depth and fold into their deepest allowed folder. */
  folded: boolean;
  /** Folders in the tree. */
  folderCount: number;
  /** Folders that will be created (folders.manage). */
  newFolders: number;
  /** Folders an admin has to confirm (upload-only roles). */
  requestedFolders: number;
  /** Files that wait in a closer folder until those requests are decided. */
  waitingFiles: number;
}

const naturalName = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

const MISSING: ReadonlyArray<FolderNodeStatus> = ['needs_admin', 'requested'];

export function buildUploadPreview(
  files: PickedFile[],
  resolve: ResolveResponse,
  { skipOuter, keepStructure }: { skipOuter: boolean; keepStructure: boolean }
): UploadPreview {
  const singleRoot = resolve.single_root;
  const rootIsMarker = !!singleRoot && resolve.results[singleRoot]?.first_look === true;
  const skipApplied = skipOuter && !!singleRoot && !rootIsMarker;

  const nodes = new Map<string, PreviewFolderNode>();
  const topLevel: PreviewFolderNode[] = [];
  const markerNames = new Set<string>();
  let firstLookCount = 0;
  let looseCount = 0;
  let hiddenCount = 0;
  let waitingFiles = 0;
  let folded = false;

  for (const { dir } of files) {
    const r = resolve.results[dir];
    if (!r) {
      looseCount += 1;
      continue;
    }
    if (r.segments === null) {
      hiddenCount += 1;
      continue;
    }
    const source = dir === '' ? [] : dir.split('/');
    if (r.first_look) {
      firstLookCount += 1;
      const name = rootIsMarker ? singleRoot : source[skipApplied ? 1 : 0];
      if (name) markerNames.add(name);
      continue;
    }
    if (keepStructure && source.length - (skipApplied ? 1 : 0) > resolve.max_depth) folded = true;
    if (r.segments.length === 0) {
      looseCount += 1;
      continue;
    }
    if (r.status === 'needs_admin' || r.status === 'requested') waitingFiles += 1;

    let siblings = topLevel;
    for (let i = 0; i < r.segments.length; i += 1) {
      const path = r.segments.slice(0, i + 1).join('/');
      let node = nodes.get(path);
      if (!node) {
        node = { name: r.segments[i], path, status: resolve.nodes[path] ?? null, count: 0, children: [] };
        nodes.set(path, node);
        siblings.push(node);
      }
      node.count += 1;
      siblings = node.children;
    }
  }

  // The closest existing folder for the top of each missing chain.
  const mark = (list: PreviewFolderNode[], parent: PreviewFolderNode | null, existing: string | null) => {
    list.sort((a, b) => naturalName.compare(a.name, b.name));
    for (const node of list) {
      const missing = node.status !== null && MISSING.includes(node.status);
      if (missing && (!parent || parent.status === null || !MISSING.includes(parent.status))) {
        node.waitsIn = existing;
      }
      mark(node.children, node, missing ? existing : node.name);
    }
  };
  mark(topLevel, null, null);

  const all = [...nodes.values()];
  return {
    skippedOuter: skipApplied && keepStructure ? singleRoot : null,
    firstLook: firstLookCount > 0 ? { name: [...markerNames].join(', '), count: firstLookCount } : null,
    tree: topLevel,
    looseCount,
    hiddenCount,
    folded,
    folderCount: all.length,
    newFolders: all.filter((n) => n.status === 'new' || n.status === 'created').length,
    requestedFolders: all.filter((n) => n.status !== null && MISSING.includes(n.status)).length,
    waitingFiles,
  };
}
