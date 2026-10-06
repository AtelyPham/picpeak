/**
 * The quote editor's save payload: a field the admin cleared is sent as
 * null so the save clears it. Sent as undefined it dropped out of the
 * request, the server kept the old value, and the text came back after
 * saving. Fields where "empty" means "use the default" stay undefined.
 */
import { describe, it, expect } from 'vitest';
import { buildPayload } from '../QuoteEditorPage';

type Form = Parameters<typeof buildPayload>[0];

const form = (over: Partial<Form> = {}): Form => ({
  customerAccountId: 3,
  language: 'de',
  currency: 'CHF',
  issueDate: '2026-09-15',
  validUntil: '',
  eventName: '',
  eventDate: '',
  eventType: '',
  bookingWorkflowId: null,
  eventTimeStart: '',
  eventTimeEnd: '',
  expectedDurationHours: '',
  paymentTermTemplateId: null,
  paymentNetDaysTemplateId: null,
  paymentTimingTemplateId: null,
  installments: [],
  vatRate: 0,
  vatCode: null,
  shippingAmount: 0,
  introText: '',
  outroText: '',
  internalNotes: '',
  ccPdfEmail: '',
  businessBankAccountId: null,
  projectId: null,
  hours: null,
  days: null,
  lineItems: [],
  ...over,
} as unknown as Form);

describe('buildPayload', () => {
  it('sends cleared texts and event details as null, so the save clears them', () => {
    const payload = buildPayload(form());
    expect(payload).toEqual(expect.objectContaining({
      introText: null, outroText: null, internalNotes: null, ccPdfEmail: null,
      eventName: null, eventDate: null, eventTimeStart: null, eventTimeEnd: null, expectedDurationHours: null,
    }));
  });

  it('sends what the admin typed', () => {
    const payload = buildPayload(form({ introText: 'Hallo', outroText: 'Grüsse', eventName: 'Hochzeit' }));
    expect(payload).toEqual(expect.objectContaining({ introText: 'Hallo', outroText: 'Grüsse', eventName: 'Hochzeit' }));
  });

  it('leaves out an empty valid-until date, which means "use the default"', () => {
    expect(buildPayload(form()).validUntil).toBeUndefined();
  });
});
