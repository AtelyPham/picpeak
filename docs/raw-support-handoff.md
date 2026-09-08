# Handoff — Camera RAW support for PicPeak

You are picking up work that is **analysis-complete and implementation-not-started**. Read this file, then `docs/raw-image-support-analysis.md`, which is the actual plan.

> **Drift note, 2026-09-08.** Both docs were written against `d62e21c`. The branch now sits on
> `c71ffae`, 228 commits later. **Every FILE:LINE in this file and in the analysis is stale -
> re-resolve each one with grep before editing anything.** The four load-bearing findings were
> re-verified by hand and all still hold, at these locations:
>
> - `validateFileType` still MIME-first, the core blocker: `backend/src/utils/fileSecurityUtils.js:160`
> - both extension to MIME maps still dng-only, no arw: `backend/src/services/uploadSettings.js:30-51` and `frontend/src/utils/fileTypes.ts:4-20`
> - watch-folder gate unchanged: `backend/src/services/fileWatcher.js:100`
> - archive-restore data loss unchanged: `backend/src/routes/adminArchives.js:452`
>
> Trap 2 below is **obsolete**. `#1129` removed the delete from `generateThumbnail`'s
> `regenerate` option for its own reasons, so nothing destructive remains on that path, and
> `97d92f84` rewrote `adminThumbnails.js` to regenerate through `ensureThumbnail`. All that was
> left of the finding was RAW never getting a thumbnail through the external branch or through
> `backend/scripts/regenerate-square-thumbnails.js:71`.
>
> Phase 1 item 14 is obsolete: `063977d` removed the `photo.mime_type || 'image/jpeg'` pattern
> everywhere in `backend/src`. It needs re-scoping, not implementing.
>
> `git log --oneline d62e21c..c71ffae` is a large security batch touching the upload and
> photo-serving paths this plan edits. Skim it first. Section 0 of the analysis has the full
> list of overlapping upstream work.

---

## Where the work lives

| | |
|---|---|
| Repo | `github.com/AtelyPham/picpeak` — a private fork of `github.com/PicPeak/picpeak` |
| Branch | `claude/raw-image-format-support-a7vanx` |
| Base commit | `d62e21c` — byte-identical to upstream `PicPeak/picpeak` `main` (verified via `git ls-remote`) |
| Committed so far | `docs/raw-image-support-analysis.md` + a rendered `.html` of it. **No behavioural code changed.** |
| Upstream `stable` | A *different* commit (`10d5cf54`) with **no RAW code and no exiftool** — confirm which branch the deployment tracks before testing |

Stack: Node 20+/Express/Knex backend (SQLite **and** Postgres both supported), React 18 + Vite + TypeScript frontend, `sharp` 0.35.3 for imaging, Docker Compose deploy.

---

## The finding, in one paragraph

**PicPeak can already *process* a Sony `.ARW`. It just refuses to *accept* one.** `backend/src/services/imageProcessor.js:22-25` already declares `RAW_EXTENSIONS` including `'arw'`, and `extractRawPreview()` / `withProcessableImage()` shell out to `exiftool` to pull the embedded JPEG preview (sharp/libvips cannot decode RAW). `exiftool` is already installed in `backend/Dockerfile:85` and `backend/Dockerfile.dev:14`. But `'arw'` appears **exactly once in the whole source tree** — that one line. Every *admission* layer around it knows only `dng`: the extension→MIME maps, the security validator's allow-list, the browser `accept` string, the watch folder, the external-media importer, the archive restorer, and the transfer routes.

**Consequence:** no new decoder, no new dependency, and no DB migration are needed for a working Phase 1. It is allow-list and gate work across ~8 files, plus one substantive change (below).

---

## The one genuinely non-trivial change

`validateFileType()` at `backend/src/utils/fileSecurityUtils.js:159-175` is **MIME-first**:

```js
if (!allowedTypes.includes(mimetype)) { return false; }
```

Browsers send **no MIME at all** for `.arw` on macOS and Windows, so patching the extension→MIME maps alone cannot work. This gate must become **extension-first** — but scoped, **not** a blanket accept of `application/octet-stream`, because `backend/src/routes/publicTransferUpload.js` is unauthenticated and shares this same function.

The upstream maintainer named this exact follow-up in PR #833 and said why he deferred it: *"Extension-based acceptance for the RAW set is a sensible follow-up — I kept it out here to avoid changing the security validator's logic untested."* **If you want this upstreamable, ship it with unit tests** — that was his stated blocker.

---

## Start here

`docs/raw-image-support-analysis.md` §6 is the phased plan. Phase 1 is a numbered table of 17 concrete file changes, each with FILE:LINE and its own acceptance criteria. Work that table top to bottom.

Every `FILE:LINE` in the analysis was read, not inferred — nine parallel agents mapped the subsystems, three adversarial verifiers re-derived and corrected the findings, and the load-bearing claims were spot-checked by hand afterward. Line numbers are accurate as of `d62e21c`; re-verify if you rebase.

---

## Traps — read before touching code

1. **Do not widen `fileWatcher.js:79` on its own.** The guest gallery only emits a thumbnail URL when one already exists (`gallery.js:991`), and the lazy repair path is only reachable for a non-null-but-*invalid* thumbnail path. A NULL `thumbnail_path` is **terminal for guests** — the admin grid self-heals, the client gallery does not. Widen the gate and wire `withProcessableImage` into `fileWatcher.js:100` and `:114` in the same change.

2. **`adminThumbnails.js:165` is destructive on RAW.** "Regenerate all thumbnails" deletes the existing object *before* sharp fails on the RAW original, leaving a dangling `thumbnail_path`. This must ship inside Phase 1 or the first admin click destroys every working RAW thumbnail. Same mechanism in `backend/scripts/regenerate-square-thumbnails.js:71`.

3. **`adminArchives.js:233` is losing data today.** The restore path filters to `/\.(jpg|jpeg|png|gif|webp)$/i`, so archiving and restoring an event **drops RAW rows entirely** while the bytes survive on disk. This already affects DNG, before any Sony work. A forward fix does not recover already-orphaned rows — that needs a reconciliation script driven off `photos_manifest.json`.

4. **Do NOT introduce `media_type = 'raw'`.** The codebase uses *"not video"* as a proxy for *"sharp can decode this"* in at least six places. A `'raw'` value still satisfies `media_type != 'video'`, so it fixes nothing and widens the blast radius. Detect RAW via `isRawFilename()` instead — the single source of truth already exists.

5. **The backend and frontend extension→MIME maps are CI-enforced identical.** `backend/__tests__/services/uploadSettingsFileTypes.test.js:48-50` parses `frontend/src/utils/fileTypes.ts` with a strict regex that **throws** on anything it cannot read. Keep entries as `arw: 'image/x-sony-arw',` — one pair per line, single quotes, no computed keys. Both maps must change in the same commit.

6. **`-JpgFromRaw` does not exist for ARW or CR2.** `imageProcessor.js:43` tries it first, so every ARW burns a wasted exiftool spawn before succeeding on `-PreviewImage`. Worse, there is **no minimum-size floor** at `:57`, so any RAW lacking a preview silently accepts a 160×120 `ThumbnailImage` as the gallery source. Also add `timeout` + `killSignal` to the `execFile` at `:49-52` — without them a wedged exiftool holds a worker slot until the janitor resets the row to `'pending'`, and the next worker wedges on the same file (unbounded retry loop).

---

## Two questions that change the plan — ask the user first

1. **What resolution is the embedded preview on their actual camera bodies?**
   ```
   exiftool -PreviewImageSize -ThumbnailImageSize -Orientation -ImageSize DSC0001.ARW
   ```
   Sony's embedded `PreviewImage` is widely reported at ~1616×1080 — *below* PicPeak's own 1920px hero/preview targets, and the hero generator upscales. If that holds, a 61 MP file gets a sub-1080p gallery and `photos.width/height` advertises 1.7 MP. That moves the LibRaw option (§4 option b, planned for Phase 4) from optional to required. **This could not be determined from the repo and is the single most decision-relevant fact.**

2. **Gallery browsing, or download-only delivery?** If clients only need to *download* RAW and never browse it, the entire quality question disappears and the work shrinks substantially. Related: "deliver RAW to clients" maps more naturally onto PicTransfer (`adminTransfers.js`) than onto galleries — a separate settings path, a smaller independent change, and its client-facing upload page currently has no client-side type gate at all.

§10 of the analysis has eight more open questions (XMP sidecar pairing for Lightroom, watermarking policy for files that can't carry a watermark, what to do when a RAW has no extractable preview).

---

## Environment notes

- **`exiftool` is required at runtime and is not a dev dependency.** It is in both Docker images but likely not on a bare dev machine — `brew install exiftool` on macOS. Nothing in the app probes for it at startup, and `imageProcessor.js:61-66` collapses "binary missing" and "no preview in this file" into one opaque error.
- **There is no RAW fixture anywhere in the repo**, and no upstream test, issue, or comment reports a real-file result for *any* RAW format — including the DNG support that shipped months ago. Treat the existing RAW path as *plausible but unexercised*. §9 recommends synthesising a minimal TIFF container at test time rather than committing a binary, plus keeping one real `.ARW` in a gitignored `test-assets/local/`.
- Tests: `cd backend && npx jest`, `cd frontend && npx vitest run`. Both run in CI (`.github/workflows/tests.yml`). Playwright E2E and lint exist but have **no CI workflow**.
- A full end-to-end change exceeds the 300-line `LINE_LIMIT` in `.github/workflows/bypass-size-gate.yml:34` — the phasing in §6 is partly designed around that.
- Upload size ceilings are a real blocker: §8.1 tables **all 14 of them**. Note `nginx/nginx.conf` sets no `client_max_body_size` at all (nginx default: **1 MB**), and the guest-upload default is 50 MB against Sony ARWs of 55–120 MB.

---

## Provenance

Produced by Claude Opus 5 in a Claude Code web session on 2026-08-17 against `d62e21c`. Upstream history (issue #821, PRs #832/#833/#834, the maintainer quote) was verified directly against GitHub; issue #821 is **not** a RAW feature request — its real title is *"[BUG] Guest upload ignores backend config"*, which is precisely why RAW support stops at the single extension the bug reporter happened to name. Exhaustive upstream search for "Sony OR Canon OR Nikon OR Fujifilm" returns **zero results**: there is no competing work and no maintainer objection to overcome.
