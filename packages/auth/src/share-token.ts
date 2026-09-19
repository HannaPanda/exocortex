import { createHash, randomBytes } from 'node:crypto';

/**
 * Public share-link tokens (issue #83, ADR-044).
 *
 * The third file of this shape, after `api-token.ts` and `invitation-token.ts`,
 * and separate from both for the reason the second one already gives: two
 * credentials that share a prefix or a lookup path are two credentials that can
 * be accepted where the other was meant. This one is the weakest of the three
 * on purpose -- it authenticates nobody, it only names a grant -- so it must
 * never be able to arrive as an `Authorization: Bearer` header and be mistaken
 * for one that does. It travels in a path segment and nowhere else.
 *
 * 256 bits of randomness, SHA-256 stored, raw value returned exactly once.
 * There is nothing to brute-force and nothing in the database to replay.
 */

/**
 * No prefix, unlike the other two.
 *
 * The value ends up in a URL people paste into chats and bookmark bars, and a
 * recognisable prefix is what makes a secret scannable. `exo_` also means
 * "bearer token" everywhere else in this system, and this is not one.
 */
export interface GeneratedShareToken {
  secret: string;
  tokenHash: string;
  /**
   * First eight characters. Enough for a person to tell two links apart in the
   * share list, far too few to reconstruct one.
   */
  prefix: string;
}

export function generateShareToken(): GeneratedShareToken {
  const secret = randomBytes(32).toString('base64url');
  return { secret, tokenHash: hashShareToken(secret), prefix: secret.slice(0, 8) };
}

export function hashShareToken(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

/**
 * Whether a string could be a share token at all.
 *
 * Cheap rejection before the database is touched: the public route is the one
 * surface here that anybody on the internet may call, so obvious nonsense must
 * cost no query. It says nothing about validity.
 */
export function looksLikeShareToken(value: string): boolean {
  return /^[A-Za-z0-9_-]{32,64}$/.test(value);
}

/** The address a person opens. `appUrl` has no trailing slash by config validation. */
export function shareUrl(appUrl: string, secret: string): string {
  return `${appUrl}/freigabe/${encodeURIComponent(secret)}`;
}
