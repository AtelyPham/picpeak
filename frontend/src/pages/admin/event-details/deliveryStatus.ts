/**
 * How close a two-stage delivery is to its promised date (issue 1562), shared
 * by the Delivery settings, the event header and the event list so all three
 * colour a gallery the same way: amber within two days, red once overdue.
 */
export interface DeliveryDue {
  date: Date;
  /** Whole days left; negative once overdue. */
  days: number;
  tone: 'ok' | 'soon' | 'overdue';
}

const DAY_MS = 864e5;
export const DUE_SOON_DAYS = 2;

/**
 * The promise is a calendar date ("by the 20th", stored at noon UTC so it
 * reads the same everywhere): it is overdue once that whole day is over in
 * the admin's timezone, not at the stored noon. `days` counts calendar days.
 */
export function deliveryDue(dueAt: string | null | undefined, now: Date = new Date()): DeliveryDue | null {
  if (!dueAt) return null;
  const parsed = new Date(dueAt);
  if (Number.isNaN(parsed.getTime())) return null;
  const [y, m, d] = parsed.toISOString().slice(0, 10).split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const endOfDay = new Date(y, m - 1, d, 23, 59, 59, 999);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const days = Math.round((date.getTime() - today.getTime()) / DAY_MS);
  const tone = endOfDay.getTime() < now.getTime() ? 'overdue' : days <= DUE_SOON_DAYS ? 'soon' : 'ok';
  return { date, days, tone };
}

/** True while the gallery shows a first look and waits for the rest. */
export const isAwaitingFullGallery = (event: { delivery_status?: string | null }) => event.delivery_status === 'partial';
