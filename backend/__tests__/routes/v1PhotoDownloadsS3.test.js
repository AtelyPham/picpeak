/**
 * v1 original downloads on an S3 backend (issue 1473).
 *
 * The storage backend is mocked as kind 's3' and the bytes exist only in the
 * mock, so a response carrying them proves the route read through the storage
 * abstraction and not a local path. The single download takes its
 * Content-Length from stat(); the ZIP skips the per-entry HEAD and relies on
 * get() rejecting a missing key, which must land in MISSING_FILES.txt rather
 * than kill the archive.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-v1dls3-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'v1dls3-test-secret';

const { Readable } = require('stream');

const mockObjects = new Map();
// Keys whose read fails: 'mid' after some bytes, 'early' before any byte.
const mockFailures = new Map();
const mockSlow = new Set();
// Storage metadata sizes that differ from the stored body.
const mockStatSizes = new Map();
// Keys whose stat takes a while, like a HEAD against a slow bucket.
const mockSlowStats = new Set();
const noSuchKey = () => Object.assign(
  new Error('The specified key does not exist.'), { name: 'NoSuchKey' },
);
const mockStorage = {
  kind: () => 's3',
  stat: jest.fn(async (key) => {
    if (mockSlowStats.has(key)) await new Promise((r) => setTimeout(r, 100));
    if (mockStatSizes.has(key)) return { size: mockStatSizes.get(key), mtime: new Date() };
    return mockObjects.has(key) ? { size: mockObjects.get(key).length, mtime: new Date() } : null;
  }),
  get: jest.fn(async (key) => {
    if (!mockObjects.has(key)) throw noSuchKey();
    const body = mockObjects.get(key);
    const failure = mockFailures.get(key);
    const slow = mockSlow.has(key);
    return Readable.from((async function* read() {
      if (failure === 'early') {
        await new Promise((r) => setImmediate(r));
        throw Object.assign(new Error('socket reset by peer'), { code: 'ECONNRESET' });
      }
      if (slow) await new Promise((r) => setTimeout(r, 150));
      yield body.subarray(0, 32 * 1024);
      if (failure === 'mid') {
        await new Promise((r) => setTimeout(r, 20));
        throw Object.assign(new Error('socket reset by peer'), { code: 'ECONNRESET' });
      }
      yield body.subarray(32 * 1024);
    })());
  }),
  // withLocalCopy stages the object on disk before sharp touches it, so every
  // RENDITION on an S3 install goes through this and not through get().
  // Without it the mock answers undefined and a resized download would fail
  // in a way no local-backend test can see.
  getToFile: jest.fn(async (key, localPath) => {
    if (!mockObjects.has(key)) throw noSuchKey();
    fs.writeFileSync(localPath, mockObjects.get(key));
  }),
  resolveLocalPath: () => { throw new Error('resolveLocalPath must not be used on an s3 backend'); },
};

jest.mock('../../src/services/storage', () => ({
  getStorage: () => mockStorage,
  initStorage: async () => mockStorage,
}));

const http = require('http');
const crypto = require('crypto');
const request = require('supertest');
const express = require('express');
const StreamZip = require('node-stream-zip');
const sharp = require('sharp');
const { bootCrmDb, seedMinimal } = require('../integration/helpers/crmDb');
const { generateApiToken } = require('../../src/middleware/apiTokenAuth');

const binaryParser = (response, cb) => {
  const chunks = [];
  response.on('data', (c) => chunks.push(c));
  response.on('end', () => cb(null, Buffer.concat(chunks)));
};

describe('v1 original downloads through an S3 backend (issue 1473)', () => {
  let db; let cleanup; let app; let token; let eventId; let presentId; let missingId;
  let midEventId; let earlyEventId; let unsizedEventId; let slowSizeEventId;
  let renderId; let renderBody; let renderEventId;
  let escapeId; let videoId;
  const body = Buffer.from('S3-ONLY-ORIGINAL-not-on-local-disk');

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);
    const role = await db('roles').where({ name: 'super_admin' }).first();
    const a = await db('admin_users').insert({
      username: 's3-root', email: 's3-root@example.com', password_hash: 'x', role_id: role.id,
      is_active: 1, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }).returning('id');
    const adminId = a[0]?.id ?? a[0];
    const { plaintext, hashed } = generateApiToken();
    await db('api_tokens').insert({
      name: 's3-read', hashed_token: hashed, scopes: 'read', created_by: adminId,
      created_at: new Date().toISOString(),
    });
    token = plaintext;

    const ev = await db('events').insert({
      slug: 's3-event', event_type: 'wedding', event_name: 's3-event', event_date: '2026-08-01',
      host_email: 'h@example.com', admin_email: 'a@example.com', password_hash: 'x',
      share_token: 's3-share', share_link: '/gallery/s3-event/s3-share', created_by: adminId,
      expires_at: new Date(Date.now() + 7 * 864e5).toISOString(),
      is_active: 1, is_archived: 0, is_draft: 0, created_at: new Date().toISOString(),
    }).returning('id');
    eventId = ev[0]?.id ?? ev[0];

    const mk = async (filename, original) => {
      const r = await db('photos').insert({
        event_id: eventId, filename, path: `s3-event/individual/${filename}`, type: 'individual',
        source_origin: 'managed', mime_type: 'image/jpeg', original_filename: original,
        size_bytes: body.length, uploaded_at: new Date().toISOString(),
      }).returning('id');
      return r[0]?.id ?? r[0];
    };
    presentId = await mk('s3-event_0001.jpg', 'present.jpg');
    missingId = await mk('s3-event_0002.jpg', 'missing.jpg');
    mockObjects.set('events/active/s3-event/individual/s3-event_0001.jpg', body);

    // A real encoded image, only ever in the mock bucket: a resized response
    // proves the rendition read through the storage abstraction. In an event
    // of its own, so the whole-event ZIP assertions above keep their exact
    // entry list.
    const renderEv = await db('events').insert({
      slug: 's3-render', event_type: 'wedding', event_name: 's3-render', event_date: '2026-08-01',
      host_email: 'h@example.com', admin_email: 'a@example.com', password_hash: 'x',
      share_token: 's3-render-share', share_link: '/gallery/s3-render/x', created_by: adminId,
      expires_at: new Date(Date.now() + 7 * 864e5).toISOString(),
      is_active: 1, is_archived: 0, is_draft: 0, created_at: new Date().toISOString(),
    }).returning('id');
    renderEventId = renderEv[0]?.id ?? renderEv[0];
    renderBody = await sharp({
      create: { width: 1200, height: 800, channels: 3, background: { r: 3, g: 99, b: 160 } },
    }).jpeg().toBuffer();
    const rr = await db('photos').insert({
      event_id: renderEventId, filename: 's3-render_0001.jpg',
      path: 's3-render/individual/s3-render_0001.jpg', type: 'individual',
      source_origin: 'managed', mime_type: 'image/jpeg', original_filename: 'render.jpg',
      // Recorded dimensions that match the file, so a test which mutates them
      // restores to what the row actually held rather than inventing a value.
      width: 1200, height: 800,
      size_bytes: renderBody.length, uploaded_at: new Date().toISOString(),
    }).returning('id');
    renderId = rr[0]?.id ?? rr[0];
    mockObjects.set('events/active/s3-render/individual/s3-render_0001.jpg', renderBody);

    // A row whose key climbs out of events/active/. Unlike LocalFsStorage,
    // this backend has no filesystem to refuse it — which is exactly why the
    // containment check has to be in the route and why it is testable here.
    const esc = await db('photos').insert({
      event_id: renderEventId, filename: 'escape.jpg', path: '../../secret/x.jpg',
      type: 'individual', source_origin: 'managed', mime_type: 'image/jpeg',
      width: 1200, height: 800, size_bytes: renderBody.length,
      uploaded_at: new Date().toISOString(),
    }).returning('id');
    escapeId = esc[0]?.id ?? esc[0];
    mockObjects.set('secret/x.jpg', renderBody);
    mockObjects.set('events/active/s3-render/individual/../../secret/x.jpg', renderBody);

    // A video: no preview tier exists and none can be made, so generating one
    // would stage the whole source for nothing.
    const vid = await db('photos').insert({
      event_id: renderEventId, filename: 's3-render_0002.mp4',
      path: 's3-render/individual/s3-render_0002.mp4', type: 'individual',
      source_origin: 'managed', mime_type: 'video/mp4', media_type: 'video',
      original_filename: 'clip.mp4', size_bytes: 1024,
      uploaded_at: new Date().toISOString(),
    }).returning('id');
    videoId = vid[0]?.id ?? vid[0];
    mockObjects.set('events/active/s3-render/individual/s3-render_0002.mp4', Buffer.alloc(1024, 7));

    // Two events whose ZIP hits a failing read: one mid-copy, one while the
    // failing entry is still queued behind a slow first entry.
    const mkFailEvent = async (slug) => {
      const r = await db('events').insert({
        slug, event_type: 'wedding', event_name: slug, event_date: '2026-08-01',
        host_email: 'h@example.com', admin_email: 'a@example.com', password_hash: 'x',
        share_token: `${slug}-share`, share_link: `/gallery/${slug}/x`, created_by: adminId,
        expires_at: new Date(Date.now() + 7 * 864e5).toISOString(),
        is_active: 1, is_archived: 0, is_draft: 0, created_at: new Date().toISOString(),
      }).returning('id');
      return r[0]?.id ?? r[0];
    };
    const mkFailPhoto = async (evId, slug, filename, mode) => {
      const key = `events/active/${slug}/individual/${filename}`;
      mockObjects.set(key, crypto.randomBytes(256 * 1024));
      if (mode === 'slow') mockSlow.add(key);
      else if (mode) mockFailures.set(key, mode);
      await db('photos').insert({
        event_id: evId, filename, path: `${slug}/individual/${filename}`, type: 'individual',
        source_origin: 'managed', mime_type: 'image/jpeg', size_bytes: 256 * 1024,
        uploaded_at: new Date().toISOString(),
      });
    };
    midEventId = await mkFailEvent('s3-mid');
    await mkFailPhoto(midEventId, 's3-mid', 'a.jpg', 'mid');
    await mkFailPhoto(midEventId, 's3-mid', 'b.jpg', null);
    // A legacy row with no recorded size whose object is 21 GiB according to
    // the storage metadata: the cap must see it.
    unsizedEventId = await mkFailEvent('s3-unsized');
    await db('photos').insert({
      event_id: unsizedEventId, filename: 'huge.mp4', path: 's3-unsized/individual/huge.mp4',
      type: 'individual', source_origin: 'managed', mime_type: 'video/mp4', media_type: 'video',
      size_bytes: null, uploaded_at: new Date().toISOString(),
    });
    mockObjects.set('events/active/s3-unsized/individual/huge.mp4', Buffer.from('x'));
    mockStatSizes.set('events/active/s3-unsized/individual/huge.mp4', 21 * 1024 ** 3);
    // Forty legacy rows without a size, each statted slowly.
    slowSizeEventId = await mkFailEvent('s3-slowsize');
    for (let i = 0; i < 40; i += 1) {
      const key = `events/active/s3-slowsize/individual/p${i}.jpg`;
      mockObjects.set(key, Buffer.from('x'));
      mockSlowStats.add(key);
      await db('photos').insert({
        event_id: slowSizeEventId, filename: `p${i}.jpg`, path: `s3-slowsize/individual/p${i}.jpg`,
        type: 'individual', source_origin: 'managed', mime_type: 'image/jpeg',
        size_bytes: null, uploaded_at: new Date().toISOString(),
      });
    }
    earlyEventId = await mkFailEvent('s3-early');
    await mkFailPhoto(earlyEventId, 's3-early', 'a.jpg', 'slow');
    await mkFailPhoto(earlyEventId, 's3-early', 'b.jpg', 'early');
    await mkFailPhoto(earlyEventId, 's3-early', 'c.jpg', null);

    app = express();
    app.use('/api/v1', require('../../src/routes/v1/events'));
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  beforeEach(() => {
    mockStorage.stat.mockClear();
    mockStorage.get.mockClear();
    // Cleared with the others, so the rendition tests' toHaveBeenCalled()
    // proves THEIR read and not one left over from an earlier test.
    mockStorage.getToFile.mockClear();
  });

  const get = (url) => request(app).get(url).set('Authorization', `Bearer ${token}`)
    .buffer(true).parse(binaryParser);

  it('streams the object from the backend with its stat size', async () => {
    const res = await get(`/api/v1/events/${eventId}/photos/${presentId}/download`);
    expect(res.status).toBe(200);
    expect(res.body.equals(body)).toBe(true);
    expect(res.headers['content-length']).toBe(String(body.length));
    expect(mockStorage.get).toHaveBeenCalledWith('events/active/s3-event/individual/s3-event_0001.jpg');
  });

  it('answers PHOTO_FILE_MISSING for a key the bucket does not have', async () => {
    const res = await get(`/api/v1/events/${eventId}/photos/${missingId}/download`);
    expect(res.status).toBe(404);
    expect(JSON.parse(res.body.toString()).code).toBe('PHOTO_FILE_MISSING');
  });

  it('zips from the backend without a HEAD per entry and lists the missing key', async () => {
    const res = await get(`/api/v1/events/${eventId}/photos/download`);
    expect(res.status).toBe(200);
    expect(mockStorage.stat).not.toHaveBeenCalled();

    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-v1dls3-zip-')), 'out.zip');
    fs.writeFileSync(file, res.body);
    const zip = new StreamZip.async({ file });
    const names = Object.keys(await zip.entries()).sort();
    expect(names).toEqual(['MISSING_FILES.txt', 'present.jpg']);
    expect((await zip.entryData('present.jpg')).equals(body)).toBe(true);
    expect((await zip.entryData('MISSING_FILES.txt')).toString()).toContain(String(missingId));
    await zip.close();
  });

  // Fetch over a real socket and report how the response ended: 'complete'
  // (a clean end), 'aborted' (connection broken) or 'timeout'.
  const fetchOutcome = (url, timeoutMs = 3000) => new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const done = (outcome, status) => {
        clearTimeout(timer);
        server.closeAllConnections?.();
        server.close(() => resolve({ outcome, status }));
      };
      const timer = setTimeout(() => done('timeout', null), timeoutMs);
      const req = http.get({
        host: '127.0.0.1', port: server.address().port, path: url,
        headers: { Authorization: `Bearer ${token}` },
      }, (res) => {
        res.on('data', () => {});
        res.on('aborted', () => done('aborted', res.statusCode));
        res.on('error', () => done('aborted', res.statusCode));
        res.on('end', () => done(res.complete ? 'complete' : 'aborted', res.statusCode));
      });
      req.on('error', () => done('aborted', null));
    });
  });

  it('breaks the connection when a read fails mid-copy instead of ending a truncated 200', async () => {
    const { outcome } = await fetchOutcome(`/api/v1/events/${midEventId}/photos/download`);
    expect(outcome).toBe('aborted');
  });

  it('breaks the connection when a queued read fails before it starts instead of hanging', async () => {
    const { outcome } = await fetchOutcome(`/api/v1/events/${earlyEventId}/photos/download`);
    expect(outcome).toBe('aborted');
  });

  it('sizes rows without a recorded size from storage metadata before the cap', async () => {
    const res = await get(`/api/v1/events/${unsizedEventId}/photos/download`);
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body.toString()).code).toBe('ZIP_TOO_LARGE');
  });

  it('stops sizing and opens nothing once the client has left', async () => {
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
      const req = http.get({
        host: '127.0.0.1', port: server.address().port,
        path: `/api/v1/events/${slowSizeEventId}/photos/download`,
        headers: { Authorization: `Bearer ${token}` },
      });
      req.on('error', () => {});
      // Leave while the first batch of stats is in flight.
      await new Promise((r) => setTimeout(r, 150));
      req.destroy();
      await new Promise((r) => setTimeout(r, 600));
      // One batch of eight at most, not all forty; no reads at all.
      expect(mockStorage.stat.mock.calls.length).toBeGreaterThan(0);
      expect(mockStorage.stat.mock.calls.length).toBeLessThanOrEqual(16);
      expect(mockStorage.get).not.toHaveBeenCalled();
    } finally {
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
    }
  });

  it('answers HEAD from a stat without opening the object', async () => {
    const res = await request(app)
      .head(`/api/v1/events/${eventId}/photos/${presentId}/download`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-length']).toBe(String(body.length));
    expect(mockStorage.stat).toHaveBeenCalled();
    expect(mockStorage.get).not.toHaveBeenCalled();

    const missing = await request(app)
      .head(`/api/v1/events/${eventId}/photos/${missingId}/download`)
      .set('Authorization', `Bearer ${token}`);
    expect(missing.status).toBe(404);
    expect(mockStorage.get).not.toHaveBeenCalled();
  });

  describe('renditions', () => {
    it('resizes an object that exists only in the bucket', async () => {
      const res = await get(`/api/v1/events/${renderEventId}/photos/${renderId}/download?resolution=400x400`);
      expect(res.status).toBe(200);
      const meta = await sharp(res.body).metadata();
      expect([meta.width, meta.height]).toEqual([400, 267]);
      // Staged through getToFile, not streamed through get(): that is the
      // whole difference between the rendition and the original path on S3.
      expect(mockStorage.getToFile).toHaveBeenCalled();
    });

    it('packs renditions into the ZIP from the bucket', async () => {
      const res = await get(`/api/v1/events/${renderEventId}/photos/download?resolution=400x400&ids=${renderId}`);
      expect(res.status).toBe(200);
      expect(res.headers['content-disposition']).toContain('filename="s3-render-400x400.zip"');

      // Opened, not just counted: a rendition that fails on the ZIP path is
      // swallowed into MISSING_FILES.txt and the archive still ends 200, so
      // status and filename alone would stay green with the read broken.
      const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-v1rends3-')), 'out.zip');
      fs.writeFileSync(file, res.body);
      const zip = new StreamZip.async({ file });
      const names = Object.keys(await zip.entries());
      expect(names).toEqual(['render.jpg']);
      const meta = await sharp(await zip.entryData('render.jpg')).metadata();
      expect([meta.width, meta.height]).toEqual([400, 267]);
      await zip.close();
    });

    it('answers a missing object with 404 rather than a 500', async () => {
      const res = await get(`/api/v1/events/${eventId}/photos/${missingId}/download?resolution=400x400`);
      expect(res.status).toBe(404);
      expect(JSON.parse(res.body.toString('utf8')).code).toBe('PHOTO_FILE_MISSING');
    });

    it('still serves the stored bytes when no rendition was asked for', async () => {
      const res = await get(`/api/v1/events/${renderEventId}/photos/${renderId}/download`);
      expect(res.status).toBe(200);
      expect(res.body.equals(renderBody)).toBe(true);
    });

    it('never delivers more pixels than the box, even when the recorded dimensions are wrong', async () => {
      // photos.width/height are not guaranteed to describe the bytes on disk.
      // An earlier version skipped the render when they said the photo already
      // fitted, so a row understating its size silently returned the full-size
      // original — the caller asked for at most 400px and got 1200. The
      // fixture's row deliberately disagrees with its file for that reason.
      await db('photos').where({ id: renderId }).update({ width: 40, height: 27 });
      try {
        const res = await get(`/api/v1/events/${renderEventId}/photos/${renderId}/download?resolution=400x400`);
        expect(res.status).toBe(200);
        const meta = await sharp(res.body).metadata();
        expect(meta.width).toBeLessThanOrEqual(400);
        expect(meta.height).toBeLessThanOrEqual(400);
        expect([meta.width, meta.height]).toEqual([400, 267]);
      } finally {
        await db('photos').where({ id: renderId }).update({ width: 1200, height: 800 });
      }
    });

    it('refuses a key outside events/active/ on the rendition path', async () => {
      const res = await get(`/api/v1/events/${renderEventId}/photos/${escapeId}/download?resolution=400x400`);
      expect(res.status).toBe(404);
      // Nothing was read. This backend has no filesystem to refuse the key,
      // so a pass here means the ROUTE refused it.
      expect(mockStorage.getToFile).not.toHaveBeenCalled();
      expect(mockStorage.get).not.toHaveBeenCalled();
    });
  });

  describe('preview', () => {
    it('refuses a key outside events/active/ without reading anything', async () => {
      const res = await get(`/api/v1/events/${renderEventId}/photos/${escapeId}/preview`);
      expect(res.status).toBe(404);
      expect(JSON.parse(res.body.toString('utf8')).code).toBe('PREVIEW_UNAVAILABLE');
      expect(mockStorage.getToFile).not.toHaveBeenCalled();
      expect(mockStorage.get).not.toHaveBeenCalled();
    });

    it('answers a video without staging the source', async () => {
      const res = await get(`/api/v1/events/${renderEventId}/photos/${videoId}/preview`);
      expect(res.status).toBe(404);
      expect(JSON.parse(res.body.toString('utf8')).code).toBe('PREVIEW_UNAVAILABLE');
      // A video has no preview tier and never will, so generating one can only
      // fail — after downloading the whole video. That must not happen, and it
      // must not happen per row of a picker either.
      expect(mockStorage.getToFile).not.toHaveBeenCalled();
      expect(mockStorage.get).not.toHaveBeenCalled();
    });

    it('does not stage a video even when ?w misses its tier', async () => {
      const res = await get(`/api/v1/events/${renderEventId}/photos/${videoId}/preview?w=640`);
      expect(res.status).toBe(404);
      // The tier miss used to cost a second full fetch on the fallback.
      expect(mockStorage.getToFile).not.toHaveBeenCalled();
    });

    // The happy path is covered on the local backend in v1PhotoRenditions;
    // this mock implements reads only, so generating a preview through it
    // would be testing the mock. What belongs here is the cases where nothing
    // may be read at all.
  });
});
