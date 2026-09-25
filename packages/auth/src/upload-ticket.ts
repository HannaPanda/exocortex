import { createHash, randomBytes } from 'node:crypto';

/**
 * Upload-ticket secrets (ADR-064).
 *
 * The fourth credential of this shape, after `api-token.ts`,
 * `invitation-token.ts` and `share-token.ts`, and kept apart from all three for
 * the reason those files give each other: two credentials that share a format
 * or a lookup path can be accepted where the other was meant. This one names a
 * single upload into a single place for ten minutes. It travels in a path
 * segment and nowhere else, so it can never arrive as an `Authorization`
 * header and be mistaken for a bearer credential.
 *
 * 256 bits of randomness. The stored hash is domain-separated with a purpose
 * string, so a value that happens to be valid in another table's hash column
 * still matches nothing here. Nothing is sealed or kept: the secret is shown
 * once, when the ticket is minted, and a ticket nobody used simply expires.
 */

const HASH_PURPOSE = 'attachment-upload-ticket:';

export interface GeneratedUploadTicket {
  secret: string;
  tokenHash: string;
}

export function generateUploadTicket(): GeneratedUploadTicket {
  const secret = randomBytes(32).toString('base64url');
  return { secret, tokenHash: hashUploadTicket(secret) };
}

export function hashUploadTicket(secret: string): string {
  return createHash('sha256')
    .update(HASH_PURPOSE + secret, 'utf8')
    .digest('hex');
}

/**
 * Whether a string could be a ticket at all.
 *
 * Cheap rejection before the database is touched: the redeem route is public,
 * so obvious nonsense must cost no query. It says nothing about validity.
 */
export function looksLikeUploadTicket(value: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(value);
}

/**
 * The address a script POSTs the file to. `appUrl` has no trailing slash by
 * config validation, the same assumption `shareUrl` makes.
 */
export function uploadTicketUrl(appUrl: string, secret: string): string {
  return `${appUrl}/api/attachments/upload/${encodeURIComponent(secret)}`;
}
