/**
 * A camera RAW in an external folder can be the event's cover image.
 *
 * The external branch of the hero generator handed the RAW straight to sharp,
 * which cannot decode it, so the cover came back null while the same photo
 * uploaded through the admin got one from its embedded preview.
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
  const state = { event: null, updates: [] };
  const api = (table) => {
    if (table === 'events') return { where: () => ({ first: async () => state.event }) };
    if (table === 'photos') {
      // A RAW hero is a bounded derivative: it checks the row still holds the
      // same source before and after the work, then publishes through that
      // same match.
      return {
        where: (criteria) => ({
          first: async () => ({ id: criteria.id }),
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

describe('ensureHeroImage, external camera RAW', () => {
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

  beforeEach(() => { db.__state.event = EVENT; db.__state.updates = []; });

  it('cuts the cover from the embedded preview', async () => {
    const name = 'DSC03991.ARW';
    // Not decodable by sharp, like a real ARW.
    await fs.writeFile(path.join(EXTERNAL_ROOT, EVENT.external_path, name), Buffer.from('II*\0not really a sony raw'));
    const photo = {
      id: 401,
      event_id: EVENT.id,
      source_origin: 'external',
      external_relpath: path.join(EVENT.external_path, name),
      filename: name,
      hero_path: null,
    };

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
});
