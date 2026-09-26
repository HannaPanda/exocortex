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
 *
 * The same format carries the API's calls into the collaboration server
 * (`collaboration-write`, ADR-016). The purpose is part of the signed payload
 * and every verifier states which one it accepts, so a token minted for one
 * service can never be replayed against the other.
 */

/**
 * What a service token may be used for. Each purpose is signed with the secret
 * shared by exactly the two processes that speak to each other:
 * `ai-tools` with `SERVICE_TOKEN_SECRET` (worker -> API),
 * `mcp-tools` with `SERVICE_TOKEN_SECRET` (API -> API, for a remote MCP
 * client that authenticated with OAuth and therefore holds no `exo_` token
 * the tool catalogue could pass through),
 * `collaboration-write` with `COLLABORATION_TICKET_SECRET` (API -> Hocuspocus).
 */
export const SERVICE_TOKEN_PURPOSES = ['ai-tools', 'mcp-tools', 'collaboration-write'] as const;
export type ServiceTokenPurpose = (typeof SERVICE_TOKEN_PURPOSES)[number];

export interface ServiceTokenClaims {
  userId: string;
  purpose: ServiceTokenPurpose;
  /** Unix timestamp in milliseconds. */
  expiresAt: number;
  /**
   * The AI run whose tool loop holds this token (issue #140), when one does.
   *
   * Signed, so the API can tie what a request raises to the run that raised
   * it without taking a run id from a request body: a human checkpoint that
   * pauses a run has to name that run, and a name the caller could choose is
   * one it could choose wrongly on purpose.
   */
  runId?: string;
  /**
   * The write mode the run is held to (issue #141), when it is not `direct`.
   * Signed for the reason `runId` is: `TokenScopeGuard` refuses every request
   * the mode does not allow, so the model cannot write around the worker's own
   * check, and nothing a request says can loosen it.
   */
  writeMode?: 'read_only' | 'propose';
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
  purpose: ServiceTokenPurpose;
  ttlSeconds: number;
  /** See `ServiceTokenClaims.runId`. */
  runId?: string;
  /** See `ServiceTokenClaims.writeMode`. */
  writeMode?: 'read_only' | 'propose';
  now?: number;
}

export interface IssuedServiceToken {
  token: string;
  expiresAt: number;
}

/** The payload has every field of the current format, each of the right type. */
function isWellFormed(payload: ServiceTokenPayload): boolean {
  return (
    payload.v === 1 &&
    typeof payload.userId === 'string' &&
    SERVICE_TOKEN_PURPOSES.includes(payload.purpose) &&
    typeof payload.expiresAt === 'number' &&
    (payload.runId === undefined || typeof payload.runId === 'string') &&
    (payload.writeMode === undefined ||
      payload.writeMode === 'read_only' ||
      payload.writeMode === 'propose')
  );
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
    ...(options.runId === undefined ? {} : { runId: options.runId }),
    ...(options.writeMode === undefined ? {} : { writeMode: options.writeMode }),
    nonce: randomBytes(9).toString('base64url'),
  };
  const encoded = base64UrlEncode(Buffer.from(JSON.stringify(payload), 'utf8'));
  const signature = sign(options.secret, encoded);
  return { token: `${SERVICE_TOKEN_PREFIX}${encoded}.${signature}`, expiresAt };
}

export type ServiceTokenVerificationResult =
  | { valid: true; claims: ServiceTokenClaims }
  | { valid: false; reason: 'malformed' | 'bad_signature' | 'expired' | 'wrong_purpose' };

export interface VerifyServiceTokenOptions {
  secret: string;
  token: string;
  /**
   * The purposes this verifier accepts. A token signed for a different purpose
   * is rejected even when the signature is valid, which keeps the service
   * paths separate should they ever share a secret. A list, because the API
   * accepts two kinds of caller on the same door: the worker's tool loop and
   * its own MCP endpoint.
   */
  expectedPurpose: ServiceTokenPurpose | readonly ServiceTokenPurpose[];
  now?: number;
}

/**
 * Verifies a service token against the secret, the expected purpose and its
 * expiry.
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

  if (!isWellFormed(payload)) return { valid: false, reason: 'malformed' };

  const accepted = Array.isArray(options.expectedPurpose)
    ? options.expectedPurpose
    : [options.expectedPurpose as ServiceTokenPurpose];
  if (!accepted.includes(payload.purpose)) {
    return { valid: false, reason: 'wrong_purpose' };
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
      ...(payload.runId === undefined ? {} : { runId: payload.runId }),
      ...(payload.writeMode === undefined ? {} : { writeMode: payload.writeMode }),
    },
  };
}
