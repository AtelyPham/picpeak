/**
 * An external folder contributes camera RAW only once the admin allows it.
 *
 * Reference folders often hold the camera originals next to the JPEG export.
 * Publishing every one of those on upgrade would double a gallery overnight,
 * so RAW follows the same switch the upload gate reads: the extension has to
 * be in general_allowed_file_types.
 */

let mockStored;
let mockReadFails = false;
jest.mock('../../src/database/db', () => ({
  db: () => ({
    where: () => ({
      first: async () => {
        if (mockReadFails) throw new Error('db down');
        return mockStored === undefined ? undefined : { setting_value: JSON.stringify(mockStored) };
      },
    }),
  }),
}));
jest.mock('../../src/utils/logger', () => ({
  debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(),
}));

const { clearAllowedTypesCache } = require('../../src/services/uploadSettings');
const { importableExtensions } = require('../../src/services/externalMediaTypes');
const logger = require('../../src/utils/logger');

const allow = (value) => { mockStored = value; mockReadFails = false; clearAllowedTypesCache(); };

describe('importableExtensions and camera RAW', () => {
  it.each([
    ['no setting row', undefined],
    ['an empty setting', ''],
    ['the stock image types', 'jpg,jpeg,png,webp'],
  ])('takes no RAW with %s', async (_label, value) => {
    allow(value);
    const extensions = await importableExtensions();
    expect(extensions).toEqual(expect.arrayContaining(['.jpg', '.jpeg', '.png', '.webp']));
    expect(extensions).not.toContain('.arw');
    expect(extensions).not.toContain('.dng');
  });

  it('takes exactly the RAW types the admin allowed', async () => {
    allow('jpg,jpeg,png,webp,ARW,.dng');
    const extensions = await importableExtensions();
    expect(extensions).toEqual(expect.arrayContaining(['.arw', '.dng']));
    expect(extensions).not.toContain('.nef');
  });

  it('takes a RAW the MIME map does not know yet', async () => {
    allow('jpg,cr3');
    expect(await importableExtensions()).toContain('.cr3');
  });

  it('skips RAW for the pass, without failing it, when the setting cannot be read', async () => {
    allow('jpg,jpeg,png,webp,arw');
    mockReadFails = true;
    clearAllowedTypesCache();
    const extensions = await importableExtensions();
    expect(extensions).toEqual(expect.arrayContaining(['.jpg', '.jpeg', '.png', '.webp']));
    expect(extensions).not.toContain('.arw');
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/RAW/));
  });
});
