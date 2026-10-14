import { createHash, randomBytes } from 'node:crypto';

/**
 * Download-ticket secrets (issue #204).
 *
 * The fifth credential of this shape and the mirror of `upload-ticket.ts`: a
 * single file, read once, within ten minutes. Kept apart from the upload
 * ticket for the reason those files give each other -- two credentials that
 * share a lookup path can be accepted where the other was meant -- which is
 * why the hash carries its own purpose string. A valid upload ticket hashes
 * to nothing here, and the redeem routes differ in method and path besides.
 */

const HASH_PURPOSE = 'attachment-download-ticket:';

export interface GeneratedDownloadTicket {
  secret: string;
  tokenHash: string;
}

export function generateDownloadTicket(): GeneratedDownloadTicket {
  const secret = randomBytes(32).toString('base64url');
  return { secret, tokenHash: hashDownloadTicket(secret) };
}

export function hashDownloadTicket(secret: string): string {
  return createHash('sha256')
    .update(HASH_PURPOSE + secret, 'utf8')
    .digest('hex');
}

/** Cheap rejection before the database is touched; says nothing about validity. */
export function looksLikeDownloadTicket(value: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(value);
}

/** The address a script GETs the file from. `appUrl` has no trailing slash. */
export function downloadTicketUrl(appUrl: string, secret: string): string {
  return `${appUrl}/api/attachments/download/${encodeURIComponent(secret)}`;
}
