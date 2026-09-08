/**
 * The exiftool side of RAW extraction, with exiftool mocked.
 *
 * exiftool is not a dev dependency and there is no RAW fixture in the repo, so
 * the real extraction can only be exercised in the built image. What can be
 * pinned here is everything around the subprocess: which tag is asked for
 * first, how many times it is spawned, the limits it is spawned under, and
 * what happens when a file's only embedded image is a 160x120 screen nail.
 */
jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  execFile: jest.fn(),
}));

const sharp = require('sharp');
const { execFile } = require('child_process');
const { extractRawPreview } = require('../../src/services/imageProcessor');
const logger = require('../../src/utils/logger');

const jpegOf = (width, height) => sharp({
  create: { width, height, channels: 3, background: { r: 10, g: 20, b: 30 } },
}).jpeg().toBuffer();

/**
 * Answer each `-b <tag>` spawn from a map, the way exiftool does: a tag the
 * file does not carry writes nothing to stdout rather than failing.
 */
const respondWith = (byTag) => {
  execFile.mockImplementation((cmd, args, options, callback) => {
    const tag = args.find(arg => arg.startsWith('-') && arg !== '-b');
    process.nextTick(() => callback(null, { stdout: byTag[tag] || Buffer.alloc(0), stderr: '' }));
  });
};

const tagsAsked = () => execFile.mock.calls.map(
  ([, args]) => args.find(arg => arg.startsWith('-') && arg !== '-b')
);

beforeEach(() => {
  execFile.mockReset();
});

describe('extractRawPreview', () => {
  it('asks for PreviewImage first and stops there', async () => {
    // JpgFromRaw does not exist for ARW or CR2, so asking for it first cost
    // every Sony and Canon file a whole wasted exiftool process.
    respondWith({ '-PreviewImage': await jpegOf(1616, 1080) });

    const preview = await extractRawPreview('/tmp/DSC01234.ARW');
    try {
      expect(tagsAsked()).toEqual(['-PreviewImage']);
      const meta = await sharp(preview.path).metadata();
      expect(meta.width).toBe(1616);
    } finally {
      await preview.cleanup();
    }
  });

  it('falls through to JpgFromRaw when there is no PreviewImage', async () => {
    respondWith({ '-JpgFromRaw': await jpegOf(4000, 3000) });

    const preview = await extractRawPreview('/tmp/IMG_0001.DNG');
    try {
      expect(tagsAsked()).toEqual(['-PreviewImage', '-JpgFromRaw']);
      expect((await sharp(preview.path).metadata()).width).toBe(4000);
    } finally {
      await preview.cleanup();
    }
  });

  it('does not stop at a screen thumbnail while a real preview is untried', async () => {
    respondWith({
      '-PreviewImage': await jpegOf(160, 120),
      '-JpgFromRaw': await jpegOf(6000, 4000),
    });

    const preview = await extractRawPreview('/tmp/IMG_0001.NEF');
    try {
      expect((await sharp(preview.path).metadata()).width).toBe(6000);
    } finally {
      await preview.cleanup();
    }
  });

  it('uses a screen thumbnail only as a last resort, and says so', async () => {
    // Some bodies write an empty PreviewImage — exiftool documents the
    // ILCE-5100, 7M2, 7RM2 and 7SM2. A visible-but-soft photo beats a photo
    // the client cannot see at all, but it must not happen silently.
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    respondWith({ '-ThumbnailImage': await jpegOf(160, 120) });

    const preview = await extractRawPreview('/tmp/DSC09999.ARW');
    try {
      expect((await sharp(preview.path).metadata()).width).toBe(160);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('DSC09999.ARW'));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('160x120'));
    } finally {
      await preview.cleanup();
      warn.mockRestore();
    }
  });

  it('gives exiftool a deadline and a bounded buffer', async () => {
    respondWith({ '-PreviewImage': await jpegOf(1616, 1080) });

    const preview = await extractRawPreview('/tmp/DSC01234.ARW');
    try {
      const [, , options] = execFile.mock.calls[0];
      // Without these a wedged exiftool holds its worker slot until the
      // janitor resets the row, and the next worker wedges on the same file.
      expect(options.timeout).toBeGreaterThan(0);
      expect(options.killSignal).toBe('SIGKILL');
      expect(options.maxBuffer).toBeLessThanOrEqual(64 * 1024 * 1024);
    } finally {
      await preview.cleanup();
    }
  });

  it('fails with the install instructions when exiftool is missing', async () => {
    const enoent = Object.assign(new Error('spawn exiftool ENOENT'), { code: 'ENOENT' });
    execFile.mockImplementation((cmd, args, options, callback) => {
      process.nextTick(() => callback(enoent));
    });

    await expect(extractRawPreview('/tmp/DSC01234.ARW')).rejects.toThrow(/not installed/);
    // One spawn, not three: a missing binary fails the same way for every tag.
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  it('fails when the file carries no embedded image at all', async () => {
    respondWith({});
    await expect(extractRawPreview('/tmp/DSC01234.ARW')).rejects.toThrow(/No usable embedded preview/);
    expect(tagsAsked()).toEqual(['-PreviewImage', '-JpgFromRaw', '-ThumbnailImage']);
  });
});
