import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { type ApiTokenScope } from '@exocortex/contracts';

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

/**
 * Which scope a request needs, derived from the request itself.
 *
 * Derived rather than declared on purpose. A `@RequiredScope()` decorator would
 * have to be remembered on every new route, and the one that gets forgotten is
 * the one that ends up reachable by a read-only token. Deriving it means a route
 * added tomorrow is covered today, and the worst a mistake can do is demand too
 * much authority instead of too little.
 *
 * `path` is the request path without the query string.
 */
export function requiredScopeForRequest(method: string, path: string): ApiTokenScope {
  // Managing tokens with a token is how a narrow credential widens itself into
  // a broad one, so it sits at the top level together with the admin API.
  if (path.startsWith('/api/admin') || path.startsWith('/api/me/api-tokens')) return 'admin';
  return SAFE_METHODS.has(method.toUpperCase()) ? 'read' : 'write';
}

/** Safe methods in the HTTP sense: they do not change server state. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Rank of each scope; a scope implies every scope below it. */
const SCOPE_RANK: Record<ApiTokenScope, number> = { read: 0, write: 1, admin: 2 };

/**
 * Whether a token carrying `granted` may perform something that needs
 * `required`. Scopes are cumulative, so `admin` satisfies `write` and `read`.
 *
 * An empty list grants nothing. Tokens issued before scopes existed have an
 * empty array in the database, and "no scopes recorded" must not be read as
 * "every scope": that would make the whole mechanism decorative. Those rows are
 * migrated explicitly; anything left over fails closed.
 */
export function tokenHasScope(granted: readonly string[], required: ApiTokenScope): boolean {
  const needed = SCOPE_RANK[required];
  return granted.some((scope) => isApiTokenScope(scope) && SCOPE_RANK[scope] >= needed);
}

function isApiTokenScope(value: string): value is ApiTokenScope {
  return value === 'read' || value === 'write' || value === 'admin';
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
