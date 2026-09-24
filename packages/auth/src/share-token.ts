import { createHash, randomBytes } from 'node:crypto';

import {
  decryptCredential,
  type EncryptedCredential,
  encryptCredential,
} from './credential-cipher';

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
 * 256 bits of randomness. The hash is what a request is looked up by. Since
 * the ADR-044 addendum of 2026-09-24 the raw value is also kept, sealed with
 * the deployment's credential key, so a workspace's admins can copy a link
 * again: a link exists to be passed on, and hiding it after creation only made
 * people mint a second one. A database dump alone still yields no link.
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

/**
 * The additional authenticated data a sealed token is bound to.
 *
 * The page, not the share row: the row's id does not exist before the insert,
 * and binding to the page is what matters, because a ciphertext copied onto a
 * grant for another page then fails to open instead of revealing a link that
 * serves something else.
 */
function sealPurpose(documentId: string): string {
  return `document-share-link:${documentId}`;
}

export function sealShareToken(input: {
  key: Buffer;
  documentId: string;
  secret: string;
}): EncryptedCredential {
  return encryptCredential({
    key: input.key,
    purpose: sealPurpose(input.documentId),
    plaintext: input.secret,
  });
}

export function openShareToken(input: {
  key: Buffer;
  documentId: string;
  record: EncryptedCredential;
}): string {
  return decryptCredential({
    key: input.key,
    purpose: sealPurpose(input.documentId),
    record: input.record,
  });
}
