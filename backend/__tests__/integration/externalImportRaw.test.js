/**
 * External imports take camera RAW once the admin allows it.
 *
 * The folder import listed jpg/jpeg/png/webp and videos, so a RAW in a NAS
 * folder never became a photo. Taking it is not enough on its own: sharp
 * cannot decode a RAW, so the row would have no dimensions and no thumbnail,
 * and a guest would see an empty tile.
 *
 * Driven through the real route against real SQLite and real files. exiftool
 * is not available in CI and there is no RAW fixture in the repo, so the one
 * stub is the preview extraction: for a RAW name it hands back a real JPEG,
 * the way extractRawPreview does with the camera's embedded preview.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const express = require('express');
const request = require('supertest');
const sharp = require('sharp');

// Not decodable by sharp, like a real ARW.
const NOT_DECODABLE_RAW = Buffer.from('II*\0not really a sony raw');

describe('external import of camera RAW', () => {
  let tmpDir; let db; let app; let mediaRoot;
  let uploadSettings;
  let previewCleanup;

  const writeRaw = async (rel) => {
    const full = path.join(mediaRoot, rel);
    await fs.promises.mkdir(path.dirname(full), { recursive: true });
    await fs.promises.writeFile(full, NOT_DECODABLE_RAW);
  };

  const writeJpeg = async (rel) => {
    const full = path.join(mediaRoot, rel);
    await fs.promises.mkdir(path.dirname(full), { recursive: true });
    await sharp({ create: { width: 60, height: 40, channels: 3, background: { r: 10, g: 20, b: 30 } } })
      .jpeg().toFile(full);
  };

  const allowTypes = async (value) => {
    await db('app_settings')
      .insert({
        setting_key: 'general_allowed_file_types',
        setting_value: JSON.stringify(value),
        setting_type: 'general',
        updated_at: new Date().toISOString(),
      })
      .onConflict('setting_key')
      .merge({ setting_value: JSON.stringify(value) });
    uploadSettings.clearAllowedTypesCache();
  };

  beforeAll(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'picpeak-extraw-'));
    mediaRoot = path.join(tmpDir, 'media');
    await fs.promises.mkdir(mediaRoot, { recursive: true });

    process.env.NODE_ENV = 'test';
    process.env.TEST_DATABASE_PATH = path.join(tmpDir, 'data', 'db.sqlite');
    await fs.promises.mkdir(path.dirname(process.env.TEST_DATABASE_PATH), { recursive: true });
    process.env.STORAGE_PATH = path.join(tmpDir, 'storage');
    process.env.STORAGE_BACKEND = 'local';
    process.env.EXTERNAL_MEDIA_ROOT = mediaRoot;
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'extraw-secret';

    jest.resetModules();
    jest.doMock('../../src/middleware/auth', () => ({
      adminAuth: (req, _res, next) => { req.admin = { id: 1, username: 'tester', roleName: 'admin' }; next(); },
    }));
    jest.doMock('../../src/middleware/permissions', () => ({
      ...jest.requireActual('../../src/middleware/permissions'),
      requirePermission: () => (_req, _res, next) => next(),
    }));
    jest.doMock('../../src/middleware/ownership', () => ({
      ...jest.requireActual('../../src/middleware/ownership'),
      requireEventOwnership: (_req, _res, next) => next(),
    }));
    previewCleanup = jest.fn();
    const mockCleanup = previewCleanup;
    jest.doMock('../../src/services/imageProcessor', () => {
      const actual = jest.requireActual('../../src/services/imageProcessor');
      return {
        ...actual,
        withProcessableImage: jest.fn(async (localPath, sourceName) => {
          if (!/\.arw$/i.test(sourceName)) return actual.withProcessableImage(localPath, sourceName);
          const mockPath = require('path');
          const previewDir = require('fs').mkdtempSync(mockPath.join(require('os').tmpdir(), 'raw-preview-'));
          const previewPath = mockPath.join(previewDir, 'preview.jpg');
          // Portrait, as a camera held upright embeds it.
          await require('sharp')({
            create: { width: 400, height: 600, channels: 3, background: { r: 40, g: 80, b: 120 } },
          }).jpeg().toFile(previewPath);
          return { path: previewPath, outputBasename: mockPath.basename(sourceName), cleanup: mockCleanup };
        }),
      };
    });
    // The database is fine; only this one read fails, as in a blip.
    jest.doMock('../../src/services/uploadSettings', () => {
      const actual = jest.requireActual('../../src/services/uploadSettings');
      return { ...actual, getAllowedExtensions: jest.fn(actual.getAllowedExtensions) };
    });
    jest.doMock('../../src/utils/logger', () => ({
      debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(),
    }));

    ({ db } = await require('./helpers/crmDb').bootCrmDb());
    await require('./helpers/externalMediaFixture').seedExternalAdminFixture(db);
    uploadSettings = require('../../src/services/uploadSettings');

    app = express();
    app.use(express.json());
    app.use('/api/admin/external-media', require('../../src/routes/adminExternalMedia'));
  }, 180000);

  afterAll(async () => {
    if (db) await db.destroy?.();
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  beforeEach(async () => {
    await db('photos').del();
    await db('activity_logs').del();
    await db('events').del();
    await db('app_settings').where({ setting_key: 'general_allowed_file_types' }).del();
    uploadSettings.clearAllowedTypesCache();
    await fs.promises.rm(mediaRoot, { recursive: true, force: true });
    await fs.promises.mkdir(mediaRoot, { recursive: true });
    previewCleanup.mockClear();
  });

  async function seedEvent() {
    const [e] = await db('events').insert({
      slug: `extraw-${Math.random().toString(36).slice(2, 8)}`,
      event_type: 'wedding', event_name: 'extraw', event_date: '2026-01-01',
      host_email: 'h@example.com', admin_email: 'a@example.com', password_hash: 'x',
      share_link: `extraw-${Math.random()}`, expires_at: new Date().toISOString(),
      source_mode: 'reference',
    }).returning('id');
    return typeof e === 'object' ? e.id : e;
  }

  const runImport = (eventId, external_path = 'shoot') => request(app)
    .post(`/api/admin/external-media/events/${eventId}/import-external`)
    .send({ external_path, recursive: true });

  const rows = (eventId) => db('photos').where({ event_id: eventId }).orderBy('filename');

  it('leaves RAW alone while the admin has not allowed it', async () => {
    const eventId = await seedEvent();
    await writeRaw('shoot/DSC03991.ARW');
    await writeJpeg('shoot/DSC03991.JPG');

    const res = await runImport(eventId);

    expect(res.status).toBe(200);
    expect((await rows(eventId)).map((p) => p.filename)).toEqual(['DSC03991.JPG']);
  });

  it('imports an allowed RAW with dimensions, a thumbnail and its RAW type', async () => {
    const eventId = await seedEvent();
    await allowTypes('jpg,jpeg,png,webp,arw');
    await writeRaw('shoot/DSC03991.ARW');

    const res = await runImport(eventId);

    expect(res.status).toBe(200);
    const [photo] = await rows(eventId);
    expect(photo).toMatchObject({
      filename: 'DSC03991.ARW',
      source_origin: 'external',
      media_type: 'image',
      mime_type: 'image/x-sony-arw',
      width: 400,
      height: 600,
    });
    expect(photo.thumbnail_path).toBeTruthy();
    const thumb = await sharp(path.join(process.env.STORAGE_PATH, photo.thumbnail_path)).metadata();
    expect(thumb.format).toBe('jpeg');
    expect(previewCleanup).toHaveBeenCalled();
  });

  it('imports a RAW and a JPEG of the same name as two photos', async () => {
    const eventId = await seedEvent();
    await allowTypes('jpg,jpeg,png,webp,arw');
    await writeRaw('shoot/DSC03991.ARW');
    await writeJpeg('shoot/DSC03991.JPG');

    const res = await runImport(eventId);

    expect(res.status).toBe(200);
    expect((await rows(eventId)).map((p) => p.filename)).toEqual(['DSC03991.ARW', 'DSC03991.JPG']);
  });

  it('imports the JPEGs and leaves RAW for the next pass when the settings cannot be read', async () => {
    const eventId = await seedEvent();
    await allowTypes('jpg,jpeg,png,webp,arw');
    await writeRaw('shoot/DSC03991.ARW');
    await writeJpeg('shoot/DSC03991.JPG');

    uploadSettings.getAllowedExtensions.mockRejectedValueOnce(new Error('connection reset'));
    const res = await runImport(eventId);

    expect(res.status).toBe(200);
    expect((await rows(eventId)).map((p) => p.filename)).toEqual(['DSC03991.JPG']);

    expect((await runImport(eventId)).status).toBe(200);
    expect((await rows(eventId)).map((p) => p.filename)).toEqual(['DSC03991.ARW', 'DSC03991.JPG']);
  });
});
