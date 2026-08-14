import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { type CollaborationAccess } from '@exocortex/contracts';

/**
 * Short-lived, signed collaboration tickets.
 *
 * A ticket is the only thing the browser hands to the collaboration server. It
 * is scoped to exactly one document and one access mode, expires within seconds
 * and is signed with a secret the browser never sees. Permanent authentication
 * material (session cookies, Better Auth secret) is never passed to the
 * collaboration server (ADR-004, docs/security.md).
 */

export interface CollaborationTicketClaims {
  userId: string;
  documentId: string;
  access: CollaborationAccess;
  /** Unix timestamp in milliseconds. */
  expiresAt: number;
}

interface TicketPayload extends CollaborationTicketClaims {
  /** Random value so two tickets for the same claims differ. */
  nonce: string;
  /** Format version, so the wire format can evolve. */
  v: 1;
}

export type TicketVerificationFailure =
  'malformed' | 'bad_signature' | 'expired' | 'document_mismatch';

export type TicketVerificationResult =
  | { valid: true; claims: CollaborationTicketClaims }
  | { valid: false; reason: TicketVerificationFailure };

function base64UrlEncode(value: Buffer): string {
  return value.toString('base64url');
}

function sign(secret: string, data: string): string {
  return base64UrlEncode(createHmac('sha256', secret).update(data).digest());
}

export interface IssueTicketOptions {
  secret: string;
  userId: string;
  documentId: string;
  access: CollaborationAccess;
  ttlSeconds: number;
  now?: number;
}

export interface IssuedTicket {
  ticket: string;
  expiresAt: number;
}

/**
 * Issues a ticket. The caller must have resolved `access` through the policy
 * layer: a client-supplied access value is never accepted.
 */
export function issueCollaborationTicket(options: IssueTicketOptions): IssuedTicket {
  const now = options.now ?? Date.now();
  const expiresAt = now + options.ttlSeconds * 1_000;
  const payload: TicketPayload = {
    v: 1,
    userId: options.userId,
    documentId: options.documentId,
    access: options.access,
    expiresAt,
    nonce: randomBytes(9).toString('base64url'),
  };
  const encoded = base64UrlEncode(Buffer.from(JSON.stringify(payload), 'utf8'));
  const signature = sign(options.secret, encoded);
  return { ticket: `${encoded}.${signature}`, expiresAt };
}

export interface VerifyTicketOptions {
  secret: string;
  ticket: string;
  /** The document the connection is actually asking for. */
  expectedDocumentId: string;
  now?: number;
}

/**
 * Verifies a ticket against the secret, the expiry and the requested document.
 *
 * Returns a discriminated result instead of throwing so the caller can log the
 * precise reason while returning a generic error to the client.
 */
export function verifyCollaborationTicket(options: VerifyTicketOptions): TicketVerificationResult {
  const parts = options.ticket.split('.');
  if (parts.length !== 2) return { valid: false, reason: 'malformed' };

  const [encoded, signature] = parts as [string, string];
  const expected = sign(options.secret, encoded);
  const providedBuffer = Buffer.from(signature, 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  if (
    providedBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(providedBuffer, expectedBuffer)
  ) {
    return { valid: false, reason: 'bad_signature' };
  }

  let payload: TicketPayload;
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as TicketPayload;
  } catch {
    return { valid: false, reason: 'malformed' };
  }

  if (
    payload.v !== 1 ||
    typeof payload.userId !== 'string' ||
    typeof payload.documentId !== 'string' ||
    (payload.access !== 'read' && payload.access !== 'write') ||
    typeof payload.expiresAt !== 'number'
  ) {
    return { valid: false, reason: 'malformed' };
  }

  if (payload.documentId !== options.expectedDocumentId) {
    return { valid: false, reason: 'document_mismatch' };
  }

  const now = options.now ?? Date.now();
  if (payload.expiresAt <= now) {
    return { valid: false, reason: 'expired' };
  }

  return {
    valid: true,
    claims: {
      userId: payload.userId,
      documentId: payload.documentId,
      access: payload.access,
      expiresAt: payload.expiresAt,
    },
  };
}
