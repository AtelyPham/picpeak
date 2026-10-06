/**
 * Email code step for signatures v2 (#1446): send a code, enter it, get a
 * signing session. Each server answer gets its own plain message. The screen
 * is the shared DocumentVerificationStep, so these pin the adapter: the calls,
 * the session it hands on, and this flow's error codes.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';

// Resolve against the real en.json so a missing key shows up as a failure.
vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  const en = (await import('../../../i18n/locales/en.json')).default as Record<string, unknown>;
  const lookup = (key: string): string | undefined =>
    key.split('.').reduce<unknown>(
      (node, part) => (node && typeof node === 'object'
        ? (node as Record<string, unknown>)[part] : undefined),
      en,
    ) as string | undefined;
  return {
    ...actual,
    useTranslation: () => ({
      t: (k: string, fb?: unknown, opts?: Record<string, unknown>) => {
        const base = lookup(k) ?? (typeof fb === 'string' ? fb : k);
        const vars = (typeof fb === 'object' && fb ? fb : opts) as Record<string, unknown> | undefined;
        if (!vars) return base;
        return base.replace(/\{\{(\w+)\}\}/g, (_m, key) => String(vars[key] ?? ''));
      },
      i18n: { language: 'en', changeLanguage: vi.fn(async () => undefined) },
    }),
  };
});

const requestCode = vi.fn();
const verify = vi.fn();
vi.mock('../../../services/publicContractSigning.service', async () => {
  const actual = await vi.importActual<typeof import('../../../services/publicContractSigning.service')>(
    '../../../services/publicContractSigning.service',
  );
  return {
    ...actual,
    publicContractSigningService: {
      ...actual.publicContractSigningService,
      requestCode: (...args: unknown[]) => requestCode(...args),
      verify: (...args: unknown[]) => verify(...args),
    },
  };
});

import { OtpVerifyStep } from '../OtpVerifyStep';

const TOKEN = 'a'.repeat(64);
const ISSUER = { companyName: 'Studio Nord' };
const SESSION = { sessionToken: 'b'.repeat(64), expiresAt: '2099-01-01T00:00:00.000Z' };
const httpError = (status: number, data: Record<string, unknown>) => Object.assign(
  new Error(`Request failed with status code ${status}`),
  { isAxiosError: true, response: { status, data } },
);

beforeEach(() => {
  vi.clearAllMocks();
  requestCode.mockResolvedValue({ maskedEmail: 'an***@ex***.com', ttlMinutes: 15, resendAfterSeconds: 0 });
});

it('sends a code, says when it is wrong, and hands the session on once it is right', async () => {
  const user = userEvent.setup();
  const onVerified = vi.fn();
  verify
    .mockRejectedValueOnce(httpError(400, { error: 'That code isn\'t right.', code: 'OTP_WRONG' }))
    .mockResolvedValueOnce(SESSION);
  render(<OtpVerifyStep token={TOKEN} maskedEmail="an***@ex***.com" issuer={ISSUER} isDark={false} onVerified={onVerified} />);

  expect(screen.getByText(/We'll email a 6-digit code to an\*\*\*@ex\*\*\*\.com/)).toBeInTheDocument();
  // The same screen as a quote: the document itself stays out of view.
  expect(screen.queryByText(/Contract/)).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Send code' }));

  expect(await screen.findByText('We sent a code to an***@ex***.com.')).toBeInTheDocument();
  expect(requestCode).toHaveBeenCalledWith(TOKEN);

  const input = screen.getByLabelText('6-digit code');
  expect(input).toHaveAttribute('inputmode', 'numeric');
  expect(input).toHaveAttribute('autocomplete', 'one-time-code');
  await user.type(input, '12a3456');
  expect(input).toHaveValue('123456');

  await user.click(screen.getByRole('button', { name: 'Confirm' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('That code isn\'t right. Check the latest email and enter the six digits again.');
  expect(onVerified).not.toHaveBeenCalled();

  await user.clear(input);
  await user.type(input, '654321');
  await user.click(screen.getByRole('button', { name: 'Confirm' }));

  await waitFor(() => expect(onVerified).toHaveBeenCalledWith(SESSION));
  expect(verify).toHaveBeenLastCalledWith(TOKEN, '654321');
});

it('explains an expired code, a locked code and a code asked for too soon', async () => {
  const user = userEvent.setup();
  verify
    .mockRejectedValueOnce(httpError(410, { code: 'OTP_EXPIRED' }))
    .mockRejectedValueOnce(httpError(429, { code: 'OTP_LOCKED' }));
  render(<OtpVerifyStep token={TOKEN} maskedEmail="an***@ex***.com" issuer={ISSUER} isDark={false} onVerified={vi.fn()} />);
  await user.click(screen.getByRole('button', { name: 'Send code' }));
  const input = await screen.findByLabelText('6-digit code');

  await user.type(input, '111111');
  await user.click(screen.getByRole('button', { name: 'Confirm' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('This code has expired or was already used. Send a new code.');

  await user.click(screen.getByRole('button', { name: 'Confirm' }));
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Too many wrong tries for this code. Send a new code.'));

  // The throttle answers as the quote's code does, and the shared step
  // counts down rather than showing a message of this flow's own.
  requestCode.mockRejectedValueOnce(httpError(429, { code: 'VERIFICATION_RATE_LIMITED', retryAfterSeconds: 42 }));
  await user.click(screen.getByRole('button', { name: 'Send a new code' }));
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Please wait 42 seconds before requesting another code.'));
  expect(screen.getByRole('button', { name: 'Send a new code in 42 s' })).toBeDisabled();
});

it('says so when the code could not be sent, and counts down after one that was', async () => {
  const user = userEvent.setup();
  requestCode
    .mockRejectedValueOnce(httpError(503, { code: 'EMAIL_UNAVAILABLE' }))
    .mockResolvedValueOnce({ maskedEmail: 'an***@ex***.com', ttlMinutes: 15, resendAfterSeconds: 60 });
  render(<OtpVerifyStep token={TOKEN} maskedEmail="an***@ex***.com" issuer={ISSUER} isDark={false} onVerified={vi.fn()} />);

  await user.click(screen.getByRole('button', { name: 'Send code' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('The code could not be sent right now.');
  expect(screen.queryByLabelText('6-digit code')).toBeNull();

  await user.click(screen.getByRole('button', { name: 'Send code' }));
  expect(await screen.findByLabelText('6-digit code')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Send a new code in 60 s' })).toBeDisabled();
});

it('hands a withdrawn or replaced link to the page instead of showing a code error', async () => {
  const user = userEvent.setup();
  const onLinkError = vi.fn();
  requestCode.mockRejectedValueOnce(httpError(410, { code: 'SIGNING_LINK_REVOKED' }));
  render(<OtpVerifyStep token={TOKEN} maskedEmail="an***@ex***.com" issuer={ISSUER} isDark={false} onVerified={vi.fn()} onLinkError={onLinkError} />);

  await user.click(screen.getByRole('button', { name: 'Send code' }));

  await waitFor(() => expect(onLinkError).toHaveBeenCalledWith('SIGNING_LINK_REVOKED'));
  expect(screen.queryByRole('alert')).toBeNull();
});
