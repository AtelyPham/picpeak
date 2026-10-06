/**
 * Does this /gallery/<identifier> segment look like a bare share token (a
 * short link) rather than a gallery slug? Then the gallery page resolves it
 * through the API instead of looking it up as a slug.
 *
 * 32 hex is what every gallery gets now. 64 hex: galleries converted from a
 * quote or a contract before that path minted a normal token; their links are
 * already in customers' inboxes, so they stay valid. Keep in step with
 * backend/src/utils/shareLinkUtils.js.
 */
const SHARE_TOKEN_PATTERN = /^(?:[0-9a-fA-F]{32}|[0-9a-fA-F]{64})$/;

export const isShareToken = (identifier: string | null | undefined): boolean =>
  !!identifier && SHARE_TOKEN_PATTERN.test(identifier);
