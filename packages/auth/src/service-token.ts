import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { SERVICE_TOKEN_PREFIX } from './api-token';

/**
 * Short-lived, signed service tokens (D3).
 *
 * The worker mints one of these per AI run so its tool loop can call back into
 * the REST API authenticated as the run's own user -- every tool call is
 * authorized exactly as that human would be, with no long-lived shared
 * credential and no database row per run. Modelled directly on
 * `collaboration-ticket.ts`: base64url payload, `.`-separated HMAC-SHA256
 * signature, constant-time comparison, discriminated verification result.
 */

export interface ServiceTokenClaims {
  userId: string;
  purpose: 'ai-tools';
  /** Unix timestamp in milliseconds. */
  expiresAt: number;
}

interface ServiceTokenPayload extends ServiceTokenClaims {
  /** Random value so two tokens for the same claims differ. */
  nonce: string;
  /** Format version, so the wire format can evolve. */
  v: 1;
}

function base64UrlEncode(value: Buffer): string {
  return value.toString('base64url');
}

function sign(secret: string, data: string): string {
  return base64UrlEncode(createHmac('sha256', secret).update(data).digest());
}

export interface IssueServiceTokenOptions {
  secret: string;
  userId: string;
  purpose: 'ai-tools';
  ttlSeconds: number;
  now?: number;
}

export interface IssuedServiceToken {
  token: string;
  expiresAt: number;
}

/** Issues a service token. */
export function issueServiceToken(options: IssueServiceTokenOptions): IssuedServiceToken {
  const now = options.now ?? Date.now();
  const expiresAt = now + options.ttlSeconds * 1_000;
  const payload: ServiceTokenPayload = {
    v: 1,
    userId: options.userId,
    purpose: options.purpose,
    expiresAt,
    nonce: randomBytes(9).toString('base64url'),
  };
  const encoded = base64UrlEncode(Buffer.from(JSON.stringify(payload), 'utf8'));
  const signature = sign(options.secret, encoded);
  return { token: `${SERVICE_TOKEN_PREFIX}${encoded}.${signature}`, expiresAt };
}

export type ServiceTokenVerificationResult =
  | { valid: true; claims: ServiceTokenClaims }
  | { valid: false; reason: 'malformed' | 'bad_signature' | 'expired' };

export interface VerifyServiceTokenOptions {
  secret: string;
  token: string;
  now?: number;
}

/**
 * Verifies a service token against the secret and its expiry.
 *
 * Returns a discriminated result instead of throwing so the caller can log the
 * precise reason while returning a generic error to the client.
 */
export function verifyServiceToken(
  options: VerifyServiceTokenOptions,
): ServiceTokenVerificationResult {
  const withoutPrefix = options.token.startsWith(SERVICE_TOKEN_PREFIX)
    ? options.token.slice(SERVICE_TOKEN_PREFIX.length)
    : options.token;

  const parts = withoutPrefix.split('.');
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

  let payload: ServiceTokenPayload;
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as ServiceTokenPayload;
  } catch {
    return { valid: false, reason: 'malformed' };
  }

  if (
    payload.v !== 1 ||
    typeof payload.userId !== 'string' ||
    payload.purpose !== 'ai-tools' ||
    typeof payload.expiresAt !== 'number'
  ) {
    return { valid: false, reason: 'malformed' };
  }

  const now = options.now ?? Date.now();
  if (payload.expiresAt <= now) {
    return { valid: false, reason: 'expired' };
  }

  return {
    valid: true,
    claims: {
      userId: payload.userId,
      purpose: payload.purpose,
      expiresAt: payload.expiresAt,
    },
  };
}
