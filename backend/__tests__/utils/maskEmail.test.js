/**
 * The masked address public pages show before the visitor is verified: the
 * first two characters of the name and of the domain, and the top-level
 * domain. One rule for quotes, contracts and v2 signing invites.
 */
const { maskEmail } = require('../../src/utils/maskEmail');

test('keeps two characters of the name and of the domain, and the top-level domain', () => {
  expect(maskEmail('kunde@test.test')).toBe('ku***@te***.test');
  expect(maskEmail('anna.muster@example.com')).toBe('an***@ex***.com');
  expect(maskEmail('info@studio.co.uk')).toBe('in***@st***.uk');
});

test('never shows more than two characters, however short the parts are', () => {
  expect(maskEmail('a@b.ch')).toBe('a***@b***.ch');
  expect(maskEmail('ab@localhost')).toBe('ab***@lo***');
});

test('has nothing to hint at without a usable address', () => {
  for (const value of [null, undefined, '', 'no-at-sign', '@example.com', 'someone@', 42]) {
    expect(maskEmail(value)).toBeNull();
  }
});
