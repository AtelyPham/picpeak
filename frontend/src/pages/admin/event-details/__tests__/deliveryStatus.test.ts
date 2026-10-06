import { describe, expect, it } from 'vitest';
import { deliveryDue } from '../deliveryStatus';

// Review of PR 1826, concern 13: a gallery promised "by the 20th" is not
// overdue at noon UTC on the 20th.
describe('deliveryDue', () => {
  const due = '2026-10-20T12:00:00.000Z';

  it('is not overdue during the promised day, in local time', () => {
    expect(deliveryDue(due, new Date(2026, 9, 20, 14, 0))?.tone).toBe('soon');
    expect(deliveryDue(due, new Date(2026, 9, 20, 23, 59))?.tone).toBe('soon');
  });

  it('is overdue once the promised day is over', () => {
    expect(deliveryDue(due, new Date(2026, 9, 21, 0, 1))?.tone).toBe('overdue');
  });

  it('counts calendar days', () => {
    expect(deliveryDue(due, new Date(2026, 9, 17, 23, 0))?.days).toBe(3);
    expect(deliveryDue(due, new Date(2026, 9, 10, 8, 0))?.tone).toBe('ok');
  });

  it('is null without a date', () => {
    expect(deliveryDue(null)).toBeNull();
  });
});
