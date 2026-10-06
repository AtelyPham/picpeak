/**
 * Link previews for PicTransfer URLs (#997): crawler hits get the transfer's
 * title + the branding tagline, never the generic SPA "Photo gallery shared
 * with PicPeak." card — and never a title for an unusable / flag-off / short-
 * code link.
 */

jest.mock('../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../utils/frontendUrl', () => ({ getAbsoluteFrontendUrl: jest.fn().mockResolvedValue('https://portal.example') }));
jest.mock('../middleware/requireFeatureFlag', () => ({ isFeatureEnabled: jest.fn() }));
jest.mock('../services/transferService', () => ({
  getTransferByToken: jest.fn(),
  getRequestByToken: jest.fn(),
  assertDownloadable: jest.fn(),
  assertUploadable: jest.fn(),
}));
jest.mock('../services/galleryOgService', () => {
  const actual = jest.requireActual('../services/galleryOgService');
  return { ...actual, fetchBranding: jest.fn() };
});
jest.mock('../database/db', () => ({ db: jest.fn() }));

const { isFeatureEnabled } = require('../middleware/requireFeatureFlag');
const transferService = require('../services/transferService');
const { fetchBranding, renderOgHtml } = require('../services/galleryOgService');
const { buildTransferOgMetadata } = require('../services/transferOgService');

const TOKEN = 'a'.repeat(64);

beforeEach(() => {
  jest.clearAllMocks();
  fetchBranding.mockResolvedValue({ companyName: 'Luca Bresch', companyTagline: 'Wedding & portrait photography', logoUrl: '/uploads/logo.png' });
  isFeatureEnabled.mockResolvedValue(true);
  transferService.assertDownloadable.mockReturnValue({ ok: true });
  transferService.assertUploadable.mockReturnValue({ ok: true });
});

test('send link: transfer title + company name, tagline as description', async () => {
  transferService.getTransferByToken.mockResolvedValue({ id: 1, title: 'Hochzeit Anna & Ben' });
  const meta = await buildTransferOgMetadata('send', TOKEN);
  expect(meta.title).toBe('Hochzeit Anna & Ben — Luca Bresch');
  expect(meta.description).toBe('Wedding & portrait photography');
  expect(meta.image).toBe('https://portal.example/uploads/logo.png');
  expect(meta.url).toBe(`https://portal.example/transfer/${TOKEN}`);
  const html = renderOgHtml(meta);
  expect(html).toContain('content="Hochzeit Anna &amp; Ben — Luca Bresch"');
  expect(html).not.toContain('Photo gallery');
});

test('request link resolves through the request lookup', async () => {
  transferService.getRequestByToken.mockResolvedValue({ id: 2, title: 'Your RAWs' });
  const meta = await buildTransferOgMetadata('request', TOKEN);
  expect(meta.title).toBe('Your RAWs — Luca Bresch');
  expect(meta.url).toBe(`https://portal.example/transfer-upload/${TOKEN}`);
  expect(transferService.getTransferByToken).not.toHaveBeenCalled();
});

test('no tagline → neutral transfer wording, not the gallery default', async () => {
  fetchBranding.mockResolvedValue({ companyName: null, companyTagline: null, logoUrl: null });
  transferService.getTransferByToken.mockResolvedValue({ id: 1, title: 'Files' });
  const meta = await buildTransferOgMetadata('send', TOKEN);
  expect(meta.title).toBe('Files — PicPeak');
  expect(meta.description).toBe('Files shared with you.');
});

test.each([
  ['expired/disabled transfer', () => transferService.assertDownloadable.mockReturnValue({ ok: false })],
  ['transfers flag off', () => isFeatureEnabled.mockResolvedValue(false)],
  ['unknown token', () => transferService.getTransferByToken.mockResolvedValue(undefined)],
])('%s → generic card, no title leak', async (_label, arrange) => {
  transferService.getTransferByToken.mockResolvedValue({ id: 1, title: 'Secret' });
  arrange();
  const meta = await buildTransferOgMetadata('send', TOKEN);
  expect(meta.title).toBe('Luca Bresch');
});

test('short read-aloud code is never resolved (lockout lives on the API route)', async () => {
  const meta = await buildTransferOgMetadata('request', 'ABCD2345');
  expect(transferService.getRequestByToken).not.toHaveBeenCalled();
  expect(meta.title).toBe('Luca Bresch');
});
