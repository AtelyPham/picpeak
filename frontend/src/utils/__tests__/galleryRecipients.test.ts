import { describe, expect, it } from 'vitest';
import { accountName, formatNameList, galleryRecipients } from '../galleryRecipients';

const t = (_key: string, options: Record<string, unknown>) =>
  String(options.defaultValue)
    .replace('{{names}}', String(options.names))
    .replace('{{count}}', String(options.count));

const anna = { email: 'anna@example.com', display_name: 'Anna Muster', is_active: 1, can_sign_in: 1 };
const ben = { email: 'ben@example.com', first_name: 'Ben', last_name: 'Beispiel', is_active: true, can_sign_in: true };

describe('galleryRecipients', () => {
  it('sends the gallery email to the inline address and the portal email to each account', () => {
    const r = galleryRecipients('client@example.com', [anna, ben], { portalEnabled: true });
    expect(r.inlineEmail).toBe('client@example.com');
    expect(r.accounts.map(accountName)).toEqual(['Anna Muster', 'Ben Beispiel']);
  });

  it('tells one person in both fields once, through the portal', () => {
    expect(galleryRecipients('ANNA@example.com ', [anna], { portalEnabled: true }).inlineEmail).toBeNull();
  });

  it('…by the gallery email instead when it carries a welcome message or client access', () => {
    const r = galleryRecipients('anna@example.com', [anna, ben], { portalEnabled: true, prefersGalleryEmail: true });
    expect(r.inlineEmail).toBe('anna@example.com');
    expect(r.accounts.map(accountName)).toEqual(['Ben Beispiel']);
  });

  it('reaches no account without customers.events', () => {
    expect(galleryRecipients('client@example.com', [anna], { portalEnabled: true, includeAccounts: false }))
      .toEqual({ inlineEmail: 'client@example.com', accounts: [] });
  });

  it('leaves out accounts that cannot act on the notice, and all of them while the portal is off', () => {
    const passive = { ...ben, can_sign_in: 0 };
    const inactive = { ...anna, is_active: false };
    expect(galleryRecipients(null, [passive, inactive], { portalEnabled: true }).accounts).toEqual([]);
    expect(galleryRecipients('client@example.com', [anna], { portalEnabled: false })).toEqual({ inlineEmail: 'client@example.com', accounts: [] });
  });
});

describe('formatNameList', () => {
  it('shows the first two names and counts the rest', () => {
    expect(formatNameList(['Anna'], t)).toBe('Anna');
    expect(formatNameList(['Anna', 'Ben'], t)).toBe('Anna, Ben');
    expect(formatNameList(['Anna', 'Ben', 'Cleo', 'Dana'], t)).toBe('Anna, Ben +2 more');
  });
});
