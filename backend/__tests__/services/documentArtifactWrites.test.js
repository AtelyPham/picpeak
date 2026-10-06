/**
 * Generated documents are a record, so the file a `generated_documents` row
 * names must still be the file it hashed (#1445).
 *
 * An invoice can be re-sent and an accepted quote re-rendered after every
 * add-on change, so the same file name comes round again. Overwriting it made
 * the earlier row's sha256 a lie, and a crash mid-write left a truncated PDF
 * as the only copy of a document that had already gone out.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

let tmp;
let writeWithoutOverwriting;
const prevStorage = process.env.STORAGE_PATH;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-artifacts-'));
  process.env.STORAGE_PATH = tmp;
  jest.resetModules();
  ({ writeWithoutOverwriting } = require('../../src/services/documentArtifactService')._internal);
});

afterEach(() => {
  process.env.STORAGE_PATH = prevStorage;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

test('a second document with the same name gets its own file', () => {
  const first = writeWithoutOverwriting(tmp, 'R-2026-0001.pdf', Buffer.from('%PDF-1.4 first'));
  const second = writeWithoutOverwriting(tmp, 'R-2026-0001.pdf', Buffer.from('%PDF-1.4 second'));

  expect(first).toBe(path.join(tmp, 'R-2026-0001.pdf'));
  expect(second).not.toBe(first);
  expect(path.basename(second)).toMatch(/^R-2026-0001-[0-9a-f]{6}\.pdf$/);
  // The first file — and the sha256 an earlier row recorded for it — is
  // exactly as it was.
  expect(sha256(fs.readFileSync(first))).toBe(sha256(Buffer.from('%PDF-1.4 first')));
  expect(fs.readFileSync(second).toString()).toBe('%PDF-1.4 second');
});

test('nothing is left at the name when the write fails', () => {
  // Writing through a temp file is what keeps a half-written PDF from ending
  // up at the name a row points at.
  const write = jest.spyOn(fs, 'writeFileSync').mockImplementation(() => {
    throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
  });
  try {
    expect(() => writeWithoutOverwriting(tmp, 'R-2026-0002.pdf', Buffer.from('x'))).toThrow(/no space/);
  } finally {
    write.mockRestore();
  }
  expect(fs.readdirSync(tmp)).toEqual([]);
});

test('the name is claimed, not checked — two writers cannot pick the same one', () => {
  // exclusive create rather than existsSync-then-write: a second process
  // holding the name gets a different one instead of overwriting.
  fs.writeFileSync(path.join(tmp, 'R-2026-0003.pdf'), 'taken');
  const written = writeWithoutOverwriting(tmp, 'R-2026-0003.pdf', Buffer.from('%PDF-1.4 mine'));
  expect(written).not.toBe(path.join(tmp, 'R-2026-0003.pdf'));
  expect(fs.readFileSync(path.join(tmp, 'R-2026-0003.pdf'), 'utf8')).toBe('taken');
});
