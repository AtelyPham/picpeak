/**
 * A gallery made from a quote or a standalone contract gets its share token
 * and link the way every other gallery does (eventCreationService): a 32-hex
 * token and /gallery/<slug>/<token>, or /gallery/<token> with short URLs on.
 *
 * Both conversions used to store a bare 64-hex token as share_link and
 * share_token. The gallery page only took 32 hex for a token, so "View
 * gallery" and a short guest link opened "Gallery not found".
 */
const crypto = require('crypto');
const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');

jest.setTimeout(120000);

describe('share link of a gallery converted from a quote or a contract', () => {
  let db; let cleanup; let adminId; let customerId;
  let quoteService; let contractConversions; let shareLinkService;

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    ({ adminId, customerId } = await seedMinimal(db));
    quoteService = require('../../src/services/quoteService');
    contractConversions = require('../../src/services/contract/conversions');
    shareLinkService = require('../../src/services/shareLinkService');
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  async function setShortUrls(on) {
    await db('app_settings').where({ setting_key: 'general_short_gallery_urls' }).del();
    if (on) {
      await db('app_settings').insert({
        setting_key: 'general_short_gallery_urls', setting_value: JSON.stringify(true), setting_type: 'general',
      });
    }
    shareLinkService.clearShareLinkSettingsCache();
  }

  async function acceptedQuote() {
    const dealUuid = crypto.randomUUID();
    const [row] = await db('quotes').insert({
      quote_number: `Q-${dealUuid.slice(0, 8)}`,
      customer_account_id: customerId,
      status: 'accepted',
      currency: 'CHF',
      issue_date: '2026-01-01',
      net_amount_minor: 100000, vat_amount_minor: 0, shipping_amount_minor: 0, total_amount_minor: 100000,
      deal_uuid: dealUuid,
      created_by_admin_id: adminId,
    }).returning('id');
    return row?.id ?? row;
  }

  async function signedContract() {
    const [row] = await db('contracts').insert({
      customer_account_id: customerId,
      contract_number: `C-${crypto.randomBytes(4).toString('hex')}`,
      status: 'fully_signed',
      issue_date: '2026-01-01',
      created_at: new Date(),
    }).returning('id');
    return row?.id ?? row;
  }

  const expectNormalLink = (ev, short) => {
    expect(ev.share_token).toMatch(/^[0-9a-f]{32}$/);
    expect(ev.share_link).toBe(short
      ? `/gallery/${ev.share_token}`
      : `/gallery/${ev.slug}/${ev.share_token}`);
  };

  it.each([false, true])('a quote converted to a gallery gets a normal token and link (short URLs %s)', async (short) => {
    await setShortUrls(short);
    const res = await quoteService.convertToEvent(await acceptedQuote(), adminId, { hold: true, skipInvoices: true });
    expectNormalLink(await db('events').where({ id: res.eventId }).first(), short);
  });

  it.each([false, true])('a standalone contract converted to a gallery gets a normal token and link (short URLs %s)', async (short) => {
    await setShortUrls(short);
    const res = await contractConversions.convertToEvent(await signedContract(), adminId);
    expectNormalLink(await db('events').where({ id: res.eventId }).first(), short);
  });

  it('a 64-hex token from an older conversion still resolves as a short link', async () => {
    const res = await quoteService.convertToEvent(await acceptedQuote(), adminId, { hold: true, skipInvoices: true });
    const legacy = crypto.randomBytes(32).toString('hex');
    await db('events').where({ id: res.eventId }).update({ share_token: legacy, share_link: legacy });
    // Upper-cased so it takes the token-shaped fallback, not the exact match.
    const resolved = await shareLinkService.resolveShareIdentifier(legacy.toUpperCase(), { includeDrafts: true });
    expect(resolved?.event?.id).toBe(res.eventId);
  });
});
