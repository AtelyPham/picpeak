import type { TFunction } from 'i18next';

/** The parts of a failed quote API request the message needs. */
interface QuoteApiError {
  response?: { data?: { code?: string; error?: string } };
  message?: string;
}

/**
 * Admin-facing text for a failed quote request. An error the admin can act
 * on gets a translated message that says what to do; anything else shows
 * the server's message.
 */
export function quoteErrorText(err: unknown, t: TFunction, fallback: string): string {
  const e = (err ?? {}) as QuoteApiError;
  if (e.response?.data?.code === 'RATE_REQUIRED') {
    return t('quotes.errors.rateRequired',
      'No rate for this customer and no default rate. Set a default hourly or day rate under Settings → Accounting, or a rate on the customer.');
  }
  return e.response?.data?.error || e.message || fallback;
}
