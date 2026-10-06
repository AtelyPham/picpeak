/**
 * Discounts on a quote (#1451): ticking a promotion adds its discount line
 * with the promotion's description as the line's comment, which the PDF
 * prints under the name.
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';
import { DiscountsPanel } from '../DiscountsPanel';
import { LineItemsTable } from '../../LineItemsTable';
import type { QuotePromotion } from '../../../../services/quoteCatalog.service';

// Resolve against the real en.json so a missing key shows up as a failure.
vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  const en = (await import('../../../../i18n/locales/en.json')).default as Record<string, unknown>;
  const lookup = (key: string): string | undefined =>
    key.split('.').reduce<unknown>(
      (node, part) => (node && typeof node === 'object'
        ? (node as Record<string, unknown>)[part] : undefined),
      en,
    ) as string | undefined;
  return {
    ...actual,
    useTranslation: () => ({
      t: (k: string, fb?: unknown) => lookup(k) ?? (typeof fb === 'string' ? fb : k),
      i18n: { language: 'en' },
    }),
  };
});

const promotion = (over: Partial<QuotePromotion> = {}): QuotePromotion => ({
  id: 7,
  name: 'Vereinskondition',
  description: 'Sonderkondition für gemeinnützige Vereine',
  type: 'fixed',
  valueMinor: 30000,
  currency: 'CHF',
  percent: null,
  validFrom: null,
  validUntil: null,
  displayOrder: 0,
  isActive: true,
  ...over,
});

test('ticking a promotion adds its line with the description as the comment', async () => {
  const onChange = vi.fn();
  render(<DiscountsPanel promotions={[promotion()]} items={[]} currency="CHF" onChange={onChange} />);
  await userEvent.click(screen.getByRole('checkbox', { name: /Vereinskondition/ }));
  expect(onChange).toHaveBeenCalledWith([expect.objectContaining({
    lineKind: 'discount',
    promotionId: 7,
    description: 'Vereinskondition',
    detailsText: 'Sonderkondition für gemeinnützige Vereine',
  })]);
});

test('the editor shows a discount line\'s comment, ready to edit', () => {
  render(<LineItemsTable currency="CHF" onChange={() => {}} items={[
    { position: 1, quantity: 1, description: 'Wedding day', unitPrice: 1000, discountPercent: 0, parentPosition: null },
    {
      position: 2, quantity: 1, description: 'Vereinskondition', unitPrice: 0, discountPercent: 0, parentPosition: null,
      lineKind: 'discount', detailsText: 'Sonderkondition für gemeinnützige Vereine',
      promotionSnapshot: { promotionId: 7, name: 'Vereinskondition', type: 'fixed', valueMinor: 30000, currency: 'CHF' },
    },
  ]} />);
  expect(screen.getByDisplayValue('Sonderkondition für gemeinnützige Vereine')).toBeTruthy();
  // Numbered like any other line, as on the PDF.
  const row = screen.getByText('Vereinskondition').closest('tr') as HTMLElement;
  expect(within(row).getByText('2')).toBeTruthy();
});

test('a promotion without a description adds a line without a comment', async () => {
  const onChange = vi.fn();
  render(<DiscountsPanel promotions={[promotion({ description: null })]} items={[]} currency="CHF" onChange={onChange} />);
  await userEvent.click(screen.getByRole('checkbox', { name: /Vereinskondition/ }));
  expect(onChange).toHaveBeenCalledWith([expect.objectContaining({ lineKind: 'discount', detailsText: '' })]);
});
