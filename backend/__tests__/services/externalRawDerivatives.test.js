/**
 * A camera RAW in an external folder gets its cover image and lightbox
 * previews, like the same photo uploaded through the admin.
 *
 * The external branches of the hero and preview generators handed the RAW
 * straight to sharp, which cannot decode it, so each came back null: no
 * cover, no lightbox preview, and no face scan, which reads the preview.
 *
 * exiftool is not a dev dependency and there is no RAW fixture in the repo,
 * so exiftool is stood in for at the subprocess, as in
 * imageProcessorRawExtraction.test.js: the probe reports a full-size
 * JpgFromRaw and extracting it returns a real JPEG.
 */
jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  execFile: jest.fn(),
}));
jest.mock('../../src/services/mediaProcessService', () => ({
  ...jest.requireActual('../../src/services/mediaProcessService'),
  withSnapshot: (path, _kind, callback) => callback(path),
  currentScope: () => null,
  run: (command, args, options) => new Promise((resolve, reject) => {
    require('child_process').execFile(command, args, { timeout: options.wallMs, killSignal: 'SIGKILL', maxBuffer: options.outputBytes },
      (error, value) => error ? reject(error) : resolve({ ...value, stdout: Buffer.from(value.stdout) }));
  }),
}));

const path = require('path');
const fs = require('fs').promises;
const os = require('os');
const sharp = require('sharp');

const EXTERNAL_ROOT = path.join(os.tmpdir(), `picpeak-hero-extraw-${process.pid}`);
process.env.EXTERNAL_MEDIA_ROOT = EXTERNAL_ROOT;

jest.mock('../../src/database/db', () => {
  const state = { event: null, updates: [], rows: {} };
  const api = (table) => {
    if (table === 'events') return { where: () => ({ first: async () => state.event }) };
    if (table === 'photos') {
      // A RAW hero is a bounded derivative: it checks the row still holds the
      // same source before and after the work, then publishes through that
      // same match. A preview tier reads the row back before keeping its file.
      return {
        where: (criteria) => ({
          first: async () => state.rows[criteria.id] || { id: criteria.id },
          update: async (values) => { state.updates.push({ criteria, values }); return 1; },
        }),
      };
    }
    throw new Error(`unexpected table in test: ${table}`);
  };
  api.__state = state;
  return { db: api };
});

const { execFile } = require('child_process');
const LocalFsStorage = require('../../src/services/storage/LocalFsStorage');
const storageModule = require('../../src/services/storage');
const { db } = require('../../src/database/db');

const EVENT = { id: 7, slug: 'nas-wedding', source_mode: 'reference', external_path: 'weddings/2026-08' };

describe('derivatives of an external camera RAW', () => {
  let storage; let storageRoot; let imageProcessor;

  beforeAll(async () => {
    storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'picpeak-hero-raw-store-'));
    storage = new LocalFsStorage({ root: storageRoot });
    await storage.init();
    storageModule.setStorageForTesting(storage);
    imageProcessor = require('../../src/services/imageProcessor');
    await fs.mkdir(path.join(EXTERNAL_ROOT, EVENT.external_path), { recursive: true });

    const embedded = await sharp({
      create: { width: 2400, height: 1600, channels: 3, background: { r: 40, g: 80, b: 120 } },
    }).jpeg().toBuffer();
    execFile.mockImplementation((_cmd, args, _options, callback) => {
      const done = (stdout) => process.nextTick(() => callback(null, { stdout, stderr: '' }));
      if (args.includes('-json')) {
        return done(JSON.stringify([{ SourceFile: args[args.length - 1], JpgFromRawLength: embedded.length }]));
      }
      return done(args.includes('-JpgFromRaw') ? embedded : Buffer.alloc(0));
    });
  }, 30000);

  afterAll(async () => {
    storageModule.resetStorage();
    await fs.rm(storageRoot, { recursive: true, force: true }).catch(() => {});
    await fs.rm(EXTERNAL_ROOT, { recursive: true, force: true }).catch(() => {});
  });

  beforeEach(() => { db.__state.event = EVENT; db.__state.updates = []; db.__state.rows = {}; });

  const externalRaw = async (id) => {
    const name = `DSC0${id}.ARW`;
    // Not decodable by sharp, like a real ARW.
    await fs.writeFile(path.join(EXTERNAL_ROOT, EVENT.external_path, name), Buffer.from('II*\0not really a sony raw'));
    const row = {
      id,
      event_id: EVENT.id,
      source_origin: 'external',
      external_relpath: path.join(EVENT.external_path, name),
      filename: name,
      hero_path: null,
      preview_path: null,
    };
    db.__state.rows[id] = row;
    return row;
  };

  it('cuts the cover from the embedded preview', async () => {
    const photo = await externalRaw(401);

    const key = await imageProcessor.ensureHeroImage(photo);

    expect(key).toBeTruthy();
    expect(key).toContain(`ext${photo.id}_`);
    const hero = await sharp(path.join(storageRoot, key)).metadata();
    expect(hero.format).toBe('jpeg');
    expect(db.__state.updates).toEqual([{
      criteria: expect.objectContaining({ id: photo.id }),
      values: { hero_path: key, hero_anchor: '50% 50%' },
    }]);
  });

  it('renders the lightbox preview from the embedded preview', async () => {
    const photo = await externalRaw(402);

    const key = await imageProcessor.ensurePreviewImage(photo);

    expect(key).toBeTruthy();
    const preview = await sharp(path.join(storageRoot, key)).metadata();
    expect(Math.max(preview.width, preview.height)).toBe(1920);
  });

  // A JPG gone from the mount comes back null, which is how the face queue
  // tells a missing file from an unreachable NAS and defers the event. A RAW
  // has to come back the same way, not throw.
  describe('when the RAW is gone from the mount', () => {
    let extract;
    beforeEach(() => {
      extract = execFile.getMockImplementation();
      execFile.mockImplementation((_cmd, args, _options, callback) => process.nextTick(() => callback(
        Object.assign(new Error(`Error: File not found - ${args[args.length - 1]}`), { code: 1 }))));
    });
    afterEach(() => execFile.mockImplementation(extract));

    const missingRaw = (id) => ({
      id,
      event_id: EVENT.id,
      source_origin: 'external',
      external_relpath: path.join(EVENT.external_path, `GONE${id}.ARW`),
      filename: `GONE${id}.ARW`,
      hero_path: null,
      preview_path: null,
    });

    it('has no lightbox preview', async () => {
      await expect(imageProcessor.ensurePreviewImage(missingRaw(411))).resolves.toBeNull();
    });

    it('has no cover', async () => {
      await expect(imageProcessor.ensureHeroImage(missingRaw(412))).resolves.toBeNull();
    });
  });

  it('renders a narrower preview tier from the embedded preview', async () => {
    const photo = await externalRaw(403);

    const key = await imageProcessor.ensurePreviewImageAtWidth(photo, 640);

    expect(key).toBeTruthy();
    const preview = await sharp(path.join(storageRoot, key)).metadata();
    expect(Math.max(preview.width, preview.height)).toBe(640);
  });
});
