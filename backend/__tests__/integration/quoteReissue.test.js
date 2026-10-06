/**
 * Reissuing an accepted quote (#1451), like an invoice with its Storno.
 *
 * Real admin + public routes → quoteService → SQLite with the full
 * core-migration run (helpers/crmDb). Pins:
 *   - the accepted quote is declined with the admin's reason, its customer
 *     link stops working, its acceptance stays on record, and no email goes
 *     out;
 *   - a draft copy with the same lines and add-on choice replaces it, in the
 *     same deal, and both quotes name each other;
 *   - the reissued quote's PDF says which quote it replaces;
 *   - a reissued quote isn't sent again;
 *   - only an accepted quote without a contract, event or invoice can be
 *     reissued, or declined by the admin;
 *   - editing an accepted quote says to reissue it.
 */

const request = require('supertest');
const PDFKit = require('pdfkit');

// Lets one test convert the quote in the MIDDLE of a response — between the
// checks at the top of recordResponse and its write. The factory is hoisted
// above the requires, so quoteService gets this module; armed through
// globalThis (a factory may not close over a test variable), it runs the hook
// once, on the first setting the response reads.
jest.mock('../../src/utils/appSettings', () => {
  const actual = jest.requireActual('../../src/utils/appSettings');
  return {
    ...actual,
    getAppSetting: async (key, ...rest) => {
      if (globalThis.__duringResponse && key === 'crm_quotes_accept_window_minutes') {
        const hook = globalThis.__duringResponse;
        globalThis.__duringResponse = null;
        await hook();
      }
      return actual.getAppSetting(key, ...rest);
    },
  };
});
const {
  bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken, createPublicToken, buildRouteApp,
} = require('./helpers/crmDb');
const { isTruthyFlag } = require('../../src/utils/lineItemTotals');


// The public quote page now needs the grant issued after the emailed code
// (upstream #1465); the code step itself is covered in its own suite. The
// service is required lazily: at module load it would initialise the db
// module before bootCrmDb points it at the temp database.
async function quoteGrant(token) {
  const verification = require('../../src/services/publicDocumentVerificationService');
  const row = await db('quote_action_tokens').where({ token }).first();
  return verification.issueGrant('quote', row, token);
}

jest.setTimeout(120000);

let db;
let cleanup;
let tmpDir;
let adminId;
let customerId;
let token;
let publicApp;
let adminApp;
let quoteService;

const prevCwd = process.cwd();
const auth = { get Authorization() { return `Bearer ${token}`; } };

// The public routes rate-limit per client address, and this suite answers
// more quotes than one address may in a minute.
let ipCounter = 0;
const nextIp = () => {
  ipCounter += 1;
  return `198.51.100.${ipCounter % 250}`;
};

async function setFlag(key, value) {
  const updated = await db('feature_flags').where({ key }).update({ value });
  if (!updated) await db('feature_flags').insert({ key, value });
  require('../../src/middleware/requireFeatureFlag').invalidateFeatureFlagCache();
}

beforeAll(async () => {
  ({ db, cleanup, tmpDir } = await bootCrmDb());
  process.chdir(tmpDir);
  db.client.pool.acquireTimeoutMillis = 2000;
  ({ adminId, customerId } = await seedMinimal(db));
  await assignAdminRole(db, adminId, 'super_admin');
  token = mintAdminToken(adminId);
  await setFlag('quotes', true);
  quoteService = require('../../src/services/quoteService');
  publicApp = buildRouteApp('/api/public/quotes', require('../../src/routes/publicQuotes'));
  adminApp = buildRouteApp('/api/admin/quotes', require('../../src/routes/adminQuotes'));
}, 120000);

afterAll(async () => {
  process.chdir(prevCwd);
  if (cleanup) await cleanup();
});

// CHF 1000 wedding day, an album add-on (not booked) and a drone add-on
// (booked), accepted by the customer through their link.
async function acceptedQuote() {
  const quoteId = await quoteService.createQuote({
    customerAccountId: customerId, currency: 'CHF', vatRate: 0, lineItems: [
      { position: 1, quantity: 1, description: 'Wedding day', unit_price_minor: 100000 },
      { position: 2, quantity: 1, description: 'Album', unit_price_minor: 30000, is_optional: true, selected: false },
      { position: 3, quantity: 1, description: 'Drone', unit_price_minor: 20000, is_optional: true, selected: true },
    ],
  }, adminId);
  await db('quotes').where({ id: quoteId }).update({ status: 'sent', sent_at: new Date().toISOString() });
  const link = await createPublicToken(db, 'quote_action_tokens', { quote_id: quoteId });
  const res = await request(publicApp).post(`/api/public/quotes/${link}/respond`).set('X-Document-Access', await quoteGrant(link)).set('X-Forwarded-For', nextIp())
    .send({ action: 'accept', selectedOptional: [3], expectedTotalMinor: 120000 });
  expect(res.status).toBe(200);
  return { quoteId, link };
}

test('reissuing declines the accepted quote and replaces it with a draft copy', async () => {
  const { quoteId, link } = await acceptedQuote();
  const before = await db('quotes').where({ id: quoteId }).first();
  const mails = (await db('email_queue')).length;

  const res = await request(adminApp).post(`/api/admin/quotes/${quoteId}/reissue`).set(auth)
    .send({ reason: 'Grösseres Album gewünscht' });
  expect(res.status).toBe(201);

  const old = await db('quotes').where({ id: quoteId }).first();
  expect(old.status).toBe('declined');
  expect(old.decline_reason).toBe('Grösseres Album gewünscht');
  // The acceptance stays on record.
  expect(old.accepted_at).toBeTruthy();
  expect(old.selection_accepted_at).toBeTruthy();
  // The customer's link no longer works, and nobody was emailed.
  const late = await request(publicApp).post(`/api/public/quotes/${link}/respond`).set('X-Document-Access', await quoteGrant(link)).set('X-Forwarded-For', nextIp())
    .send({ action: 'accept', selectedOptional: [3], expectedTotalMinor: 120000 });
  expect(late.status).toBe(410);
  expect(late.body.code).toBe('QUOTE_REPLACED');
  expect((await db('email_queue')).length).toBe(mails);

  const copy = await db('quotes').where({ id: res.body.quoteId }).first();
  expect(copy).toEqual(expect.objectContaining({
    status: 'draft', replaces_quote_id: quoteId, deal_uuid: before.deal_uuid, customer_account_id: customerId,
  }));
  expect(copy.quote_number).not.toBe(old.quote_number);
  const lines = await db('quote_line_items').where({ quote_id: copy.id }).orderBy('position', 'asc');
  expect(lines.map((l) => l.description)).toEqual(['Wedding day', 'Album', 'Drone']);
  expect(lines.map((l) => isTruthyFlag(l.selected))).toEqual([true, false, true]);

  // Both quotes name each other.
  const oldView = await request(adminApp).get(`/api/admin/quotes/${quoteId}`).set(auth);
  expect(oldView.body.quote).toEqual(expect.objectContaining({
    replacedByQuoteId: copy.id, replacedByQuoteNumber: copy.quote_number, replacesQuoteId: null,
  }));
  const newView = await request(adminApp).get(`/api/admin/quotes/${copy.id}`).set(auth);
  expect(newView.body.quote).toEqual(expect.objectContaining({
    replacesQuoteId: quoteId, replacesQuoteNumber: old.quote_number, replacedByQuoteId: null,
  }));
});

test('a reissued quote isn\'t sent again: the quote that replaced it is', async () => {
  const { quoteId } = await acceptedQuote();
  await quoteService.reissueQuote(quoteId, adminId);
  await expect(quoteService.sendQuote(quoteId, adminId))
    .rejects.toMatchObject({ statusCode: 409, code: 'QUOTE_REPLACED' });
});

test('the reissued quote\'s PDF says which quote it replaces', async () => {
  const { quoteId } = await acceptedQuote();
  const old = await db('quotes').where({ id: quoteId }).first();
  const { quoteId: newId } = await quoteService.reissueQuote(quoteId, adminId);

  const texts = jest.spyOn(PDFKit.prototype, 'text');
  await quoteService.getQuotePdfBuffer(newId);
  const drawn = texts.mock.calls.map((c) => String(c[0]));
  texts.mockRestore();
  expect(drawn.some((t) => new RegExp(`(Ersetzt|Replaces) \\S+ ${old.quote_number}`).test(t))).toBe(true);
});

test('only an accepted quote without a contract, event or invoice can be reissued', async () => {
  const draftId = await quoteService.createQuote({
    customerAccountId: customerId, currency: 'CHF', vatRate: 0,
    lineItems: [{ position: 1, quantity: 1, description: 'Portrait', unit_price_minor: 50000 }],
  }, adminId);
  const early = await request(adminApp).post(`/api/admin/quotes/${draftId}/reissue`).set(auth).send({});
  expect(early.status).toBe(409);
  expect(early.body.code).toBe('QUOTE_NOT_ACCEPTED');

  const { quoteId } = await acceptedQuote();
  await db('quotes').where({ id: quoteId }).update({ status: 'converted' });
  const late = await request(adminApp).post(`/api/admin/quotes/${quoteId}/reissue`).set(auth).send({});
  expect(late.status).toBe(409);
  // Converted, so not accepted any more: either refusal keeps the quote as
  // it is and makes no copy.
  expect(['QUOTE_CONVERTED', 'QUOTE_NOT_ACCEPTED']).toContain(late.body.code);
  expect((await db('quotes').where({ id: quoteId }).first()).status).toBe('converted');
  expect(await db('quotes').where({ replaces_quote_id: quoteId })).toHaveLength(0);

  // An invoice made from the quote locks it too, even though the quote never
  // reaches `converted` (a manual invoice can carry source_quote_id).
  const { quoteId: invoicedId } = await acceptedQuote();
  await db('invoices').insert({
    invoice_number: `I-REISSUE-${invoicedId}`, customer_account_id: customerId, status: 'sent',
    issue_date: '2026-09-01', due_date: '2026-09-15', source_quote_id: invoicedId,
  });
  const invoiced = await request(adminApp).post(`/api/admin/quotes/${invoicedId}/reissue`).set(auth).send({});
  expect(invoiced.status).toBe(409);
  expect(invoiced.body.code).toBe('QUOTE_CONVERTED');
  expect(await db('quotes').where({ replaces_quote_id: invoicedId })).toHaveLength(0);
});

test('two reissues of the same quote make one replacement draft', async () => {
  const { quoteId } = await acceptedQuote();
  const both = await Promise.allSettled([
    request(adminApp).post(`/api/admin/quotes/${quoteId}/reissue`).set(auth).send({}),
    request(adminApp).post(`/api/admin/quotes/${quoteId}/reissue`).set(auth).send({}),
  ]);
  const statuses = both.map((r) => (r.status === 'fulfilled' ? r.value.status : 500)).sort();
  expect(statuses[0]).toBe(201);
  expect(statuses[1]).not.toBe(201);
  expect(await db('quotes').where({ replaces_quote_id: quoteId })).toHaveLength(1);
});

test('the admin can decline an accepted quote until a contract, event or invoice exists', async () => {
  const { quoteId } = await acceptedQuote();
  const res = await request(adminApp).post(`/api/admin/quotes/${quoteId}/decline`).set(auth)
    .send({ reason: 'Kunde hat abgesagt' });
  expect(res.status).toBe(200);
  const quote = await db('quotes').where({ id: quoteId }).first();
  expect(quote.status).toBe('declined');
  expect(quote.decline_reason).toBe('Kunde hat abgesagt');
  // The acceptance stays on record; no copy is made.
  expect(quote.accepted_at).toBeTruthy();
  expect(await db('quotes').where({ replaces_quote_id: quoteId })).toHaveLength(0);

  const { quoteId: madeId } = await acceptedQuote();
  await db('invoices').insert({
    invoice_number: `I-DECLINE-${madeId}`, customer_account_id: customerId, status: 'sent',
    issue_date: '2026-09-01', due_date: '2026-09-15', source_quote_id: madeId,
  });
  const late = await request(adminApp).post(`/api/admin/quotes/${madeId}/decline`).set(auth).send({});
  expect(late.status).toBe(409);
  expect(late.body.code).toBe('QUOTE_CONVERTED');
  expect((await db('quotes').where({ id: madeId }).first()).status).toBe('accepted');
});

test('a quote something was made from can no longer be re-answered', async () => {
  // Converting leaves the quote accepted, and the response window is still
  // open: without the lock the customer could re-accept with other add-ons
  // and change the lines the contract's line table reads.
  const { quoteId, link } = await acceptedQuote();
  await db('invoices').insert({
    invoice_number: `I-REACCEPT-${quoteId}`, customer_account_id: customerId, status: 'sent',
    issue_date: '2026-09-01', due_date: '2026-09-15', source_quote_id: quoteId,
  });
  const again = await request(publicApp).post(`/api/public/quotes/${link}/respond`).set('X-Document-Access', await quoteGrant(link)).set('X-Forwarded-For', nextIp())
    .send({ action: 'accept', selectedOptional: [2, 3], expectedTotalMinor: 150000 });
  expect(again.status).toBe(409);
  expect(again.body.code).toBe('QUOTE_CONVERTED');
  const lines = await db('quote_line_items').where({ quote_id: quoteId }).orderBy('position', 'asc');
  expect(lines.map((l) => isTruthyFlag(l.selected))).toEqual([true, false, true]);
});

test('a choice that would make the total negative is refused', async () => {
  // Base 1000, a booked add-on of 5000 and a manually typed -3000 line:
  // 3000 as it stands, -2000 once the add-on is removed. A quote is an offer,
  // never a credit note, so that choice can't be stored.
  const quoteId = await quoteService.createQuote({
    customerAccountId: customerId, currency: 'CHF', vatRate: 0, lineItems: [
      { position: 1, quantity: 1, description: 'Wedding day', unit_price_minor: 100000 },
      { position: 2, quantity: 1, description: 'Second shooter', unit_price_minor: 500000, is_optional: true, selected: true },
      { position: 3, quantity: 1, description: 'Rabatt', unit_price_minor: -300000 },
    ],
  }, adminId);
  await db('quotes').where({ id: quoteId }).update({ status: 'sent', sent_at: new Date().toISOString() });
  const link = await createPublicToken(db, 'quote_action_tokens', { quote_id: quoteId });
  const grant = await quoteGrant(link);

  const totals = await request(publicApp).get(`/api/public/quotes/${link}/totals`)
    .query({ selected: '' }).set('X-Document-Access', grant).set('X-Forwarded-For', nextIp());
  expect(totals.status).toBe(409);
  expect(totals.body.code).toBe('QUOTE_TOTAL_NEGATIVE');

  const accept = await request(publicApp).post(`/api/public/quotes/${link}/respond`).set('X-Document-Access', grant).set('X-Forwarded-For', nextIp())
    .send({ action: 'accept', selectedOptional: [], expectedTotalMinor: -200000 });
  expect(accept.status).toBe(409);
  expect(accept.body.code).toBe('QUOTE_TOTAL_NEGATIVE');
  expect((await db('quotes').where({ id: quoteId }).first()).status).toBe('sent');
});

test('an answer that read the quote before it was converted doesn\'t land', async () => {
  // The conversion commits between the checks at the top of recordResponse
  // and its write. Without the status in the WHERE, a decline that read
  // `accepted` would flip a quote a contract was already made from.
  const { quoteId, link } = await acceptedQuote();
  globalThis.__duringResponse = () => db('quotes').where({ id: quoteId }).update({ status: 'converted' });
  const late = await request(publicApp).post(`/api/public/quotes/${link}/respond`)
    .set('X-Document-Access', await quoteGrant(link)).set('X-Forwarded-For', nextIp())
    .send({ action: 'decline' });
  globalThis.__duringResponse = null;

  expect(late.status).toBe(409);
  expect(late.body.code).toBe('QUOTE_CHANGED');
  expect((await db('quotes').where({ id: quoteId }).first()).status).toBe('converted');
});

test('editing an accepted quote says to reissue it', async () => {
  const { quoteId } = await acceptedQuote();
  const res = await request(adminApp).put(`/api/admin/quotes/${quoteId}`).set(auth).send({ eventName: 'Changed' });
  expect(res.status).toBe(409);
  expect(res.body.code).toBe('QUOTE_LOCKED');
  expect(res.body.error).toMatch(/Reissue it/);
});
