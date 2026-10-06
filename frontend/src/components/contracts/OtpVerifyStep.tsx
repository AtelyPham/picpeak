/**
 * Confirm the signer's email (#1446): send a six-digit code to the address
 * the link was sent to, then enter it. A correct code opens a signing
 * session, handed to `onVerified`.
 *
 * The screen is the shared DocumentVerificationStep, so a signer sees the
 * same "confirm it's you" step as on a quote or a contract signed the old
 * way. What is specific to this flow lives here: the calls, the session it
 * returns, and the messages for its own error codes.
 *
 * Link-level problems (the link was replaced, has expired, or the contract
 * was withdrawn) go to `onLinkError` so the page can show its own message.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import {
  DocumentVerificationStep,
  type DocumentVerificationIssuer,
} from '../public/DocumentVerificationStep';
import {
  publicContractSigningService,
  signingErrorCode,
  signingErrorStatus,
  type SigningSession,
} from '../../services/publicContractSigning.service';

const LINK_ERROR_CODES = new Set([
  'SIGNING_LINK_INVALID', 'SIGNING_LINK_REVOKED', 'SIGNING_LINK_EXPIRED', 'CONTRACT_WITHDRAWN',
]);

interface OtpVerifyStepProps {
  token: string;
  /** The masked address from the invite, shown before a code is sent. */
  maskedEmail: string;
  issuer: DocumentVerificationIssuer | null;
  isDark: boolean;
  /** Shown above the explanation, e.g. when the signing session ended. */
  notice?: string | null;
  onVerified: (session: SigningSession) => void;
  onLinkError?: (code: string) => void;
}

export const OtpVerifyStep: React.FC<OtpVerifyStepProps> = ({
  token, maskedEmail, issuer, isDark, notice, onVerified, onLinkError,
}) => {
  const { t } = useTranslation();

  // A link problem is the page's to show, not a code error: hand it over and
  // let the page replace this step.
  const passLinkProblem = (err: unknown): never => {
    const errCode = signingErrorCode(err);
    if (errCode && LINK_ERROR_CODES.has(errCode) && onLinkError) onLinkError(errCode);
    throw err;
  };

  function describeError(err: unknown): string | null {
    const errCode = signingErrorCode(err);
    // Handed to the page, which replaces this step: nothing to show here.
    if (errCode && LINK_ERROR_CODES.has(errCode)) return '';
    // The throttle and a failed send answer exactly as the quote's code
    // does (#1465), so the shared step words them — and counts down.
    if (errCode === 'VERIFICATION_RATE_LIMITED' || errCode === 'EMAIL_UNAVAILABLE') return null;
    switch (errCode) {
      case 'OTP_WRONG':
        return t('contractSigning.otp.errors.wrong', 'That code isn\'t right. Check the latest email and enter the six digits again.');
      case 'OTP_EXPIRED':
        return t('contractSigning.otp.errors.expired', 'This code has expired or was already used. Send a new code.');
      case 'OTP_LOCKED':
        return t('contractSigning.otp.errors.locked', 'Too many wrong tries for this code. Send a new code.');
      default:
        break;
    }
    if (signingErrorStatus(err) === 429) {
      return t('contractSigning.otp.errors.tooManyRequests', 'Too many attempts from this connection. Wait a few minutes, then try again.');
    }
    if (!signingErrorStatus(err)) {
      return t('contractSigning.otp.errors.network', 'We couldn\'t reach the server. Check your connection and try again.');
    }
    return t('contractSigning.otp.errors.generic', 'Something went wrong. Try again; if it keeps happening, contact the sender.');
  }

  return (
    <DocumentVerificationStep<SigningSession>
      issuer={issuer}
      emailHint={maskedEmail}
      isDark={isDark}
      notice={notice}
      requestCode={() => publicContractSigningService.requestCode(token).then(
        (sent) => ({ sent: true, emailHint: sent.maskedEmail, resendAfterSeconds: sent.resendAfterSeconds ?? 0 }),
        passLinkProblem,
      )}
      confirmCode={(code) => publicContractSigningService.verify(token, code).catch(passLinkProblem)}
      onVerified={onVerified}
      describeError={describeError}
    />
  );
};
