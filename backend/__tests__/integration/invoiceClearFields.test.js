/**
 * Clearing a scheduled invoice's CC email and event snapshot on save.
 *
 * The invoice editor used to send a cleared field as undefined, which drops
 * the key from the request, so the PUT handler kept the old value and it
 * came back after saving. The editor now sends null; this pins the server
 * side of that contract through the real admin route (helpers/crmDb).
 */

const request = require('supertest');
const {
  bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken, buildRouteApp,
} = require('./helpers/crmDb');

jest.setTimeout(120000);

let db;
let cleanup;
let tmpDir;
let customerId;
let token;
let invoiceApp;

const prevCwd = process.cwd();
const auth = { get Authorization() { return `Bearer ${token}`; } };

async function enableFlag(key) {
  const updated = await db('feature_flags').where({ key }).update({ value: true });
  if (!updated) await db('feature_flags').insert({ key, value: true });
}

beforeAll(async () => {
  ({ db, cleanup, tmpDir } = await bootCrmDb());
  process.chdir(tmpDir);
  db.client.pool.acquireTimeoutMillis = 2000;
  let adminId;
  ({ adminId, customerId } = await seedMinimal(db));
  await assignAdminRole(db, adminId, 'super_admin');
  token = mintAdminToken(adminId);
  await enableFlag('bills');
  invoiceApp = buildRouteApp('/api/admin/invoices', require('../../src/routes/adminInvoices'));
}, 120000);

afterAll(async () => {
  process.chdir(prevCwd);
  if (cleanup) await cleanup();
});

test('a save that clears the CC email and the event snapshot clears them', async () => {
  const created = await request(invoiceApp).post('/api/admin/invoices').set(auth).send({
    customerAccountId: customerId,
    currency: 'CHF',
    vatRate: 0,
    ccPdfEmail: 'buchhaltung@example.com',
    eventName: 'Hochzeit Muster',
    eventDate: '2026-10-03',
    eventTimeStart: '14:00',
    eventTimeEnd: '23:00',
    lineItems: [{ position: 1, quantity: 1, description: 'Wedding coverage', unitPriceMinor: 200000, discountPercent: 0 }],
  });
  expect(created.status).toBe(201);
  const invoiceId = created.body.invoice.id;
  const before = await db('invoices').where({ id: invoiceId }).first();
  expect(before.event_name).toBe('Hochzeit Muster');

  const saved = await request(invoiceApp).put(`/api/admin/invoices/${invoiceId}`).set(auth).send({
    ccPdfEmail: null, eventName: null, eventDate: null, eventTimeStart: null, eventTimeEnd: null,
  });
  expect(saved.status).toBe(200);

  const after = await db('invoices').where({ id: invoiceId }).first();
  expect(after).toEqual(expect.objectContaining({
    cc_pdf_email: null, event_name: null, event_date: null, event_time_start: null, event_time_end: null,
  }));
});
