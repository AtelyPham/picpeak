import { describe, it, expect } from 'vitest';
import type { TFunction } from 'i18next';
import { quoteErrorText } from '../quoteErrors';

// Echo the key and its fallback so the test sees which message was chosen.
const t = ((key: string, fallback: string) => `${key}|${fallback}`) as unknown as TFunction;

describe('quoteErrorText', () => {
  it('says where to set a rate when neither the customer nor the default has one', () => {
    const err = { response: { data: { code: 'RATE_REQUIRED', error: 'No hourly rate for this customer…' } } };
    expect(quoteErrorText(err, t, 'Save failed')).toMatch(/^quotes\.errors\.rateRequired\|.*Settings → Accounting/);
  });

  it('shows the server message for other errors', () => {
    const err = { response: { data: { code: 'QUOTE_LOCKED', error: 'Cannot edit quote' } } };
    expect(quoteErrorText(err, t, 'Save failed')).toBe('Cannot edit quote');
  });

  it('falls back when there is no message at all', () => {
    expect(quoteErrorText(new Error(''), t, 'Save failed')).toBe('Save failed');
  });
});
