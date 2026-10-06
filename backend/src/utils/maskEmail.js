'use strict';

/**
 * The address a public page may show before the visitor has proved who they
 * are: enough to recognise their own, not enough to learn someone else's.
 *
 *   kunde@test.test            → ku***@te***.test
 *   anna.muster@example.com    → an***@ex***.com
 *
 * The first two characters of the name and of the domain, and the top-level
 * domain. One rule for every document — the quote and contract verification
 * steps and the v2 signing invite all show it, and a customer shouldn't see
 * their address masked two different ways.
 *
 * @param {string|null|undefined} email
 * @returns {string|null} null when there is no address to hint at
 */
function maskEmail(email) {
  if (typeof email !== 'string') return null;
  const at = email.lastIndexOf('@');
  if (at < 1 || at === email.length - 1) return null;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const dot = domain.lastIndexOf('.');
  const name = dot > 0 ? domain.slice(0, dot) : domain;
  const tld = dot > 0 ? domain.slice(dot) : '';
  return `${local.slice(0, 2)}***@${name.slice(0, 2)}***${tld}`;
}

module.exports = { maskEmail };
