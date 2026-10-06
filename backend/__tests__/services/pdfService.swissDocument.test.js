/**
 * What a Swiss / Liechtenstein invoice needs (#1451 invoice pass), in the
 * shared quote + invoice renderer:
 *   - a business that isn't VAT-registered shows no VAT row on a document
 *     without VAT, and the VAT note stands in its place; never set, or a
 *     document that carries VAT, keeps the row;
 *   - the VAT number is named by the business's country (MWST-Nr. in CH/LI,
 *     USt-IdNr. in DE) and printed only when set; the contact labels are in
 *     the document language;
 *   - an invoice prints the date or period of the service, and its due date
 *     (not on a Storno).
 */

const PDFDocument = require('pdfkit');
const pdfService = require('../../src/services/pdfService');
const { builtInTheme } = require('../../src/services/pdf/theme');
const { t } = require('../../src/services/pdf-i18n');

const issuer = (extra = {}) => ({
  companyName: 'Studio Test', addressLine1: 'Weg 1', postalCode: '9490', city: 'Vaduz', countryCode: 'LI',
  phone: '+423 000 00 00', vatId: 'CHE-123.456.789 MWST', ...extra,
});

const line = { quantity: 1, description: 'Fotografie', unitPriceMinor: 10000, discountPercent: 0, lineTotalMinor: 10000 };
const totals = (vatRate = 0, vatAmountMinor = 0) => ({
  netAmountMinor: 10000, vatRate, vatAmountMinor, shippingAmountMinor: 0, totalAmountMinor: 10000 + vatAmountMinor,
});

const quoteContext = (extra = {}) => ({
  locale: 'de', currency: 'CHF', issuer: issuer(), recipient: { companyName: 'Kunde AG' },
  theme: builtInTheme('quote'), lineItems: [line], totals: totals(),
  doc: { quoteNumber: 'Q-2026-0001', issueDate: '2026-09-14', totalAmountMinor: 10000 },
  ...extra,
});

const invoiceContext = (doc = {}, extra = {}) => ({
  locale: 'de', currency: 'CHF', qrFormat: 'none', issuer: issuer(), recipient: { companyName: 'Kunde AG' },
  theme: builtInTheme('invoice'), lineItems: [line], totals: totals(),
  doc: {
    kind: 'invoice', invoiceNumber: 'R-2026-0001', issueDate: '2026-09-14', dueDate: '2026-10-14',
    totalAmountMinor: 10000, ...doc,
  },
  ...extra,
});

afterEach(() => jest.restoreAllMocks());

function drawnText() {
  const spy = jest.spyOn(PDFDocument.prototype, 'text');
  return () => spy.mock.calls.map((call) => String(call[0]));
}

const vatRow = t('de', 'totals_vat');

describe('the VAT row', () => {
  test('a business that isn\'t VAT-registered shows the note instead of a VAT row on an invoice without VAT', async () => {
    const drawn = drawnText();
    await pdfService.renderInvoiceToBuffer(invoiceContext({}, { vatRegistered: false, vatNote: 'Nicht mehrwertsteuerpflichtig.' }));
    expect(drawn()).not.toContain(vatRow);
    expect(drawn()).toContain('Nicht mehrwertsteuerpflichtig.');
  });

  test('a quote drops the VAT row too, but never carries the note', async () => {
    // The note is an invoice's statement about itself. normaliseContext drops
    // it for a quote whoever assembled the context — the theme preview and the
    // dev sampler build quote contexts by hand.
    const drawn = drawnText();
    await pdfService.renderQuoteToBuffer(quoteContext({ vatRegistered: false, vatNote: 'Nicht mehrwertsteuerpflichtig.' }));
    expect(drawn()).not.toContain(vatRow);
    expect(drawn()).not.toContain('Nicht mehrwertsteuerpflichtig.');
  });

  test('never set: the VAT row stays, as before', async () => {
    const drawn = drawnText();
    await pdfService.renderQuoteToBuffer(quoteContext({ vatRegistered: null }));
    expect(drawn()).toContain(vatRow);
  });

  test('a document that carries VAT keeps its row, so the totals add up', async () => {
    const drawn = drawnText();
    await pdfService.renderInvoiceToBuffer(invoiceContext({}, { vatRegistered: false, totals: totals(8.1, 810) }));
    expect(drawn()).toContain(vatRow);
  });
});

describe('the issuer block', () => {
  test('names the VAT number by the business\'s country, with labels in the document language', async () => {
    let drawn = drawnText();
    await pdfService.renderQuoteToBuffer(quoteContext());
    expect(drawn()).toEqual(expect.arrayContaining(['MWST-Nr.:', 'Tel.:']));
    expect(drawn()).not.toContain('VAT:');
    expect(drawn()).not.toContain('Phone:');

    jest.restoreAllMocks();
    drawn = drawnText();
    await pdfService.renderQuoteToBuffer(quoteContext({ issuer: issuer({ countryCode: 'DE', city: 'Berlin' }) }));
    expect(drawn()).toContain('USt-IdNr.:');
  });

  test('prints no VAT number line when the business has none', async () => {
    const drawn = drawnText();
    await pdfService.renderQuoteToBuffer(quoteContext({ issuer: issuer({ vatId: null }) }));
    expect(drawn().some((s) => /MWST-Nr|USt-IdNr|UID-Nr/.test(s))).toBe(false);
  });
});

describe('the invoice header', () => {
  test('prints the service date and the due date', async () => {
    const drawn = drawnText();
    await pdfService.renderInvoiceToBuffer(invoiceContext({ servicePeriod: { from: '2026-09-12', to: null } }));
    const texts = drawn();
    const at = texts.indexOf('Leistungsdatum:');
    expect(at).toBeGreaterThan(-1);
    expect(texts[at + 1]).toMatch(/12\D09\D2026|2026\D09\D12/);
    expect(texts).toContain('Fällig am:');
  });

  test('a monthly invoice prints its service period', async () => {
    const drawn = drawnText();
    await pdfService.renderInvoiceToBuffer(invoiceContext({ servicePeriod: { from: '2026-09-01', to: '2026-09-30' } }));
    const texts = drawn();
    const at = texts.indexOf('Leistungszeitraum:');
    expect(at).toBeGreaterThan(-1);
    expect(texts[at + 1]).toContain('–');
  });

  test('without an event date or period there is no service row', async () => {
    const drawn = drawnText();
    await pdfService.renderInvoiceToBuffer(invoiceContext({ servicePeriod: null }));
    expect(drawn()).not.toContain('Leistungsdatum:');
    expect(drawn()).not.toContain('Leistungszeitraum:');
  });

  test('a Storno prints no due date', async () => {
    const drawn = drawnText();
    await pdfService.renderInvoiceToBuffer(invoiceContext({
      kind: 'storno', cancelsInvoice: { number: 'R-2026-0000', issueDate: '2026-09-01' },
    }));
    expect(drawn()).not.toContain('Fällig am:');
  });
});
