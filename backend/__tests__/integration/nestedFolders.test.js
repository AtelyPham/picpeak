/**
 * Nested gallery folders (issue 1786) and folder requests.
 *
 *   - the tree service: path mapping (outer folder, FirstLook marker, depth),
 *     idempotent ensurePath that follows renames, cycle/depth refusals, and a
 *     delete that moves photos up instead of deleting them
 *   - POST /folders/resolve: creates with folders.manage, otherwise opens one
 *     request per missing path and parks the batch in the closest parent
 *   - approve / reject move (or leave) the parked photos
 *   - the guest payload carries every ancestor of a used folder, folder_id,
 *     and the inherited download restriction
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const express = require('express');
const request = require('supertest');

describe('nested folders', () => {
  let tmpDir; let db; let cleanup; let app; let eventId; let tree;
  let canManage = true;

  const idOf = (r) => Number(r[0]?.id ?? r[0]);

  beforeAll(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'picpeak-folders-'));
    process.env.NODE_ENV = 'test';
    process.env.TEST_DATABASE_PATH = path.join(tmpDir, 'data', 'test.db');
    process.env.JWT_SECRET = 'folders-test';
    await fs.promises.mkdir(path.dirname(process.env.TEST_DATABASE_PATH), { recursive: true });

    jest.resetModules();
    jest.doMock('../../src/middleware/auth', () => ({
      adminAuth: (req, _res, next) => { req.admin = { id: 1, username: 'tester' }; next(); },
    }));
    jest.doMock('../../src/middleware/permissions', () => ({
      requirePermission: (perms) => (_req, res, next) => {
        const list = Array.isArray(perms) ? perms : [perms];
        if (list.includes('folders.manage') && !canManage) return res.status(403).json({ error: 'Insufficient permissions' });
        return next();
      },
      userHasAllPermissions: async (_id, perms) => !perms.includes('folders.manage') || canManage,
    }));
    jest.doMock('../../src/middleware/ownership', () => ({
      requireEventOwnership: (_req, _res, next) => next(),
      canAccessEvent: () => true,
    }));

    ({ db, cleanup } = await require('./helpers/crmDb').bootCrmDb());
    tree = require('../../src/services/folderTreeService');

    eventId = idOf(await db('events').insert({
      slug: 'camp', event_type: 'other', event_name: 'Camp', event_date: '2026-07-03',
      host_email: 'h@example.com', admin_email: 'a@example.com', password_hash: 'x',
      share_link: '/gallery/camp/s', share_token: 'camp-share',
      expires_at: new Date(Date.now() + 30 * 864e5).toISOString(),
      is_active: 1, is_archived: 0, is_draft: 0, require_password: 0,
      created_at: new Date().toISOString(), folder_structure: 1,
    }).returning('id'));
    await db('admin_users').insert({ id: 1, username: 'tester', email: 't@example.com', password_hash: 'x' }).catch(() => {});

    app = express();
    app.use(express.json());
    app.use('/api/admin', require('../../src/routes/adminFolders'));
    app.use('/api/gallery', require('../../src/routes/gallery'));
  }, 180000);

  afterAll(async () => {
    if (cleanup) await cleanup();
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  beforeEach(async () => {
    canManage = true;
    await db('photos').where('event_id', eventId).del();
    await db('folder_requests').where('event_id', eventId).del();
    await db('photo_categories').where('event_id', eventId).del();
  });

  async function addPhoto(filename, columns = {}) {
    return idOf(await db('photos').insert({
      event_id: eventId, filename, path: `camp/${filename}`, type: 'individual',
      uploaded_at: new Date().toISOString(), processing_status: 'complete', ...columns,
    }).returning('id'));
  }

  describe('mapDirectories', () => {
    const kw = ['FirstLook', 'Sneak Peek'];

    it('drops a single outer folder and keeps the rest', () => {
      const { mapped, singleRoot } = tree.mapDirectories(['Export/Friday/A', 'Export/Saturday', 'Export'], { keywords: kw, skipOuter: true });
      expect(singleRoot).toBe('Export');
      expect(mapped['Export/Friday/A'].segments).toEqual(['Friday', 'A']);
      expect(mapped.Export.segments).toEqual([]);
    });

    it('treats a top-level folder whose name CONTAINS a keyword as the first-look marker', () => {
      const { mapped } = tree.mapDirectories(['Wedding (FirstLook)', 'Wedding_first-look/sub', 'Friday'], { keywords: kw });
      expect(mapped['Wedding (FirstLook)']).toEqual({ segments: [], firstLook: true });
      expect(mapped['Wedding_first-look/sub']).toEqual({ segments: [], firstLook: true });
      expect(mapped.Friday).toEqual({ segments: ['Friday'], firstLook: false });
    });

    it('only checks the keyword at the top level', () => {
      const { mapped } = tree.mapDirectories(['Friday/FirstLook', 'Saturday'], { keywords: kw });
      expect(mapped['Friday/FirstLook']).toEqual({ segments: ['Friday', 'FirstLook'], firstLook: false });
    });

    it('a single dropped root that matches is the marker even with skip_outer', () => {
      const { mapped } = tree.mapDirectories(['Wedding_FirstLook', 'Wedding_FirstLook/raw'], { keywords: kw, skipOuter: true });
      expect(mapped.Wedding_FirstLook.firstLook).toBe(true);
      expect(mapped['Wedding_FirstLook/raw'].firstLook).toBe(true);
    });

    it('folds paths deeper than three levels and skips hidden directories', () => {
      const { mapped } = tree.mapDirectories(['A/B/C/D/E', '.thumbnails', 'A/__MACOSX'], { keywords: kw });
      expect(mapped['A/B/C/D/E'].segments).toEqual(['A', 'B', 'C']);
      expect(mapped['.thumbnails'].segments).toBeNull();
      expect(mapped['A/__MACOSX'].segments).toBeNull();
    });
  });

  describe('tree service', () => {
    it('ensurePath is idempotent and follows a renamed folder through source_path', async () => {
      const first = await tree.ensurePath(eventId, ['Friday', 'Activity A']);
      expect(first.created).toHaveLength(2);
      const friday = (await tree.eventFolders(eventId)).find((f) => f.name === 'Friday');
      await tree.renameFolder(eventId, friday.id, 'Freitag');
      const again = await tree.ensurePath(eventId, ['Friday', 'Activity A']);
      expect(again).toMatchObject({ folderId: first.folderId, created: [], missingFrom: -1 });
      expect((await tree.eventFolders(eventId)).map((f) => f.name).sort()).toEqual(['Activity A', 'Freitag']);
    });

    it('gives same-named folders under different parents distinct slugs', async () => {
      await tree.ensurePath(eventId, ['Friday', 'Activity A']);
      await tree.ensurePath(eventId, ['Saturday', 'Activity A']);
      const slugs = (await tree.eventFolders(eventId)).filter((f) => f.name === 'Activity A').map((f) => f.slug);
      expect(new Set(slugs).size).toBe(2);
    });

    it('never creates below level 3 when a source_path match sits deeper than its path (review concern 2)', async () => {
      const { folderId: c } = await tree.ensurePath(eventId, ['X', 'Y', 'Z']);
      const a = (await tree.ensurePath(eventId, ['A'])).folderId;
      await tree.moveFolder(eventId, a, c === null ? null : (await tree.eventFolders(eventId)).find((f) => f.name === 'Y').id);
      // A now sits at level 3; an upload of A/B/C must fold into A.
      const r = await tree.ensurePath(eventId, ['A', 'B', 'C']);
      expect(r.folderId).toBe(a);
      expect((await tree.eventFolders(eventId)).map((f) => f.name).sort()).toEqual(['A', 'X', 'Y', 'Z']);
    });

    it('treats decomposed and composed names as one folder (NFC)', async () => {
      const composed = await tree.ensurePath(eventId, ['Fr\u00e4ulein']);
      const decomposed = await tree.ensurePath(eventId, ['Fra\u0308ulein']);
      expect(decomposed.folderId).toBe(composed.folderId);
    });

    it('refuses cycles and a fourth level', async () => {
      const { folderId: c } = await tree.ensurePath(eventId, ['A', 'B', 'C']);
      const a = (await tree.eventFolders(eventId)).find((f) => f.name === 'A');
      await expect(tree.moveFolder(eventId, a.id, c)).rejects.toMatchObject({ code: 'FOLDER_CYCLE' });
      await expect(tree.createFolder(eventId, { name: 'D', parentId: c })).rejects.toMatchObject({ code: 'FOLDER_TOO_DEEP' });
    });

    it('deleting a folder moves its photos and subfolders up, never deleting a photo', async () => {
      const { folderId: leaf } = await tree.ensurePath(eventId, ['Saturday', 'Activity B', 'Part 1']);
      const folders = await tree.eventFolders(eventId);
      const mid = folders.find((f) => f.name === 'Activity B');
      const top = folders.find((f) => f.name === 'Saturday');
      const inMid = await addPhoto('mid.jpg', { folder_id: mid.id });
      await tree.deleteFolder(eventId, mid.id);
      expect((await db('photos').where('id', inMid).first()).folder_id).toBe(Number(top.id));
      expect((await db('photo_categories').where('id', leaf).first()).parent_id).toBe(Number(top.id));
    });

    it('inherits a download restriction to everything below', async () => {
      await tree.ensurePath(eventId, ['Saturday', 'Activity B', 'Part 1']);
      const sat = (await tree.eventFolders(eventId)).find((f) => f.name === 'Saturday');
      await db('photo_categories').where('id', sat.id).update({ allow_downloads: 0 });
      const blocked = await tree.downloadBlockedFolderIds(eventId);
      expect(blocked).toHaveLength(3);
    });
  });

  describe('POST /folders/resolve', () => {
    const resolve = (body) => request(app).post(`/api/admin/events/${eventId}/folders/resolve`).send(body);

    it('dry run reports per level without writing anything', async () => {
      await tree.ensurePath(eventId, ['Friday']);
      const res = await resolve({ paths: ['Export/Friday/A', 'Export/FirstLook'], skip_outer: true, dry_run: true });
      expect(res.status).toBe(200);
      expect(res.body.nodes).toEqual({ Friday: 'exists', 'Friday/A': 'new' });
      expect(res.body.results['Export/FirstLook']).toMatchObject({ first_look: true, status: 'root' });
      expect(Number((await db('photo_categories').where('event_id', eventId).count('id as c').first()).c)).toBe(1);
    });

    it('creates missing folders for a role with folders.manage', async () => {
      const res = await resolve({ paths: ['Saturday/Activity B/Part 1'] });
      expect(res.body.results['Saturday/Activity B/Part 1'].status).toBe('created');
      expect(await tree.folderTree(eventId)).toHaveLength(3);
    });

    it('opens a request instead for an upload-only role, parked in the closest parent', async () => {
      await tree.ensurePath(eventId, ['Saturday']);
      canManage = false;
      const res = await resolve({ paths: ['Saturday/Activity B', 'Saturday/Activity B'] });
      const r = res.body.results['Saturday/Activity B'];
      expect(r.status).toBe('requested');
      const sat = (await tree.eventFolders(eventId)).find((f) => f.name === 'Saturday');
      expect(r.folder_id).toBe(Number(sat.id));
      expect(await tree.folderTree(eventId)).toHaveLength(1);

      // A second upload into the same missing folder joins the open request.
      const again = await resolve({ paths: ['Saturday/Activity B'] });
      expect(again.body.results['Saturday/Activity B'].folder_request_id).toBe(r.folder_request_id);
    });

    it('keep_structure=false lands everything at the root but still flags the first look', async () => {
      const res = await resolve({ paths: ['Friday/A', 'FirstLook'], keep_structure: false });
      expect(res.body.results['Friday/A']).toMatchObject({ segments: [], status: 'root' });
      expect(res.body.results.FirstLook).toMatchObject({ first_look: true });
    });
  });

  describe('folder requests', () => {
    async function parkedUpload() {
      const { folderId: sat } = await tree.ensurePath(eventId, ['Saturday']);
      const requestId = await require('../../src/services/folderRequestService').openRequest(eventId, ['Saturday', 'Activity B'], sat, 1);
      const a = await addPhoto('a.jpg', { folder_id: sat, pending_folder_request_id: requestId });
      const b = await addPhoto('b.jpg', { folder_id: sat, pending_folder_request_id: requestId });
      return { sat, requestId, a, b };
    }

    it('approve creates the folder and moves the parked photos — not the ones an admin moved meanwhile', async () => {
      const { requestId, a, b } = await parkedUpload();
      await db('photos').where('id', b).update({ folder_id: null });
      const res = await request(app).post(`/api/admin/events/${eventId}/folder-requests/${requestId}/approve`).send({});
      expect(res.status).toBe(200);
      const activityB = (await tree.eventFolders(eventId)).find((f) => f.name === 'Activity B');
      expect((await db('photos').where('id', a).first()).folder_id).toBe(Number(activityB.id));
      const moved = await db('photos').where('id', b).first();
      expect(moved.folder_id).toBeNull();
      expect(moved.pending_folder_request_id).toBeNull();
    });

    it('reject leaves the photos in the parent', async () => {
      const { sat, requestId, a } = await parkedUpload();
      await request(app).post(`/api/admin/events/${eventId}/folder-requests/${requestId}/reject`).send({});
      const row = await db('photos').where('id', a).first();
      expect(row.folder_id).toBe(sat);
      expect(row.pending_folder_request_id).toBeNull();
    });

    it('a request decided once cannot be decided again (approve after reject is a 404)', async () => {
      const { requestId, a, sat } = await parkedUpload();
      const reqs = require('../../src/services/folderRequestService');
      const [first, second] = await Promise.allSettled([
        reqs.rejectRequest(eventId, requestId, 1),
        reqs.approveRequest(eventId, requestId, 1),
      ]);
      expect([first.status, second.status].sort()).toEqual(['fulfilled', 'rejected']);
      const row = await db('folder_requests').where('id', requestId).first();
      expect(['approved', 'rejected']).toContain(row.status);
      if (row.status === 'rejected') expect((await db('photos').where('id', a).first()).folder_id).toBe(sat);
    });

    it('photos that arrive after their request was decided follow the decision', async () => {
      const { sat, requestId } = await parkedUpload();
      await request(app).post(`/api/admin/events/${eventId}/folder-requests/${requestId}/approve`).send({});
      const late = await addPhoto('late.jpg', { folder_id: sat, pending_folder_request_id: requestId });
      const { afterUploadPlacement } = require('../../src/services/uploadPlacement');
      await afterUploadPlacement(eventId, { pending_folder_request_id: requestId, folder_id: sat }, 1);
      const activityB = (await tree.eventFolders(eventId)).find((f) => f.name === 'Activity B');
      expect(await db('photos').where('id', late).first()).toMatchObject({ folder_id: Number(activityB.id), pending_folder_request_id: null });
    });

    it('creating a folder inside an approve survives a unique violation (savepoint)', async () => {
      const { requestId } = await parkedUpload();
      // Same source path created meanwhile by an upload: the approve must reuse it.
      await tree.ensurePath(eventId, ['Saturday', 'Activity B']);
      const res = await request(app).post(`/api/admin/events/${eventId}/folder-requests/${requestId}/approve`).send({});
      expect(res.status).toBe(200);
    });

    it('only folders.manage may decide', async () => {
      const { requestId } = await parkedUpload();
      canManage = false;
      const res = await request(app).post(`/api/admin/events/${eventId}/folder-requests/${requestId}/approve`).send({});
      expect(res.status).toBe(403);
    });
  });

  describe('category flip (review concern 1)', () => {
    it('turning a folder back into a category clears its tree columns, and a later upload makes a new folder', async () => {
      const { folderId } = await tree.ensurePath(eventId, ['Selects']);
      const categoriesApp = express();
      categoriesApp.use(express.json());
      categoriesApp.use('/api/admin/categories', require('../../src/routes/adminCategories'));
      const res = await request(categoriesApp).put(`/api/admin/categories/${folderId}`).send({ name: 'Selects', is_folder: false });
      expect(res.status).toBe(200);
      const row = await db('photo_categories').where('id', folderId).first();
      expect(row.source_path).toBeNull();
      expect(row.parent_id).toBeNull();
      const again = await tree.ensurePath(eventId, ['Selects']);
      expect(again.folderId).not.toBe(folderId);
      expect(Boolean((await db('photo_categories').where('id', again.folderId).first()).is_folder)).toBe(true);
    });
  });

  describe('guest payload', () => {
    it('includes every ancestor of a used folder, folder_id, and the inherited download block', async () => {
      const { folderId: part1 } = await tree.ensurePath(eventId, ['Saturday', 'Activity B', 'Part 1']);
      await addPhoto('deep.jpg', { folder_id: part1, first_look: 1 });
      await addPhoto('root.jpg');
      const sat = (await tree.eventFolders(eventId)).find((f) => f.name === 'Saturday');
      await db('photo_categories').where('id', sat.id).update({ allow_downloads: 0 });

      const res = await request(app).get('/api/gallery/camp/photos');
      expect(res.status).toBe(200);
      const names = res.body.categories.filter((c) => c.is_folder).map((c) => c.name).sort();
      expect(names).toEqual(['Activity B', 'Part 1', 'Saturday']);
      const part = res.body.categories.find((c) => c.name === 'Part 1');
      expect(part.parent_id).toBe(res.body.categories.find((c) => c.name === 'Activity B').id);
      const deep = res.body.photos.find((p) => p.filename === 'deep.jpg');
      expect(deep).toMatchObject({ folder_id: part1, first_look: true, category_allow_downloads: false, category_id: null });
      expect(res.body.photos.find((p) => p.filename === 'root.jpg').folder_id).toBeNull();
    });

    it('does not ship a folder that holds only hidden photos (review concern 7)', async () => {
      const { folderId: secret } = await tree.ensurePath(eventId, ['Private', 'Rejects']);
      await addPhoto('hidden.jpg', { folder_id: secret, visibility: 'hidden' });
      await addPhoto('root2.jpg');
      const res = await request(app).get('/api/gallery/camp/photos');
      expect(res.body.categories.map((c) => c.name)).not.toContain('Rejects');
      expect(res.body.categories.map((c) => c.name)).not.toContain('Private');
    });

    it('reports a pre-265 row that still has its folder in category_id the current way', async () => {
      const { folderId } = await tree.ensurePath(eventId, ['Selects']);
      await addPhoto('legacy.jpg', { category_id: folderId });
      const res = await request(app).get('/api/gallery/camp/photos');
      expect(res.body.photos.find((p) => p.filename === 'legacy.jpg')).toMatchObject({ folder_id: folderId, category_id: null });
    });
  });
});
