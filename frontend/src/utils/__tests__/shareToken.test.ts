/**
 * A /gallery/<identifier> segment that is a bare share token is resolved
 * through the API; anything else is looked up as a slug. Galleries converted
 * from a quote or a contract carried 64-hex tokens, which the gallery page
 * used to take for a slug and answered with "Gallery not found".
 */
import { describe, it, expect } from 'vitest';
import { isShareToken } from '../shareToken';

const hex = (n: number) => 'a1b2c3d4e5f60789'.repeat(8).slice(0, n);

describe('isShareToken', () => {
  it('takes 32 hex (every gallery now) and 64 hex (older quote and contract conversions)', () => {
    expect(isShareToken(hex(32))).toBe(true);
    expect(isShareToken(hex(64))).toBe(true);
    expect(isShareToken(hex(32).toUpperCase())).toBe(true);
  });

  it('does not take other lengths or a slug', () => {
    for (const n of [31, 33, 48, 63, 65]) expect(isShareToken(hex(n))).toBe(false);
    expect(isShareToken('when-silence-speaks-2026-10-03')).toBe(false);
    expect(isShareToken(`${hex(31)}g`)).toBe(false);
    expect(isShareToken('')).toBe(false);
    expect(isShareToken(null)).toBe(false);
  });
});
