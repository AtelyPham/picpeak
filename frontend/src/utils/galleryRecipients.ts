/**
 * Who hears that a gallery is ready — the UI side of
 * backend/src/services/galleryNotificationService.js.
 *
 * The inline customer email gets the standard gallery email (link +
 * password); each assigned customer account gets its portal email (no
 * password — the portal opens the gallery without one). One person entered in
 * both places is told once: by the gallery email when it carries a welcome
 * message or client access, otherwise by the portal email. The two sides have
 * to agree, or a dialog asks for a password nobody will receive.
 */
import { toBoolean } from './parsers';

export interface RecipientAccount {
  email?: string | null;
  display_name?: string | null;
  displayName?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  name?: string | null;
  is_active?: unknown;
  can_sign_in?: unknown;
  /** The picker's name for !can_sign_in. */
  isPassive?: boolean;
}

/** The name an admin recognises an account by. */
export function accountName(account: RecipientAccount): string {
  const full = [account.first_name, account.last_name].filter(Boolean).join(' ').trim();
  return account.name?.trim() || account.display_name?.trim() || account.displayName?.trim() || full || account.email || '';
}

/** Mirrors canReceiveGalleryNotice: active, can sign in, has an address. */
export function canReceiveGalleryNotice(account: RecipientAccount): boolean {
  return !!account.email && toBoolean(account.is_active, true) && toBoolean(account.can_sign_in, true)
    && !account.isPassive;
}

const sameAddress = (a?: string | null, b?: string | null) =>
  !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();

export interface GalleryRecipients {
  /** Gets the standard gallery email; null when there is none or it is also an account. */
  inlineEmail: string | null;
  /** Get the portal email. Empty while the customer portal is off. */
  accounts: RecipientAccount[];
}

export interface RecipientOptions {
  /** The customerPortal flag: the portal email links to it. */
  portalEnabled: boolean;
  /** customers.events — governs mailing accounts as well as assigning them. */
  includeAccounts?: boolean;
  /**
   * The gallery email carries something the portal email does not (welcome
   * message, client access): one person in both fields then gets that one.
   */
  prefersGalleryEmail?: boolean;
}

export function galleryRecipients(
  customerEmail: string | null | undefined,
  accounts: RecipientAccount[] | null | undefined,
  { portalEnabled, includeAccounts = true, prefersGalleryEmail = false }: RecipientOptions,
): GalleryRecipients {
  const reachable = portalEnabled && includeAccounts ? (accounts || []).filter(canReceiveGalleryNotice) : [];
  const contact = customerEmail?.trim() || null;
  const samePerson = contact ? reachable.find((a) => sameAddress(a.email, contact)) : undefined;
  if (!samePerson) return { inlineEmail: contact, accounts: reachable };
  if (prefersGalleryEmail) return { inlineEmail: contact, accounts: reachable.filter((a) => a !== samePerson) };
  return { inlineEmail: null, accounts: reachable };
}

type Translate = (key: string, options: Record<string, unknown>) => string;

/**
 * "Anna Muster, Ben Beispiel" or "Anna Muster, Ben Beispiel +3 more": the
 * first `shown` names, then a count of the rest.
 */
export function formatNameList(names: string[], t: Translate, shown = 2): string {
  const visible = names.slice(0, shown).join(', ');
  const rest = names.length - shown;
  if (rest <= 0) return visible;
  return t('events.recipients.andMore', {
    names: visible,
    count: rest,
    defaultValue: '{{names}} +{{count}} more',
  });
}
