# Camera RAW (Sony `.ARW`) Support in PicPeak — Analysis & Implementation Plan

**Repo:** `/home/user/picpeak` @ `d62e21c` — byte-identical to upstream `PicPeak/picpeak` `main` (verified via `git ls-remote`); working tree clean.
**Goal:** a photographer shooting Sony needs to deliver RAW originals to clients.
**Date:** 2026-08-17

> **Status: analysis only.** No behavioural code has been changed. This document is the plan; §6 is the thing to execute against.
>
> **How this was produced.** Nine parallel agents mapped every format gate in the codebase; three adversarial verifiers (end-to-end trace, format/tooling feasibility, ops & security) re-derived the findings independently and corrected them. Every `FILE:LINE` below was read, not inferred. The upstream history in §2b was verified directly against GitHub. Claims that could *not* be settled from the repo are marked as such and collected in §10 — the most important is the embedded-preview resolution of the user's actual camera bodies, which decides the architecture in §4.

---

## 0. Drift note (2026-09-08) - read before using any line number below

This document was written against `d62e21c`. The branch now sits on `c71ffae`, 228 commits later.
**Every FILE:LINE below is stale. Re-resolve each one with grep before editing anything.**

`git log --oneline d62e21c..c71ffae` is a large security batch that touches the upload and
photo-serving paths this plan edits. Skim it before starting Phase 1.

### The four load-bearing findings still hold

Re-verified by hand on 2026-09-08 at these locations:

| Finding | Written as | Now at |
|---|---|---|
| `validateFileType` is still MIME-first. The core blocker. | `fileSecurityUtils.js:159-175` | `backend/src/utils/fileSecurityUtils.js:160` |
| Both extension to MIME maps are still dng-only, no arw. Still CI-enforced identical. | `uploadSettings.js:21-42`, `fileTypes.ts:4-20` | `backend/src/services/uploadSettings.js:30-51`, `frontend/src/utils/fileTypes.ts:4-20` |
| Watch-folder gate unchanged. | `fileWatcher.js:79` | `backend/src/services/fileWatcher.js:100` |
| Archive-restore data loss unchanged. | `adminArchives.js:233` | `backend/src/routes/adminArchives.js:452` |

### Obsolete: Phase 1 item 14

Upstream `063977d` ("never serve a photo under its stored MIME, and stop trusting the
chunked-upload type") removed the `photo.mime_type || 'image/jpeg'` pattern. Zero occurrences
remain anywhere in `backend/src`. Item 14 needs re-scoping against what `063977d` actually
built, not implementing as written.

### Other upstream work that overlaps this plan

Verified 2026-09-08:

- **Trap 2 is fully obsolete.** `#1129` removed the delete from `generateThumbnail`'s
  `regenerate` option, and the comment at `imageProcessor.js:293-305` explains why: the delete ran
  before sharp had opened the source, so an unreadable source left the old thumbnail gone and the
  row pointing at nothing. Nothing destructive remains on this path. `97d92f84` separately
  rewrote `adminThumbnails.js` to regenerate through `ensureThumbnail` rather than calling sharp,
  guarding the superseded-object delete on the storage key actually having changed. What was left
  of the finding was only that RAW could never *get* a thumbnail through the external/reference
  branch or through `backend/scripts/regenerate-square-thumbnails.js:71`; both are fixed here.
- **Phase 2's `adminPhotoDimensions.js:86` row is done upstream.** Both sharp calls are wrapped in
  `withProcessableImage` at `:670` and `:680`.
- **`nginx/nginx.conf` does exist and did lack `client_max_body_size`**, so anything including it
  inherited nginx's 1 MB default. `frontend/nginx.conf`, the one that actually ships, has had 1G
  at `:24` and `:129` all along.
- **The `imageProcessor.js:358` gap still holds**, now at `imageProcessor.js:493`: the
  external/reference branch of `ensureThumbnail` calls `generateThumbnail` without
  `withProcessableImage`. The sized-tier work (`887bdbe6`, `011f6ae7`) added a second copy of the
  same gap at `imageProcessor.js:1077` inside `ensureThumbnailAtWidth`. Phase 2 has to fix both.
- **`extractRawPreview` now separates "exiftool is not installed" from "this file has no
  preview"** and names the install command per platform. The Phase 4 bullet asking for that, and
  the environment note calling the error opaque, are both done.
- **EXIF orientation landed.** `c18f54ed` added orientation handling to thumbnails, heroes and
  previews; `edef4d73` backfilled existing libraries. There is now an `orientedDimensions()`
  helper at `imageProcessor.js:417`. Check Phase 1 item 10(d) against it before writing any new
  orientation code.
- **`withProcessableImage` call sites went from 6 to 10**: `imageProcessor.js:503, 731, 1079,
  1146, 1225`, `photoProcessor.js:171, 535`, `photoReplacementService.js:164`, and
  `adminPhotoDimensions.js:670, 680`. The last two close the Phase 2 row for
  `adminPhotoDimensions.js:86`.
- **`AuthenticatedImage.tsx` already has a `fallbackSrc` error path** at `:300-301`, plus a
  fallback fetch at `:224-226`. Phase 1 item 15 should be re-checked against that rather than
  adding one.

### Measured against a real file, 2026-09-11

Sony **ILCE-7M5**, `DSC00632.ARW`, 41 MB, exiftool 13.55. This refutes two load-bearing claims in
§4 (both corrected in place there) and answers §10 Q1:

- `JpgFromRaw` **exists** for ARW and is the full-size frame: 7008x4672, 2393931 bytes.
  `PreviewImage` is 1616x1080 as predicted, and `ThumbnailImage` is 160x120. So the plan's
  recommended reorder to put `PreviewImage` first would have been a twenty-fold quality
  regression. Extraction now probes the file and takes the largest image present.
- There is **no `JpgFromRawSize` tag**, so the §4.3 discovery probe as specified cannot see the
  biggest preview. `JpgFromRawLength`, `PreviewImageLength` and `ThumbnailLength` all exist, so
  the probe ranks on byte length and verifies real dimensions after extraction.
- The extracted preview carries **no EXIF at all**. The container reports `Orientation` 8, and
  all three embedded images come out bare, so every portrait RAW would be sideways everywhere.
  The orientation is now written onto the preview with exiftool, which touches no pixel data.
- Renditions from the largest image: 200x300 thumbnail (portrait), 1280x1920 lightbox preview
  (hits the 1920 target), 1920x1080 hero with no upscale, `4672x7008` stored dimensions.
- 611 ms, 3 exiftool spawns for a portrait file and 2 for a landscape one.
- A Windows PE binary renamed `evil.arw` passes the extension gate and is rejected by the
  magic-number check, which is Phase 1 acceptance criterion 8.

Everything else in this document was written against `d62e21c` and has not been re-verified.

---

## 1. Executive summary

**PicPeak can already *process* a Sony `.ARW`. It just refuses to *accept* one.** The RAW decode shim that landed under upstream issue #821 — `RAW_EXTENSIONS`, `isRawFilename()`, `extractRawPreview()`, `withProcessableImage()` at `backend/src/services/imageProcessor.js:22-82` — explicitly lists `'arw'` and is wired into the real ingest worker (`backend/src/services/photoProcessor.js:517`) and all three lazy rendition generators. `exiftool` is installed in both `backend/Dockerfile:85` and `backend/Dockerfile.dev:14`. But every *admission* layer around it — the extension→MIME map (`backend/src/services/uploadSettings.js:21-42`), the security validator's allow-list (`backend/src/utils/fileSecurityUtils.js:105-116`), the browser file picker (`frontend/src/utils/fileTypes.ts:4-20`), the watch folder (`backend/src/services/fileWatcher.js:79`), the external-media importer, the archive restorer, and the transfer routes — knows only `dng`. `'arw'` appears **exactly once in the entire source tree**: `imageProcessor.js:22-25`.

The gap is therefore **wide but shallow**: no new decoder, no new dependency, no schema migration is required to get a Sony ARW uploaded, thumbnailed, shown and downloaded. It is roughly 8 files of allow-list and gate work, plus **one genuinely non-trivial change the upstream maintainer explicitly deferred**: `validateFileType()` (`fileSecurityUtils.js:159-175`) is MIME-first, and browsers report no MIME at all for `.arw` on macOS and Windows — so no amount of map-patching alone works. That gate must become extension-first.

Two things make this bigger than a one-day patch. First, **quality**: the embedded-preview approach caps a 61 MP a7R V at the ARW's embedded `PreviewImage`, widely reported as ~1616×1080 — *below* PicPeak's own 1920px hero/preview targets (`imageProcessor.js:98-99`, `:108`), and the hero generator upscales (`imageProcessor.js:472-476`). Second, **the delivery story**: several download paths silently fail open on RAW (watermarking returns un-watermarked originals, resolution capping is a no-op), and archive→restore *loses RAW rows entirely* (`backend/src/routes/adminArchives.js:233`) — a data-loss bug that already applies to DNG today.

---

## 2. What already exists — the #821 DNG groundwork

Shipped upstream across PRs #832 (HEIC/HEIF), #833 (RAW preview extraction), #834 (map sync). Present verbatim in this fork.

| Component | FILE:LINE | Covers ARW? |
|---|---|---|
| `RAW_EXTENSIONS` set (17 formats incl. `arw`) | `backend/src/services/imageProcessor.js:22-25` | ✅ yes |
| `isRawFilename(name)` — extension-based | `imageProcessor.js:27-31` | ✅ yes |
| `extractRawPreview()` — shells `exiftool -b <tag>` | `imageProcessor.js:40-67` | ⚠️ works, but wrong tag order (§4) |
| `withProcessableImage(localPath, sourceName)` | `imageProcessor.js:76-82` | ✅ yes |
| exiftool in prod image | `backend/Dockerfile:85` | ✅ (unpinned) |
| exiftool in dev image | `backend/Dockerfile.dev:14` | ✅ |
| RAW watermark skip (honest refusal) | `backend/src/services/watermarkGeneratorService.js:67-69` | ✅ uses `isRawFilename` |
| Lightbox preview forcing | `backend/src/routes/gallery.js:71-79` | ❌ `dng`/`heic`/`heif` only |
| Extension→MIME (backend) | `backend/src/services/uploadSettings.js:21-42` | ❌ `dng` only |
| Extension→MIME (frontend, CI-mirrored) | `frontend/src/utils/fileTypes.ts:4-20` | ❌ `dng` only |
| Security allow-list + magic numbers | `backend/src/utils/fileSecurityUtils.js:105-116` | ❌ `image/x-adobe-dng` only |
| RAW-aware unit test | `backend/__tests__/services/imageProcessorRaw.test.js:12` | ✅ already asserts `.arw` |

### How far `withProcessableImage` is actually wired

**Wired (6 sites):** `imageProcessor.js:370` (ensureThumbnail, *managed* branch only), `:547` (hero), `:682` (preview), `photoProcessor.js:171` (sync path), `photoProcessor.js:517` (**the async worker — the live path**), `photoReplacementService.js:74`.

**NOT wired — these hand a RAW original straight to `sharp()` and throw:**

| FILE:LINE | Consequence |
|---|---|
| `imageProcessor.js:358` | ensureThumbnail **external/reference** branch (guard at `:341`). NAS-referenced RAW can *never* get a thumbnail, eagerly or lazily. |
| `fileWatcher.js:100`, `:114` | Watch-folder thumbnail + dimensions (currently unreachable, protected by the `:79` gate). |
| `backend/src/routes/adminThumbnails.js:165` | **Destructive**: `regenerate:true` deletes the existing object at `imageProcessor.js:206-208` *before* sharp fails, then `:265` deletes the partial. A working RAW thumbnail is wiped and the DB keeps a dangling `thumbnail_path`. |
| `backend/scripts/regenerate-square-thumbnails.js:71` | Same destructive mechanism. |
| `backend/src/routes/adminPhotoDimensions.js:86` | Repair job throws per RAW, retries forever. |
| `backend/src/routes/adminExternalMedia.js:121`, `:159` | External import: null dims, failed thumbnails. |
| `backend/src/services/s3AutoImporter.js:112` | S3 import dims (unreachable — the MIME gate at `:98-100` skips ARW first). |
| `backend/src/routes/v1/events.js:661`, `:668` | Public API: swallows both errors, inserts `width/height/thumbnail_path = NULL`. |

**Verified critical caveat about the DNG work:** `imageProcessor.js:99-104` already concedes the browser-MIME problem in a code comment — *"Only reached when an admin adds `dng` to the allowed types AND the browser reports the DNG MIME (Chrome does; browsers that send an empty type won't get this far)."* Additionally, `dng` is in `EXTENSION_TO_MIME` but **not** in `DEFAULT_ALLOWED_FILE_TYPES = 'jpg,jpeg,png,webp'` (`uploadSettings.js:44`), so DNG is unreachable on a default install. There is no evidence anywhere upstream that the DNG path has ever been exercised end-to-end with a real file.

---

## 2b. Upstream history — what actually shipped, and what the maintainer deferred

*Independently verified: `git ls-remote https://github.com/PicPeak/picpeak.git` returns `d62e21c1…` for `main`, byte-identical to this fork's HEAD. `stable` is a different commit (`10d5cf54…`) and carries none of the RAW code or the exiftool install — confirm which branch your deployment tracks.*

**Issue #821 is not a RAW feature request.** Its real title is **"[BUG] Guest upload ignores backend config"** (opened by *mat1990dj*, 2026-07-17, closed 2026-07-19). The complaint was that the guest upload page hardcodes a 50 MB cap and a fixed extension list instead of reading the admin's backend settings; `.dng` and `.mov` were the examples given. RAW support arrived as a *side effect* of fixing a config-plumbing bug — which is precisely why it stops at the one extension the reporter happened to name.

Three merged PRs, all citing #821:

| PR | Title | Author | What it did |
|---|---|---|---|
| #832 | `feat(uploads): HEIC/HEIF support + dynamic format hint` | the-luap | Added HEIC/HEIF. **Explicitly excluded RAW**, reasoning that libvips has no raw loader, so "adding `dng` here would let it upload and then fail thumbnailing" |
| #833 | `feat(uploads): DNG / camera-RAW support via embedded-preview extraction` | the-luap | Added `extractRawPreview`/`withProcessableImage`, exiftool in both Dockerfiles, the RAW watermark skip — and mapped **only `dng`** in the format maps |
| #834 | `fix(uploads): support configured raw formats` | Dodothereal | Added `heic`/`heif` to the maps plus the backend↔frontend map-parity test |

**The maintainer's own deferral, from PR #833 — this is the exact gap you are about to close:**

> "a DNG is only accepted when the browser reports its MIME as `image/x-adobe-dng` (Chrome does); browsers that send an empty type reject it client- and server-side. Extension-based acceptance for the RAW set is a sensible follow-up — I kept it out here to avoid changing the security validator's logic untested."

And on verification:

> "I could not exercise the actual exiftool extraction locally (exiftool isn't a dev dependency and there's no DNG fixture in the repo)… The end-to-end extract→thumbnail→display on an actual DNG needs a check once the backend image rebuilds with exiftool."

Two consequences worth internalising:

1. **The `validateFileType` change is the sanctioned follow-up, not a hack.** The maintainer named it, scoped it, and said why it was left out: no tests. Shipping it *with* tests is the price of upstreamability — and the reason §9 treats those tests as mandatory rather than nice-to-have.
2. **No one has ever confirmed the RAW path works on a real file.** Not for DNG, not for anything. There is no RAW fixture upstream, no follow-up issue, and no report of a successful end-to-end run. Treat the existing DNG support as *plausible but unexercised* — your first real `.ARW` is also the first real test of code that shipped eight months ago.

**Exhaustive search of upstream issues and PRs** (multiple phrasings): "Sony OR Canon OR Nikon OR Fujifilm" → **zero results**. "libraw OR dcraw OR ProRAW" → only #821. "ARW OR CR2 OR CR3 OR NEF" → #821 and one false-positive matching on the "raw" stem. **No follow-up issue for the RAW set was ever filed.** There is no competing work upstream and no maintainer objection to overcome — the path is open.

---

## 3. Why Sony ARW fails today — the ordered blocker chain

### 3.1 Step-by-step trace: one 55 MB `DSC01234.ARW`, admin UI

| # | Stage | FILE:LINE | Verbatim gate | Outcome |
|---|---|---|---|---|
| 1 | OS file picker | `frontend/src/components/admin/PhotoUpload.tsx:543` (`accept={acceptString}`) via `frontend/src/utils/fileTypes.ts:47-53` | accept string is MIME-only, built from `EXTENSION_TO_MIME` | `.ARW` **greyed out** — cannot be selected |
| 2 | Drag-drop / picker filter | `PhotoUpload.tsx:138-139` | `const imageFiles = incoming.filter((file) => allowedMimeTypes.includes(file.type));` then `if (imageFiles.length === 0) return;` | **Silently dropped.** `file.type === ''` on macOS/Windows. No toast, no log, no request. *This is what the photographer experiences: "the dropzone does nothing."* |
| — | *(guest equivalent)* | `frontend/src/components/gallery/UserPhotoUpload.tsx:74` | same `.includes(file.type)` test | at least toasts `Invalid file type: …` |
| 3 | Allowed-MIME resolution | `backend/src/services/uploadSettings.js:177-183` | `const mime = EXTENSION_TO_MIME[cleaned]; if (mime) { mimeSet.add(mime); }` | **Root cause.** Admin typing `arw` into Settings → General is a **silent no-op**. |
| 3b | Empty-set fallback | `uploadSettings.js:185-187` | `if (mimeSet.size === 0) { return extensionsToMimeTypes(DEFAULT_ALLOWED_FILE_TYPES); }` | Typing *only* RAW extensions reverts the install to `jpg,jpeg,png,webp` — the opposite of intent |
| 4 | multer fileFilter | `backend/src/routes/adminPhotos.js:80` | `if (validateFileType(file.originalname, file.mimetype, allowedMimeTypes))` | reject → `cb(new Error('Invalid file type. Check allowed file types in system settings.'))` at `:83` → HTTP 400 at `:153` |
| 4a | MIME-first check | `backend/src/utils/fileSecurityUtils.js:161` | `if (!allowedTypes.includes(mimetype)) { return false; }` | **The maintainer's deferred blocker.** Browser sends `''`/`application/octet-stream` |
| 4b | Extension cross-check | `fileSecurityUtils.js:169-171` | `const typeConfig = ALLOWED_MEDIA_TYPES[mimetype]; if (!typeConfig \|\| !typeConfig.extensions.includes(ext)) { return false; }` | No `image/x-sony-arw` key exists |
| 5 | Content validator | `adminPhotos.js:157` → `fileSecurityUtils.js:185-187` | `const typeConfig = ALLOWED_MEDIA_TYPES[expectedMimeType]; if (!typeConfig) { return false; }` | Unreachable today. **If you patch only step 3, this becomes a post-upload reject** — 55 MB uploaded, then `fs.unlink` + 400 |
| 6 | Integrity probe | `backend/src/middleware/uploadValidation.js:19-21` | `const imageExtensions = ['.jpg','.jpeg','.png','.gif','.webp']; if (imageExtensions.includes(ext)) {…}` | **Not a gate** — a *skip*. `.arw` returns `true` at `:58` unvalidated |
| 7 | Storage + row insert | `adminPhotos.js:352-383` | `storage.putFromFile(finalKey, file.path, {contentType: file.mimetype})` … `processing_status: 'pending'` | ✅ would work; extension preserved via `path.extname(file.originalname)` at `:338` |
| 8 | Async worker | `photoProcessor.js:517` | `const proc = await withProcessableImage(localPath, photo.filename);` | ✅ **works** — exiftool extracts the preview |
| 9 | Size | `adminPhotos.js:69-70` | `fileSize: 10 * 1024 * 1024 * 1024` | ✅ never blocks on admin route (see §8 for every other route) |
| 10 | Gallery display | `gallery.js:72-73` + `:1001` | `NON_DISPLAYABLE_ORIGINAL_EXT = new Set(['heic','heif','dng'])` … `preview_url: (lightboxPreviewEnabled \|\| originalNeedsPreview(photo)) && … ? … : null` | ❌ **`arw` absent** → with `lightbox_preview_enabled` off (default), `preview_url` is `null`, lightbox loads the raw ARW → broken image |
| 11 | Download | `gallery.js:1257`, `:1269` | `'Content-Type': photo.mime_type \|\| 'image/jpeg'` | Bytes are correct (filename survives via RFC 5987), **type is a lie** |

**Net:** a photographer using the UI never generates a single server-side log line. The failure is invisible at every layer.

### 3.2 Trace: the same file dropped into the watch folder

| # | FILE:LINE | Verbatim gate | Outcome |
|---|---|---|---|
| 1 | `fileWatcher.js:43-48` | chokidar `ignored: /(^\|[\/\\])\../`, `awaitWriteFinish: {stabilityThreshold: 2000}` | ✅ passes; 2 s covers a 55 MB copy |
| 2 | `fileWatcher.js:77` | `const detectedMime = mime.lookup(filePath) \|\| '';` | `mime-db@1.54.0` (`backend/package-lock.json:8763`) has **no** `.arw` entry → `''` |
| 3 | **`fileWatcher.js:79`** | `if (!isVideo && !['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) return;` | ❌ **bare `return`, no log at any level.** Silent. Also rejects `.dng`, `.gif`, `.heic` |
| 4 | *(if 3 widened)* `fileWatcher.js:100` | `thumbnailPath = await generateThumbnail(filePath);` | ❌ RAW original → sharp → throws → `null`. `fileWatcher.js:8` imports only `{ generateThumbnail, generateVideoPlaceholder }` |
| 5 | *(if 3 widened)* `fileWatcher.js:114` | `const metadata = await sharp(filePath).metadata();` | ❌ throws, debug-logged at `:118`, width/height omitted |
| 6 | *(if 3 widened)* `fileWatcher.js:105` | `const mimeType = detectedMime \|\| (isVideo ? 'video/mp4' : 'image/jpeg');` | ❌ persists the lie `image/jpeg` |
| 7 | *(if 3 widened)* `fileWatcher.js:134-143` | insert omits `media_type`, `source_origin`, `original_filename`, `captured_at`, **and `processing_status`** | NULL status is treated as complete by `gallery.js:373`/`:652` (`.orWhereNull`) → row **is** shown to guests |

> ⚠️ **Widening `fileWatcher.js:79` alone is actively harmful.** The guest gallery only emits a thumbnail URL when one already exists — `gallery.js:991`: `thumbnail_url: photo.thumbnail_path ? … : null`. A NULL `thumbnail_path` is **terminal for guests**: `ensureThumbnail`'s lazy repair is only reachable for a non-null-but-*invalid* path (`imageProcessor.js:332-339`). The admin grid self-heals (`adminPhotos.js:1096` emits the URL unconditionally, `:1272` calls `ensureThumbnail`), the client gallery does not. Every "it self-heals on first view" assumption is false client-side.

### 3.3 Every other ingest path

| Path | FILE:LINE | Verbatim gate | ARW today |
|---|---|---|---|
| Guest gallery upload | `gallery.js:2531-2537` | `if (validateFileType(file.originalname, file.mimetype, allowedMimeTypes))` | ❌ 400 `Invalid file type` |
| Public API v1 | `backend/src/routes/v1/events.js:61-64` | `if (/^image\//.test(file.mimetype)) cb(null, true);` | ⚠️ **ACCEPTED** if the client asserts `image/x-sony-arw`. Produces a broken row: NULL width/height/thumbnail |
| Chunked upload | `adminPhotos.js:1324-1421` | *no format gate at all* | ❌ **unreachable** — `backend/server.js:463-471` returns 415 for any non-JSON/non-multipart body; the client sends `application/octet-stream` (`frontend/src/services/photos.service.ts:161-163`). Also **zero callers** of `uploadLargeFile` in `frontend/src` |
| External media browse | `backend/src/services/externalMediaService.js:77` | `if (['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) {` | ❌ RAW folder renders **empty** |
| External media import | `adminExternalMedia.js:41` and `:67` | same array, duplicated | ❌ `{imported: 0, skipped: 0}` |
| S3 auto-import | `s3AutoImporter.js:98-101` | `const isImage = mimeType.startsWith('image/'); … if (!isImage && !isVideo) continue;` | ❌ skipped (mime-db has no `.arw`). **Admits `.dng`** — live local-vs-S3 inconsistency |
| Archive restore | `backend/src/routes/adminArchives.js:233` | `if (!entry.isDirectory && entry.name.match(/\.(jpg\|jpeg\|png\|gif\|webp)$/i)) {` | ❌ **DATA LOSS.** `archiveService.js:92` archives everything; restore extracts the bytes but creates no `photos` row |
| `.picpeak` restore | `backend/src/services/picpeakImportService.js:383-404` | *no gate* | ✅ correct — reference behaviour |
| Photo replacement | `backend/src/services/photoReplacementService.js:74` | `withProcessableImage(newFileTempPath, newFilename)` | ✅ correct, but unreachable (upstream gate) |
| Admin transfers | `backend/src/routes/adminTransfers.js:35`, `:55` | `DEFAULT_ALLOWED = ['image/jpeg','image/png','image/webp','image/gif','image/tiff','application/pdf','application/zip']` | ❌ 400. **Also pre-broken**: `image/tiff`, `application/pdf`, `application/zip` have no `ALLOWED_MEDIA_TYPES` entry → always false at `fileSecurityUtils.js:170` |
| Public transfer upload | `backend/src/routes/publicTransferUpload.js:41`, `:127` | identical duplicated list | ❌ same |
| `backend/src/config/multerConfig.js:23-30` | — | — | **DEAD CODE** — no `require()` anywhere. Do not patch |

---

## 4. Architecture decision — how to decode RAW

### The Sony tag-ordering trap

> **CORRECTED 2026-09-11 against a real file.** Everything below this quote was wrong in the
> direction that matters, and acting on it would have cost a factor of twenty in resolution.
> Measured on `DSC00632.ARW` from a Sony **ILCE-7M5**, exiftool 13.55:
>
> ```
> [IFD2] JpgFromRawLength    : 2393931   ->  7008x4672  (32.7 MP)
> [IFD0] PreviewImageLength  :  285137   ->  1616x1080  ( 1.7 MP)
> [IFD1] ThumbnailLength     :    7833   ->   160x120
> [IFD0] Orientation         : 8 (rotate 270 CW)
> ```
>
> **`JpgFromRaw` does exist for ARW**, at least on current bodies, and it is the full-size
> frame. The original order (`JpgFromRaw` first) was therefore *right* for this camera, and
> "reorder to put `PreviewImage` first" would have capped a 36.7 MP photo at 1.7 MP.
>
> The real lesson is that neither order is safe, because which tag holds the big image varies
> by body. `imageProcessor.js` now probes the file first - one `exiftool -json -n` spawn reading
> `JpgFromRawLength`, `PreviewImageLength`, `ThumbnailLength` and `Orientation` - and takes the
> largest thing actually present. Note there is **no `JpgFromRawSize` tag**; only
> `PreviewImageSize` exists, which is why the probe ranks on byte length and then verifies the
> real pixel dimensions after extraction.

`imageProcessor.js:43`: `const tags = ['-JpgFromRaw', '-PreviewImage', '-ThumbnailImage'];`

The claim as originally written: in exiftool, `JpgFromRawStart` is defined only for DNG SubIFD2, NEF/NRW/SRW SubIFD, PEF IFD2, Panasonic RW2, and Canon CRW (`Exif.pm:673-682`, `:1238-1247`, `:1251-1260`); Canon CR2's full-res JPEG is exposed as `PreviewImage` in IFD0 (`Exif.pm:645-655`); Sony ARW's preview is likewise `PreviewImageStart` in IFD0, "for all models" (`Exif.pm:1226-1232`). **The ILCE-7M5 measurement above refutes the Sony half of this.** The Canon half is untested.

- **A wasted spawn was still a real cost**, just not on the file it was claimed for: a body with no `JpgFromRaw` paid for the miss. With three lazy generators each calling `withProcessableImage` independently (`imageProcessor.js:370`, `:547`, `:682`, no caching), one RAW can cost **~8 spawns** over its lifetime. The probe does not fix that; caching the extracted preview (Phase 4) does.
- **The missing size floor was real.** `imageProcessor.js:57` had none (`if (meta.width && meta.height)`), so for any RAW where the larger previews are absent (exiftool `Sony.pm:918-926` documents ILCE-5100/7M2/7RM2/7SM2 with `Size 0, Offset 0`), a 160×120 `ThumbnailImage` **was** silently accepted as the photo.

### The quality ceiling

> **CORRECTED 2026-09-11: there is no ceiling on a current Sony body.** The 1616×1080 figure is
> right for `PreviewImage` and confirmed on an ILCE-7M5 - but that body also carries a
> 7008×4672 `JpgFromRaw`, so the table below describes a file that was never the best available.
> Measured end to end on `DSC00632.ARW` once extraction takes the largest embedded image:
>
> | Rendition | Result |
> |---|---|
> | Thumbnail 300px | 200×300, correctly portrait |
> | Preview 1920px long edge | 1280×1920, hits the target exactly |
> | Hero 1920×1080 | 1920×1080, **no upscale** |
> | `photos.width/height` | 4672×7008, the real frame |
>
> Extraction takes **611 ms** for a 41 MB ARW, in 3 exiftool spawns (probe, extract, orientation
> write; 2 for a landscape shot). **This answers §10 Q1: the LibRaw option in §4(b) is not
> required.** It stays a Phase 4 nice-to-have, and it would matter only for a body whose largest
> embedded image is small.

The original claim: Sony's embedded `PreviewImage` is widely reported as **~1616×1080 (~1.7 MP)** across the Alpha line. Against PicPeak's own constants, *if `PreviewImage` were the only thing available*:

| Rendition | Constant | Enlarges? | ARW outcome |
|---|---|---|---|
| Thumbnail 300px | `imageProcessor.js:85-86`, fit at `:228` `withoutEnlargement: true` | no | ✅ fine |
| Preview 1920px long edge | `imageProcessor.js:108`, `:610-612` `withoutEnlargement: true` | no | ⚠️ capped at ~1616px, never reaches 1920 |
| Hero 1920×1080 | `imageProcessor.js:98-99`, `:472-476` `withoutEnlargement: **false**`, `fit: 'cover'` | **yes** | ❌ upscales ~19% and crops — permanently soft hero |
| `photos.width/height` | written from the preview at `photoProcessor.js:527` | — | ❌ a 61 MP file is advertised as 1.7 MP |

> **Verify before committing:** run `exiftool -PreviewImageSize -ThumbnailImageSize -Orientation DSC0001.ARW` on the user's actual bodies. Recent bodies may embed larger previews. This single command decides whether option (a) is sufficient.

### Options compared

| | (a) exiftool embedded preview *(status quo, extended)* | (b) LibRaw / `dcraw_emu` full decode | (c) ImageMagick delegate | (d) sharp/libvips native |
|---|---|---|---|---|
| **Already in the image?** | ✅ `backend/Dockerfile:85` | ❌ needs `apk add libraw-tools` (~2–4 MB) | ❌ large (~30–60 MB + delegates) | ❌ requires rebuilding libvips |
| **Code change** | reorder tags, add floor/timeout in `imageProcessor.js:40-67` | swap the subprocess inside `extractRawPreview` — same contract | new subprocess + policy XML hardening | env var only: `SHARP_FORCE_GLOBAL_LIBVIPS=1` + system libvips |
| **Quality** | capped at ~1616×1080 for Sony | **full sensor resolution**, real demosaic | full resolution | full resolution |
| **CPU / photo** | ~50–150 ms (2 spawns today, 1 after reorder) | ~1 s (libvips' own benchmark; "most time is spent in dcraw") | ≥ (b), plus IM overhead | ~1 s, same libraw underneath |
| **Memory** | small JPEG buffer; `maxBuffer: 256 MB` ceiling at `imageProcessor.js:51` | full RGB frame (~360 MB for 61 MP × 16-bit) | worst | full RGB frame |
| **Correctness risk** | preview may be un-rotated / AdobeRGB (§8) | correct colour + orientation from the RAW | delegate-chain fragility | ships correct, but **not compiled in** |
| **Security surface** | exiftool parses attacker bytes (CVE-2021-22204 class) | libraw parses attacker bytes (its own CVE history) | largest historical CVE surface | libraw, in-process (worse blast radius) |
| **Maintenance** | ✅ already upstream; patch is upstreamable | 1 new Alpine package, one function body | heavy | **not viable**: sharp 0.35.3 bundles libvips 8.18.5 with `dcrawload` compiled *out* — `sharp-libvips`' `versions.properties` has no `VERSION_LIBRAW`; `meson_options.txt` declares `option('raw', ..., value: 'auto')`, which silently disables when libraw is absent. Would require a custom global libvips build |

### ✅ RECOMMENDATION

**Ship (a) as the default; add (b) behind a per-install opt-in later.**

1. **Phase 1 uses (a)** — extended, not replaced. It is already in the box, already upstream, already tested at the `isRawFilename` level, costs ~100 ms/photo, and is the only option that keeps this change upstreamable back to `PicPeak/picpeak`.
2. **Fix the three real defects in (a)** (Phase 1): reorder tags to `['-PreviewImage', '-JpgFromRaw', '-ThumbnailImage']` (halves spawns and matches the actual format landscape), add a **minimum long-edge floor** so a 160×120 thumbnail can never become the gallery source, and add `timeout` + `killSignal` to the `execFile` options at `imageProcessor.js:49-52`.
3. **Better still (Phase 1, low cost):** replace the blind loop with a *discovery* spawn — `exiftool -json -n -PreviewImageSize -JpgFromRawSize -ThumbnailImageSize -Orientation -ImageWidth -ImageHeight <file>` — pick the largest available preview, then one `-b` extraction. Deterministic 2 spawns, never selects a thumbnail by accident, and yields container `Orientation` and **true sensor dimensions** in the same call (fixing the "61 MP shown as 1.7 MP" bug).
4. **Reject (c) and (d) outright.** (c) is strictly worse than (b). (d) is not reachable without replacing sharp's bundled libvips — a deployment liability far out of proportion to the benefit.
5. **Defer (b) to Phase 4** as `RAW_DECODER=preview|libraw` (env or app setting). `dcraw_emu -w -T` writes a TIFF that `withProcessableImage` can return unchanged — a ~10-line change inside one function. **Constraint: full decode must be ingest-only.** The lazy gallery routes (`gallery.js:2156`, `:2257`, `:2359`) have **no concurrency limit** — the only `p-limit`s in the codebase are `fileWatcher.js:29` and `watermarkGeneratorService.js:32`, and `sharp.concurrency(2)` at `imageProcessor.js:16` caps libvips *threads*, not pipeline count. A 100-photo RAW gallery's first load would spawn ~100 concurrent decoders.

---

## 5. Data model

**No DDL is required for Phase 1.** `photos.media_type` is an unconstrained `VARCHAR(255) DEFAULT 'image'` (`backend/migrations/core/048_add_video_support.js:13-15`), `mime_type` is `VARCHAR(100)` (`core/039:74-76` — the definition that wins; `core/048`'s re-add is skipped by `addColumnIfNotExists`). A RAW row stores fine as `media_type='image'` today.

### The video precedent, and why not to copy it exactly

`core/048_add_video_support.js` is the template: it added a `media_type` discriminator defaulting to `'image'`, format-specific columns (`duration`, `video_codec`, `audio_codec`), `width`/`height`, then backfilled (`:48-55`).

**Do NOT introduce `media_type = 'raw'`.** The codebase encodes *"not video"* as a proxy for *"sharp can decode this"*, in at least six places:

- `backend/src/routes/adminPhotoDimensions.js:30`, `:125`, `:132`
- `backend/src/routes/adminThumbnails.js:208`
- `backend/migrations/core/096_backfill_photo_dimensions_v2.js:44-47`
- `backend/src/routes/gallery.js:1001`, `:1012`
- `backend/src/services/downloadRendition.js:24-26`

A `'raw'` value still satisfies `media_type != 'video'`, so it fixes nothing and quietly widens the blast radius. Additional friction: `frontend/src/types/index.ts:152` declares `media_type?: 'photo' | 'video' | 'image'` while `photos.service.ts:17,32` declares `'photo' | 'video'` — the vocabulary is already inconsistent.

### Recommended shape

| Phase | Change | Rationale |
|---|---|---|
| 1 | **None.** Detect RAW via `isRawFilename(photo.original_filename \|\| photo.filename)` server-side | Single source of truth already exists at `imageProcessor.js:22-31` |
| 1 | Add a **server-computed** `is_raw: boolean` to the gallery payload (`gallery.js:984-1053`) and to `frontend/src/types/index.ts:116-174` | Client-side extension sniffing is fragile: `original_filename` is NULL for pre-`core/062` rows and `filename` is a sanitised generated name |
| 3 | `photos.preview_source VARCHAR(16)` (`'native'` \| `'embedded'` \| `'demosaic'`) | Distinguishes "preview from real pixels" from "preview from an embedded thumbnail" — needed once (b) exists and for honest UI labelling |
| 3 | Widen `photos.size_bytes` from `integer` (`backend/src/database/db.js:284` — 2.14 GB cap on Postgres) to `bigInteger` | Not a RAW blocker; cheap correctness fix if a migration is being written anyway |

### Migration mechanics (if/when one is written)

- Must live in `backend/migrations/core/` with a **3-digit prefix**; the runner filters `/^\d{3}_.*\.js$/` (`backend/migrations/run-migrations.js:120`) and tracks by **basename** (`migrations.filename UNIQUE`). Highest existing is `176_gallery_info_banner.js` → use `177_*`. Do not duplicate a number (`core/` already has three `061_*`, two `062_*`, two `074_*` whose order is `readdir`-dependent).
- **SQLite migrations are not transactional** (`run-migrations.js:35-43`) — every step must be independently idempotent via `addColumnIfNotExists`. `run-migrations-safe.js:138-143` swallows `already exists` errors and marks the migration applied, so a half-applied migration's second half never runs.
- `app_settings.setting_value` is a knex `.json()` column (`db.js:480-486`); **always `JSON.stringify()`** — a bare string is rejected by Postgres' json type. Copy the row shape from `core/104:36-43`.
- Neither `general_allowed_file_types` nor `general_max_file_size_mb` has a seeded row anywhere (verified: zero references across `backend/migrations/**`; no `backend/seeds/`). Both fall through to code defaults.

---

## 6. Implementation plan

### Phase 1 — Sony ARW: upload → thumbnail → display → download *(minimum viable, independently shippable)*

**Scope decision:** map **all TIFF-container RAW** (`arw sr2 srf cr2 nef nrw orf pef srw 3fr dcr kdc dng`) in one pass since they share the `II*\0` magic, and defer `cr3` (ISO-BMFF), `raf` (`FUJIFILM`), `rw2` (`IIU\0`) to Phase 2 where they need distinct signatures.

| # | File | Change |
|---|---|---|
| 1 | `backend/src/services/uploadSettings.js:21-42` | Add RAW entries: `'arw': 'image/x-sony-arw'`, `'sr2': 'image/x-sony-sr2'`, `'srf': 'image/x-sony-srf'`, `'cr2': 'image/x-canon-cr2'`, `'nef': 'image/x-nikon-nef'`, `'nrw': 'image/x-nikon-nrw'`, `'orf': 'image/x-olympus-orf'`, `'pef': 'image/x-pentax-pef'`, `'srw': 'image/x-samsung-srw'`. One `key: 'mime',` per line (see #3) |
| 2 | `backend/src/services/uploadSettings.js:177-183` | Add `logger.warn` for extensions not in the map — kill the silent-drop failure mode |
| 3 | `frontend/src/utils/fileTypes.ts:4-20` | **Byte-identical mirror.** CI-enforced by `backend/__tests__/services/uploadSettingsFileTypes.test.js:48-50`. The parser regex is `/^'?(\w+)'?\s*:\s*'([^']+)'\s*,?\s*(?:\/\/.*)?$/` (`:32`) and **throws** on anything else — no double quotes, no computed keys, no two-pairs-per-line, no block comments inside the map |
| 4 | `backend/src/utils/fileSecurityUtils.js:51-116` | Add one `ALLOWED_IMAGE_TYPES` entry per new MIME, each with `extensions: ['.arw']` and **exactly one** magic `{ offset: 0, bytes: [0x49,0x49,0x2A,0x00] }`. **`:202` uses `.every`** — multiple entries are ANDed; listing both endiannesses is unsatisfiable (documented at `:107-111`) |
| 5 | **`backend/src/utils/fileSecurityUtils.js:159-175`** | **The load-bearing change.** Make `validateFileType` extension-first *scoped to the extension*: when `mimetype` is `''` or `application/octet-stream`, resolve the expected MIME from `path.extname(filename)` via `EXTENSION_TO_MIME` and test **that** against `allowedTypes`. Must **not** blanket-accept octet-stream — `publicTransferUpload.js` is unauthenticated and shares this function. Pass the *resolved* MIME to `validateFileContent` |
| 6 | `frontend/src/utils/fileTypes.ts:47-53` (`extensionsToAcceptString`) | Emit dotted extension tokens alongside MIME: `'image/jpeg,.jpg,.jpeg,.arw,.cr2'`. MIME-only `accept` **cannot** match a file the OS has no MIME for |
| 7 | `frontend/src/components/admin/PhotoUpload.tsx:138-139` | Accept when `allowedMimeTypes.includes(file.type)` **OR** the lowercased extension is in the configured set. Replace the silent `return` with a toast naming the skipped files |
| 8 | `frontend/src/components/gallery/UserPhotoUpload.tsx:73-77` | Same extension fallback; move the hardcoded English string to an i18n key |
| 9 | **`backend/src/routes/gallery.js:71-72`** | Replace both hand-maintained sets with `RAW_EXTENSIONS` imported from `imageProcessor` ∪ `{heic, heif}`, plus the RAW MIMEs. Without this, uploads succeed and the client lightbox still shows a broken image |
| 10 | `backend/src/services/imageProcessor.js:40-67` | (a) Reorder to `['-PreviewImage','-JpgFromRaw','-ThumbnailImage']` — or replace with the single `-json` discovery probe (§4.3). (b) Add a minimum-long-edge floor at `:57`. (c) Add `timeout: 30000, killSignal: 'SIGKILL'` to `:49-52` and lower `maxBuffer` to ~64 MB. (d) Apply container `Orientation` to the extracted preview |
| 11 | `backend/src/services/imageProcessor.js:786-789` | Add `isRawFilename` to the existing `heif/heic` early-return in `resizeToBox` — same precedent, same reasoning as the comment at `:780-787` |
| 12 | `backend/src/services/downloadRendition.js:37` | `const wantsResize = !!box && !isVideo(photo) && !isRawFilename(photo.original_filename \|\| photo.filename);` — makes the currently-accidental "RAW ships as stored" behaviour explicit and stops reading 55 MB into a Buffer for nothing |
| 13 | `backend/src/routes/adminThumbnails.js:165` + `backend/scripts/regenerate-square-thumbnails.js:71` | Wrap in `withProcessableImage` with `try/finally` cleanup, mirroring `imageProcessor.js:369-376`. **Must ship in Phase 1** — otherwise the first admin who clicks "Regenerate all thumbnails" destroys every working RAW thumbnail |
| 14 | `backend/src/routes/gallery.js:1257`, `:1269`; `backend/src/routes/secureImages.js:439`; `backend/src/routes/protectedImages.js:173` | Replace `photo.mime_type \|\| 'image/jpeg'` with a shared `mimeForPhoto(photo)` helper (extension-derived, unknown → `application/octet-stream`), matching what `adminPhotos.js:961`/`:978` already do |
| 15 | `frontend/src/components/common/AuthenticatedImage.tsx:296` and `frontend/src/components/admin/AdminAuthenticatedImage.tsx:78` | Add `onError` → swap to `fallbackSrc`, then to an explicit placeholder. **Neither has one today** — the fetch returns HTTP 200 and the `<img>` silently fails to decode. Required regardless of RAW: it is the only thing between a bad derivative and a mysteriously blank gallery |
| 16 | `backend/src/routes/adminSettings.js:1459-1462` | Call `clearAllowedTypesCache()` (exported at `uploadSettings.js:224`, **currently zero callers**) alongside the other two, or an admin who adds `arw` sees rejections for up to `CACHE_TTL_MS = 60_000` |
| 17 | Docs | `SIMPLE_SETUP.md:221` — raise documented `client_max_body_size 100M` → `1G`. `nginx/nginx.conf` — add `client_max_body_size 2G;` (currently absent → nginx default **1m**) |

**New settings keys:** none. RAW is opt-in through the existing `general_allowed_file_types` free-text field (`frontend/src/features/settings/tabs/GeneralTab.tsx:198-203`), which already saves arbitrary strings verbatim (`useSettingsState.ts:318-325`).
**Migrations:** none.

**Acceptance criteria (Phase 1):**
1. Admin sets `general_allowed_file_types = jpg,jpeg,png,webp,arw` and `general_max_file_size_mb = 200`; the Settings save takes effect within one request (no 60 s cache wait).
2. `.ARW` files are **selectable** in the OS picker on macOS, Windows and Linux, and are **not** silently dropped on drag-drop.
3. A 55 MB `DSC01234.ARW` uploads via the admin UI, reaches `processing_status='complete'`, and has a non-NULL `thumbnail_path`.
4. The client gallery shows a correct thumbnail tile and a correct (not broken, correctly oriented) lightbox image with **`lightbox_preview_enabled` left at its default of `false`**.
5. `GET /api/gallery/:slug/download/:id` returns the **original ARW bytes**, `Content-Disposition` filename ends in `.ARW`, `Content-Type` is not `image/jpeg`.
6. "Download all" ZIP contains the original ARW bytes at the right filename.
7. Clicking admin → "Regenerate all thumbnails" leaves RAW thumbnails intact.
8. A non-RAW binary renamed `evil.arw` is rejected (magic-number check) with a 400.
9. `npx jest` and `npx vitest run` pass, including the frontend/backend map-parity test.

---

### Phase 2 — Ingest parity + the DNG data-loss bug

*Independently shippable; makes every other entry point behave like Phase 1's.*

| File | Change |
|---|---|
| `backend/src/services/fileWatcher.js:79` | Replace the hardcoded array with a shared `isAcceptedMediaFilename()` predicate (union of configured extensions + `RAW_EXTENSIONS`). **Do not ship without the next two rows.** |
| `fileWatcher.js:100`, `:114` | Import `withProcessableImage`; generate thumbnail *and* read dimensions from the same `proc.path`, one extraction |
| `fileWatcher.js:105`, `:134-143` | Resolve `mime_type` through the RAW map instead of the `image/jpeg` lie; add `media_type`, `source_origin: 'managed'`, `original_filename`, and an explicit `processing_status` |
| **`backend/src/routes/adminArchives.js:233`** | Replace `/\.(jpg\|jpeg\|png\|gif\|webp)$/i` with the shared predicate, or drive re-registration off `photos_manifest.json` (already written by `archiveService.js:47-53`, read at `adminArchives.js:206-224`). **This is losing DNG data today, before any Sony work.** Pair with an orphan-reconciliation script |
| `adminArchives.js:293` | Adjacent bug: `type: path.extname(filename).substring(1)` writes `'jpg'`/`'arw'` into a column that is `'individual'`/`'collage'` everywhere else. Fix **before** widening the regex |
| `backend/src/services/externalMediaService.js:77`; `adminExternalMedia.js:41`, `:67` | Collapse three duplicated arrays into one shared predicate |
| `adminExternalMedia.js:121`, `:159` | Wrap both in `withProcessableImage` |
| **`backend/src/services/imageProcessor.js:358`** | Wrap the external/reference branch of `ensureThumbnail` in `withProcessableImage` — mirror `:369-376`. Without this, reference-mode RAW can never have a thumbnail |
| `backend/src/services/s3AutoImporter.js:98-101` | `const isImage = mimeType.startsWith('image/') \|\| isRawFilename(filename);` — closes the "S3 admits DNG, local doesn't" inconsistency |
| `s3AutoImporter.js:112` | Wrap in `withProcessableImage` inside the existing `withLocalCopy` |
| `backend/src/routes/v1/events.js:61-64`, `:661`, `:668` | Tighten the filter to the shared predicate (it is currently a bypass); wrap both sharp calls in `withProcessableImage`, or route v1 through `queueFilesForProcessing` |
| `backend/src/routes/adminPhotoDimensions.js:86` | Read true dimensions from exiftool/exifr rather than sharp — gives the **real** RAW dimensions, not the preview's |
| `backend/src/utils/fileSecurityUtils.js:196` + magic entries | Widen the read from 20 to 64 bytes; add `cr3` (`ftyp` @ offset 4), `raf` (ASCII `FUJIFILM` @ 0), `rw2` (`0x49 0x49 0x55 0x00`), `orf` (`IIRO`). If any format needs alternates, restructure `:202` from `.every` to `.some`-over-alternatives |
| `backend/src/utils/fileSecurityUtils.js` | Fix the pre-existing bug: `image/tiff`, `application/pdf`, `application/zip` are advertised by both transfer routes but have no `ALLOWED_MEDIA_TYPES` entry, so they always reject |
| `backend/src/services/backupManifest.js:361-377` | `getFileType()` classifies RAW as `'other'`; add the RAW extensions |

**Acceptance:** an ARW dropped into `storage/events/active/<slug>/individual/` appears with a correct thumbnail; an external NAS RAW folder lists and imports with thumbnails; archive→restore round-trips a DNG *and* an ARW with its `photos` row intact; S3 auto-import and the local watcher agree.

---

### Phase 3 — Client delivery UX

See §7 for the design. Files: `backend/src/utils/downloadResolutions.js` (choices + `parseResolution`), `backend/src/services/downloadRendition.js`, `backend/src/services/downloadZipService.js:43-45` (cache key), `backend/src/services/downloadJobService.js:91-103` (dedup hash), `frontend/src/components/gallery/DownloadResolutionModal.tsx`, plus a per-event `include_raw_in_downloads` column (migration `core/177`).

---

### Phase 4 — Quality & scale

- Optional **LibRaw full decode** behind `RAW_DECODER=preview|libraw`; `apk add libraw-tools`; swap the subprocess inside `extractRawPreview`. **Ingest-only.**
- **Cache the extracted preview once per photo** (e.g. a durable `rawpreview/<id>.jpg` derivative) and build thumbnail + hero + preview from that single artifact — collapses ~8 exiftool spawns to 1.
- **Eagerly generate all three renditions inside `processPhoto`** for RAW so guest requests never trigger extraction.
- Add a process-wide `p-limit` around `gallery.js:2156`/`:2257`/`:2359`.
- Skip `.download-cache/` in `archiveService.js:92` and in `backupService.js:466` `DEFAULT_EXCLUDE_PATTERNS`; call `downloadZipService.cleanup()` (currently **zero call sites**) on archive/delete.
- Boot-time `exiftool -ver` probe surfaced in `backend/src/routes/adminSystemHealth.js` (today nothing checks it; `imageProcessor.js:61-66` collapses "binary missing" and "no preview in this file" into one opaque message).
- Watermark RAW by routing `watermarkGeneratorService.js:67-69` through `withProcessableImage` so the *preview* carries the mark.
- Fix the three **fail-open** paths that ship un-processed bytes while reporting success: `watermarkService.js:225-231`, `secureImageService.js:281-285`, `imageProcessor.js:800-803`.

---

## 7. Client delivery UX — grounded in existing download code

### What already works

The delivery layer is **almost entirely format-agnostic**. No extension filter exists in any ZIP builder:

- `backend/src/services/downloadZipService.js:121-128` — selects `db('photos').where({event_id})` with only a visibility filter.
- `backend/src/services/downloadJobService.js:109-122` — adds only category/visibility.
- `backend/src/services/archiveService.js:92` — `storage.list(eventPrefix)`, no filter.
- `backend/src/services/downloadFilenameService.js:80-108` — preserves `original_filename` including `.ARW`; `buildContentDisposition` emits RFC 5987 so unicode camera filenames survive.
- `backend/src/utils/xmpGenerator.js:160-162` — `getXmpFilename` strips any extension → produces the correct Lightroom sidecar name for `.ARW`.

**So once a RAW row exists with a resolvable key, "Download all", "Download selected" and per-photo download already ship the real bytes.**

### The extension point for a RAW-vs-JPEG choice

`backend/src/utils/downloadResolutions.js` is already the right shape:

- `parseResolution(id)` (`:44-52`) returns `null` for anything that isn't `WxH` — and `null` already means *"serve the stored bytes."*
- `pickRequestedResolution(policy, requested)` (`:161-166`) validates a free-form string id against `policy.choices`.
- `choices` is published to the gallery payload (`gallery.js:927-931`) and rendered by `DownloadResolutionModal.tsx`.
- `downloadJobService.js:91-103` already hashes `resolution` into its dedup key.

**A `raw` / `jpeg` pseudo-choice flows end-to-end with no protocol change.** Required work:

1. Add `{ id: 'raw', label: 'Original RAW (.ARW)' }` to `resolveEventDownloadPolicy().choices`, gated on a new per-event `include_raw_in_downloads` flag **and** on the gallery actually containing RAW.
2. Teach `renderPhotoForDownload` (`downloadRendition.js:36-53`) which source each id maps to. `'raw'` → `return null` (stream stored bytes). `'jpeg'` → serve the generated preview/hero derivative.
3. **Give the RAW bundle its own cache key.** `downloadZipService.js:43-45` uses a *fixed* path per event (`events/active/{slug}/.download-cache/all.zip`) — a RAW variant would overwrite the JPEG one. Either add a suffix or force RAW bundles down the `download_jobs` path, which already keys on `resolution`.

### Recommended UX

| Surface | Design | Anchor |
|---|---|---|
| **Per-event toggle** | "Include RAW originals in client downloads" (default **off**). When off, RAW photos still display; the download button serves the JPEG derivative | new `events.include_raw_in_downloads` |
| **Per-photo download** | When RAW is on, the hover button's `aria-label`/tooltip names the real payload: `Download original (.ARW, 45 MB)` using the existing `photo.size` | `frontend/src/components/gallery/PhotoCard.tsx:355-368` |
| **Lightbox** | Label the filename line `RAW · preview` and add an info tooltip on the download button. **Important**: the zoom control goes to 300% (`PhotoLightbox.tsx:788-817`) on a ≤1616px derivative from a 61 MP file — without a label, clients will report "the photos are low quality" | `PhotoLightbox.tsx:777-784`, `:821-829` |
| **Bulk choice** | Reuse `DownloadResolutionModal`: `Original RAW` / `Full-size JPEG` / `2048px` / `Web` | `DownloadResolutionModal.tsx:159-190` |
| **Size warning** | Show estimated archive size before the client commits. 500 ARW ≈ 25–60 GB | `gallery.js:1562`, `:1736` currently cap at 500 photos with **no byte cap** |
| **Force the safe transport** | `frontend/src/services/gallery.service.ts:240-243` and `:272-275` use `responseType: 'blob'` and materialise the whole archive **in tab memory** — a 50-photo ARW selection (~3 GB) kills the tab. Only the pre-zip path (`:227-237`) and download-job path (`:310-317`) use native `<a href>` navigation. RAW bundles **must** be routed to those |
| **XMP sidecars** | `photoExportService` exports XMP as a *separate* ZIP; nothing pairs `.xmp` with its `.arw` inside a photo archive. For a Lightroom workflow that pairing is arguably the point | `xmpGenerator.js:160-162`, `downloadZipService.js` |
| **iOS** | Skip the Web Share branch for RAW — `gallery.service.ts:117-119` wraps the blob in `new File([...], {type: blob.type \|\| 'image/jpeg'})`; iOS Photos cannot ingest an ARW | `gallery.service.ts:101-139` |
| **Interim answer, available today** | **PicTransfer's client-facing upload page has no client-side type gate at all** — `frontend/src/pages/public/TransferUploadPage.tsx:73-80`, `:138-144` (no `accept` attribute). The *server* side is closed (`adminTransfers.js:35`), but this is the surface closest to "deliver RAW to clients" and the cheapest to open | — |

---

## 8. Risks & mitigations

### 8.1 Every upload size ceiling in the codebase

| Layer | FILE:LINE | Value | Blocks a 55 MB ARW? | 120 MB? |
|---|---|---|---|---|
| Frontend nginx (**ships**) | `frontend/nginx.conf:24`, `:108` | `client_max_body_size 1G` | no | no |
| Optional prod nginx | `nginx/nginx.conf` — **directive absent** | nginx default **1m** | **YES** | **YES** |
| Documented external proxy | `SIMPLE_SETUP.md:221` | `client_max_body_size 100M` | no | **YES** |
| Express JSON/urlencoded | `backend/server.js:458-459` | `limit: '50mb'` | **no** — does not apply to multipart | no |
| **CSRF content-type gate** | `backend/server.js:463-471` | 415 unless JSON or multipart | not size, but **kills chunked upload** | same |
| Admin multipart | `backend/src/routes/adminPhotos.js:69-70` | hardcoded 10 GB, ignores the setting | no | no |
| Guest gallery | `gallery.js:2518-2528` ← `uploadSettings.js:11` | `DEFAULT_MAX_FILE_SIZE_MB = 50` | **YES (default)** | **YES** |
| Settings ceiling | `uploadSettings.js:12` | `MAX_ALLOWED_FILE_SIZE_MB = 10 * 1024` | — | — |
| Public API v1 | `backend/src/routes/v1/events.js:60` | hardcoded 100 MB | no | **YES** |
| Chunked init | `adminPhotos.js:1340-1343` | 10 GB | no | no |
| Transfers (both routes) | `adminTransfers.js:66`, `publicTransferUpload.js:135` | `transfer_max_upload_size_mb`, default 50 | **YES** | **YES** |
| Frontend chunk batching | `PhotoUpload.tsx:225`, `:234-235` | `MAX_BYTES_PER_CHUNK` default 95 MB, but `&& currentChunk.length > 0` lets a **single oversize file form its own chunk** | no | **YES** — one 120 MB POST |
| Settings UI input | `GeneralTab.tsx:143-144` | `min="1" max="500"` | no | no |
| `photos.size_bytes` | `backend/src/database/db.js:284` | `integer` → 2.14 GB on Postgres | no | no |

**Mitigation:** document raising `general_max_file_size_mb` to ~200 as a prerequisite; add `client_max_body_size 2G` to `nginx/nginx.conf`; correct `SIMPLE_SETUP.md:221`; fix the single-file chunk bypass at `PhotoUpload.tsx:234-235`.

### 8.2 Storage growth

Per photo PicPeak stores: original + thumbnail + hero (1920px) + preview (1920px) + optional pre-generated watermark + a cached `.download-cache/all.zip` + any download-job artifacts. `LocalFsStorage.list()` (`LocalFsStorage.js:132-174`) filters only in-flight staging files, so:

- `archiveService.js:92` **embeds the download cache inside the archive** — doubling it.
- `backupService.js:466` `DEFAULT_EXCLUDE_PATTERNS = ['.nfs*', '.DS_Store', 'Thumbs.db']` — no dot-directory exclusion, and `events/active` is a default backup target (`:439`). So a RAW gallery is stored roughly **3×**.
- `downloadZipService.cleanup(eventId)` (`downloadZipService.js:300`), documented as "used on event deletion/archival", has **zero call sites**.

`SIMPLE_SETUP.md:62` ("2GB for application + space for photos") is the only sizing guidance in the repo and is written for JPEG. A 500-shot Sony wedding is 25–60 GB of originals alone.

### 8.3 exiftool subprocess safety

**Settled — argument injection is NOT a risk.** `imageProcessor.js:49-52` uses `execFileAsync('exiftool', ['-b', tag, rawPath], …)` — `execFile`, no shell, no interpolation — and every `rawPath` is absolute (multer temp under `getStoragePath()`, or `storage.resolveLocalPath()`, or an `os.tmpdir()` copy). An absolute path can never be read as an option flag. `chunkedUploadService.js:38` already basenames client filenames.

**Real risks:**

| Risk | Anchor | Mitigation |
|---|---|---|
| No timeout / killSignal | `imageProcessor.js:49-52` | A wedged exiftool holds a worker slot for `UPLOAD_PROCESSOR_STUCK_TIMEOUT_MS` (default 600 000, `backgroundProcessor.js:65`), then the janitor at `:157-175` resets the row to `'pending'` and another worker wedges on the same file — **unbounded retry loop** that can stall all uploads (`CONCURRENCY` defaults to 1 on <3 GB hosts, `backgroundProcessor.js:48-64`). Add `timeout: 30000, killSignal: 'SIGKILL'` |
| 256 MB `maxBuffer` × N | `imageProcessor.js:51` | Lower to ~64 MB; stream to disk |
| Unbounded concurrency | `gallery.js:2156`, `:2257`, `:2359` — no p-limit | ~100 concurrent exiftool spawns on first load of a 100-photo RAW gallery. Add a shared p-limit + preview caching |
| Content parsing (CVE-2021-22204 class) | exiftool is **unpinned** at `backend/Dockerfile:85` | Add a lower bound; add `docker exec … exiftool -ver` to `.github/workflows/install-smoke.yml` (currently no such check) |
| Failure ⇒ photo invisible | `photoProcessor.js:517` throw → `backgroundProcessor.js:138-147` sets `'failed'` → `gallery.js:373`/`:652` hide it | Degrade like video does (`photoProcessor.js:488-501` uses `generateVideoPlaceholder`): mark `'complete'` with a RAW placeholder rather than `'failed'` |

### 8.4 Magic-number ambiguity across TIFF-based RAW

`validateFileContent` reads **20 bytes** (`fileSecurityUtils.js:196`). ARW, CR2, NEF, ORF, PEF, SRW, 3FR, DCR, KDC and DNG all begin `II*\0`. So any RAW entry added here means *"is a little-endian TIFF"*, nothing more — an ARW is indistinguishable from a DNG or a plain TIFF at offset 0.

- **Do not copy-paste the DNG magic to every format.** RW2 is `II U\0` (`0x49 0x49 0x55 0x00`), ORF is `IIRO`/`IIRS`, RAF is ASCII `FUJIFILM`, CR3 is ISO-BMFF `ftyp` @ offset 4. A blanket TIFF entry silently rejects four of the 17 declared extensions with the confusing "File content does not match declared type".
- **`.every` at `:202` ANDs the entries** — the DNG comment at `:107-111` documents this trap. Listing both endiannesses is unsatisfiable.
- **The real content gatekeeper is sharp**, not the magic check: `imageProcessor.js:55-58` only accepts exiftool's output if `sharp(outPath).metadata()` yields width and height. That validates the *extracted preview*, never the stored original.
- Note the adjacent hole: `'image/svg+xml'` has `magicNumbers: null` (`fileSecurityUtils.js:78-82`) and `:190-192` returns `true` for any such entry. **Do not use `magicNumbers: null` for RAW formats whose signature sits past byte 20** — widen the read instead.

### 8.5 Orientation, colour, and metadata (unverified — test before shipping)

- **No rendition generator applies orientation.** A grep for `.rotate(` in `imageProcessor.js` returns exactly one hit — line 773, inside `resizeToBox` (the *download* path). `generateThumbnail` (`:218-231`), `generateHeroImage` (`:463-476`) and `generatePreviewImage` (`:604-611`) never rotate. This matters more for RAW than JPEG: the ARW preview is carved out of IFD0 with `-b`, and the authoritative `Orientation` (EXIF 0x0112) lives in the parent container. **If Sony's embedded preview carries no APP1 orientation, every portrait ARW renders sideways.** One real file settles it.
- **`withMetadata(false)` at three sites is likely inverted.** `imageProcessor.js:224-225`, `:469-470`, `:604-607` comment "Strip EXIF/metadata … privacy: prevent GPS leak" but sharp's `withMetadata()` documented behaviour is to **keep** metadata (stripping is the default when you call nothing, and there is no boolean form). If so these calls *leak* EXIF/GPS into every derivative while accidentally rescuing orientation. **Verify before "fixing" orientation — the two interact.**
- **AdobeRGB previews.** Sony writes the embedded preview in the camera's configured colour space. Nothing in the pipeline does an ICC transform (no `.toColourspace()`, no `.withIccProfile()`). AdobeRGB pixels served as sRGB look visibly flat — a RAW-specific bug that never appears with Lightroom-exported JPEGs.
- **exifr chunked reads.** `exifr.parse` (`imageProcessor.js:703`) defaults to `chunked: true` with a ~64 KB window. Sony MakerNotes are large; if the ExifIFD pointer lands past the window, `captured_at` is silently NULL (swallowed at `:733-735`, debug-level). Pass `{ chunked: false }` for RAW sources.
- **exifr *does* handle ARW** — it dispatches on the first two bytes (`0x4949`/`0x4D4D`), not on extension, so `.arw` with an empty MIME still parses. It will **not** handle CR3 (`ftyp`) or RAF (`FUJIFILM`).

### 8.6 Fail-open paths that report success

| Path | FILE:LINE | Behaviour on RAW |
|---|---|---|
| Watermarking | `watermarkService.js:225-231` | Returns the **un-watermarked original**. A photographer relying on watermarks to protect proofs ships clean full-resolution RAW while the UI says "watermarked" |
| Protected images | `secureImageService.js:281-285` | Every protection level above `basic` silently does nothing |
| Download resize | `imageProcessor.js:800-803` | `#858` resolution capping is a silent no-op; 55 MB was read into memory for nothing |

Worse: if libvips' `tiffload` *does* open an ARW, `imageProcessor.js:796-798` and `watermarkService.js:210` fall to the `else` branch and emit **JPEG bytes under a `.arw` filename with a RAW MIME** — a file no RAW converter can open. The HEIC escape hatch at `imageProcessor.js:786-789` exists for exactly this reason and has no RAW equivalent. **This needs an empirical check against the pinned `"sharp": "0.35.3"` (`backend/package.json:64`).**

---

## 9. Testing strategy

### Harnesses

| Suite | Config | Runs in CI? |
|---|---|---|
| Backend Jest | `backend/jest.config.js`, `testTimeout: 120000` | ✅ `.github/workflows/tests.yml:90-92` |
| Frontend Vitest | `frontend/vite.config.ts:33` | ✅ same workflow |
| Playwright E2E | `playwright.config.ts:8`, `testDir: 'tests/e2e'` | ❌ **no E2E workflow exists** |
| Lint / i18n | `npm run lint`, `npm run i18n:ci` | ❌ **no lint workflow exists** |

### Tests that will break (all are in the CI run)

| Test | FILE:LINE | Why |
|---|---|---|
| Map parity | `backend/__tests__/services/uploadSettingsFileTypes.test.js:48-50` | `expect(getFrontendExtensionMap()).toEqual(EXTENSION_TO_MIME)` — **hard blocker.** Both maps must change in the same commit |
| Parser | same file, `:32` | Throws on any map line it can't parse. Keep entries as `arw: 'image/x-sony-arw',` one per line |
| RAW/HEIF fixture | same file, `:10-14`, `:41`, `:43-45` | `RAW_AND_HEIF_TYPES` must gain the new extensions; `:41`'s `toEqual` is order-sensitive, so insertion order must match `EXTENSION_TO_MIME` |
| exiftool-absent case | `backend/__tests__/services/imageProcessorRaw.test.js:44-49` | Asserts `withProcessableImage('/tmp/.../IMG_1234.dng', …)` **rejects**. Encodes the assumption that exiftool is absent in CI — installing it inverts this |
| Content-type pinning | `backend/__tests__/routes/adminPhotoContentType.test.js:217-230` | Does **not** break, but silently changes: `adminPhotos.js:1174-1175, 1209-1212` reads the same map, so adding `arw` flips the admin photo-view header to `image/x-sony-arw`, which the admin `<img>` cannot render. **Add explicit `.arw` cases** |
| Frontend defaults | `frontend/src/utils/__tests__/fileTypes.test.ts:16`, `:22`, `:28-29` | Break **only** if `DEFAULT_ALLOWED` is widened. **Recommendation: don't widen it** — keep RAW opt-in |
| Resize pass-through | `backend/__tests__/integration/downloadResolutions.test.js:251-255` | Already guarantees `resizeToBox` returns an undecodable input unchanged. Add an explicit `.arw` case so the guarantee is named |

### New coverage needed (currently **zero**)

- `backend/src/services/fileWatcher.js:79` — no test asserts its extension list. `fileWatcher.concurrency.test.js` only tests p-limit wiring and mocks `imageProcessor` entirely.
- `backend/src/middleware/uploadValidation.js` — no test file references it.
- `originalNeedsPreview` (`gallery.js:73-79`) — no test anywhere.
- `watermarkGeneratorService.js:67-69` RAW skip — only mocked, never asserted.
- `validateFileType`'s new extension-first branch — **this is the security validator the upstream maintainer explicitly refused to touch without tests.** Tests here are the price of upstreamability: empty MIME + `.arw` → accept; empty MIME + `.exe` → reject; `application/octet-stream` + `.arw` with wrong magic → reject.

### RAW fixtures without repo bloat

`test-assets/` holds only `img1.png` (212 B), `img2.png` (212 B), `test-video.mp4` (54 846 B). `video-test-data/` (`bear-320x240.mp4`, 14 bytes) is referenced by nothing — **do not model on it.** There is no RAW file anywhere in the repo.

**Recommended approach:**

1. **Synthesise at test time, don't commit.** Build a minimal little-endian TIFF container in a `beforeAll` (sharp can emit the JPEG payload; hand-write the IFD with `PreviewImageStart`/`Length`). ~2–5 KB, generated per run, zero repo growth. Exercises the extension gate, the magic-number check, and — with exiftool present — a real `-b -PreviewImage` round trip.
2. **Tier the suite.** Gate real-extraction tests behind a `which exiftool` check so the existing "fails cleanly without exiftool" case (`imageProcessorRaw.test.js:44-49`) stays valid on machines without it.
3. **Install exiftool in CI** with `apt-get install -y libimage-exiftool-perl` in the backend job of `.github/workflows/tests.yml`, and split the ENOENT case from the extraction case.
4. **Add `docker exec … exiftool -ver`** to `.github/workflows/install-smoke.yml` — the one job that runs the built image never verifies the binary today.
5. **One real `.ARW`, out of tree.** Keep it in a gitignored `test-assets/local/` for manual verification. It is the only way to answer the orientation, preview-resolution and colour-space questions.

> **PR size note:** a full end-to-end change touching `uploadSettings`, `fileSecurityUtils`, `fileWatcher`, `gallery.js`, `externalMediaService`, the frontend map, plus tests and docs comfortably exceeds the 300-line `LINE_LIMIT` in `.github/workflows/bypass-size-gate.yml:34`. The phasing above is partly designed around this.

---

## 10. Open questions for the user

1. ~~**What is the actual embedded preview resolution on your bodies?**~~ **ANSWERED 2026-09-11.**
   Sony **ILCE-7M5**, `DSC00632.ARW`: `PreviewImage` is 1616×1080 as predicted, but `JpgFromRaw`
   is **7008×4672 (32.7 MP)** off a 7168×5120 sensor, and `Orientation` is 8. Taking the largest
   embedded image gives a full-quality gallery with no upscaled hero, so **LibRaw is not
   required** and §4(b) stays optional.

   Two things this turned up that the analysis had backwards. `JpgFromRaw` **does** exist for
   ARW, so the recommended tag reorder would have been a twenty-fold quality regression; see the
   correction in §4. And the extracted preview carries **no EXIF whatsoever**, so the container's
   orientation has to be written onto it or every portrait RAW is sideways in the grid, the
   lightbox and the hero, with `photos.width/height` describing the landscape frame.

   Still open for other bodies: an older Sony (a7 II era) has no `JpgFromRaw` and is genuinely
   capped at 1616×1080. Anyone shooting one should re-run the probe.

2. **Gallery browsing of RAW, or download-only delivery?**
   (a) RAW photos appear in the client gallery with JPEG derivatives *and* a RAW download — everything in Phases 1–3. (b) RAW is a *download-only asset* with no gallery representation — dramatically cheaper: a `media_type` that bypasses the derivative pipeline entirely, and the quality ceiling stops mattering.

3. **Which delivery surface matters most — galleries or PicTransfer?**
   "Deliver RAW to clients" maps most naturally to the transfer routes (`adminTransfers.js`), which are gated by a *completely separate* setting (`transfer_upload_allowed_mime`) and a separate default list that is **already broken for PDF/ZIP/TIFF**. If transfers are the real need, that is a smaller, independent change — and the client-facing transfer *upload* page already has no client-side gate at all.

4. **Should clients get a RAW-vs-JPEG choice, or just RAW?**
   A choice needs a per-event toggle, new download-policy entries, and a second ZIP cache key. "RAW always included in the download-all bundle" is far simpler but means a client on a phone can accidentally start a 30 GB download.

5. **Should `.xmp` sidecars be paired with `.arw` inside download archives?**
   The generator is complete and format-agnostic (`xmpGenerator.js:160-162`), but nothing pairs a sidecar with its RAW inside a photo ZIP today. For a Lightroom-based Sony workflow this may be the whole point.

6. **What should happen when a RAW has no extractable preview?**
   Today: `processing_status='failed'` and the photo is **permanently invisible to guests** (`gallery.js:373`, `:652`), even though the original is safely stored and downloadable. Alternative: complete with a generic RAW placeholder thumbnail — the pattern already established for video (`photoProcessor.js:488-501`).

7. **Watermarking policy for RAW.** RAW originals can never carry a burned-in mark. Options: (a) watermark the *preview* only, RAW downloads ship clean (needs to be stated in the UI — today it is silent); (b) refuse RAW download when a watermark is mandated; (c) don't offer RAW on watermark-enabled events. Currently the system claims (a) but silently does nothing at all (`watermarkService.js:225-231`).

8. **Upstream or fork-local?**
   The fork is at the identical SHA as upstream `main` with a clean tree. If you want this upstreamable, Phase 1 must ship with unit tests for the `validateFileType` change (the maintainer's stated reason for deferring it: *"Extension-based acceptance for the RAW set is a sensible follow-up — I kept it out here to avoid changing the security validator's logic untested."*). Also note the upstream **`stable`** branch has no RAW code and no exiftool at all — confirm your deployment tracks `main`/beta.

9. **Which brands beyond Sony, and how soon?** Phase 1 covers all TIFF-container formats cheaply. Canon CR3, Fuji RAF and Panasonic RW2 need distinct magic signatures and a restructure of `fileSecurityUtils.js:202` from `.every` to `.some`-over-alternatives. Worth doing now, or Phase 2?

10. **Is the archive/restore DNG data-loss bug (`adminArchives.js:233`) already affecting you?** If any event containing DNG files has been archived and restored, those rows are already gone and the orphaned bytes are sitting in `events/active`. A forward fix does not recover them — that needs a reconciliation script.