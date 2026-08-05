import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** Prefix of a persistent user token. */
export const API_TOKEN_PREFIX = 'exo_';
/** Prefix of a short-lived, HMAC-signed service token (see service-token.ts). */
export const SERVICE_TOKEN_PREFIX = 'exos_';

export interface GeneratedApiToken {
  secret: string;
  tokenHash: string;
  prefix: string;
}

/**
 * Creates a token. The raw secret is returned once; only its SHA-256 is stored.
 * A plain hash (not a password KDF) is correct here: the secret is 256 bits of
 * entropy, so there is nothing to brute-force, and lookup must stay a single
 * indexed query.
 */
export function generateApiToken(): GeneratedApiToken {
  const secret = `${API_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
  return {
    secret,
    tokenHash: hashApiToken(secret),
    prefix: secret.slice(0, 12),
  };
}

export function hashApiToken(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

/** Constant-time comparison for two hex hashes. */
export function apiTokenHashesMatch(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, 'utf8');
  const bufferB = Buffer.from(b, 'utf8');
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}

/** Extracts a bearer credential from raw Node headers. Returns null when absent. */
export function readBearerToken(
  headers: Record<string, string | string[] | undefined>,
): string | null {
  const raw = headers.authorization ?? headers.Authorization;
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined) return null;
  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  if (match === null) return null;
  const token = match[1]?.trim();
  return token !== undefined && token.length > 0 ? token : null;
}
