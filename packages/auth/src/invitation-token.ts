import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Invitation tokens (issue #3).
 *
 * The same shape as `api-token.ts`, for the same reasons: the raw value is
 * returned once and only its SHA-256 is stored, so a database dump cannot be
 * replayed into accounts, and a plain hash rather than a password KDF is correct
 * because the secret is 256 bits of entropy with nothing to brute-force and
 * lookup has to stay a single indexed query.
 *
 * It is a separate file rather than a parameter on the API-token helpers because
 * the two credentials must never be interchangeable: an invitation token creates
 * an account and then dies, an API token acts as one indefinitely. Sharing a
 * prefix or a lookup path between them is how one gets accepted where the other
 * was meant.
 */

/** Prefix of an invitation token, so it is recognisable in a link and a log. */
export const INVITATION_TOKEN_PREFIX = 'exoinv_';

export interface GeneratedInvitationToken {
  secret: string;
  tokenHash: string;
}

export function generateInvitationToken(): GeneratedInvitationToken {
  const secret = `${INVITATION_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
  return { secret, tokenHash: hashInvitationToken(secret) };
}

export function hashInvitationToken(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

/** Constant-time comparison for two hex hashes. */
export function invitationTokenHashesMatch(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, 'utf8');
  const bufferB = Buffer.from(b, 'utf8');
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}

/**
 * Whether a string could be an invitation token at all.
 *
 * Cheap rejection before the database is touched, so a flood of obvious
 * nonsense on the public redemption route costs no query. It says nothing about
 * validity.
 */
export function looksLikeInvitationToken(value: string): boolean {
  return value.startsWith(INVITATION_TOKEN_PREFIX) && value.length > INVITATION_TOKEN_PREFIX.length;
}

/** The link a person clicks. `appUrl` has no trailing slash by config validation. */
export function invitationUrl(appUrl: string, secret: string): string {
  return `${appUrl}/einladung/${encodeURIComponent(secret)}`;
}
