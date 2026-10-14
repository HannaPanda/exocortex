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
 * What a request does, derived from the request itself (issue #141).
 *
 * `read` changes nothing. `report` tells eXocortex how delegated work is
 * going: a work item's progress and notes, a checkpoint, a question to a
 * person and taking it back. `propose` puts forward a change without making
 * it: a changeset, its changes, handing it in, throwing a draft away. `write`
 * is everything else that changes state, deciding a changeset included,
 * because applying one is writing the pages. `admin` is the deployment and
 * the credentials themselves.
 *
 * The two middle classes are what a proposing agent needs and nothing more:
 * an API token with the `propose` scope, and the built-in AI in the propose
 * or read-only mode (which the worker signs into its service token), are
 * held to them here, on the server, whatever the tool loop decides.
 */
export type RequestClass = 'read' | 'report' | 'propose' | 'write' | 'admin';

const REPORT_ROUTES: readonly [string, RegExp][] = [
  ['PATCH', /^\/api\/work-items\/[^/]+$/],
  ['POST', /^\/api\/work-items\/[^/]+\/(notes|checkpoints)$/],
  // Handing a part on and waiting for it (issue #144): organising delegated
  // work rather than writing content. A child is held to the caller's mode.
  ['POST', /^\/api\/work-items\/[^/]+\/(delegate|await-children)$/],
  ['POST', /^\/api\/workspaces\/[^/]+\/attention$/],
  ['POST', /^\/api\/attention\/[^/]+\/withdraw$/],
];

const PROPOSE_ROUTES: readonly [string, RegExp][] = [
  ['POST', /^\/api\/workspaces\/[^/]+\/changesets$/],
  ['DELETE', /^\/api\/changesets\/[^/]+$/],
  ['POST', /^\/api\/changesets\/[^/]+\/(changes|submit)$/],
  ['DELETE', /^\/api\/changesets\/[^/]+\/changes\/[^/]+$/],
];

/** The draft writes of issue #165: create, revise, duplicate. */
const WORKFLOW_DRAFT_ROUTES: readonly [string, RegExp][] = [
  ['POST', /^\/api\/workspaces\/[^/]+\/workflows$/],
  ['PATCH', /^\/api\/workflows\/[^/]+$/],
  ['POST', /^\/api\/workflows\/[^/]+\/duplicate$/],
];

function matches(routes: readonly [string, RegExp][], method: string, path: string): boolean {
  return routes.some(([verb, pattern]) => verb === method && pattern.test(path));
}

/**
 * Derived rather than declared on purpose. A `@RequiredScope()` decorator would
 * have to be remembered on every new route, and the one that gets forgotten is
 * the one that ends up reachable by a read-only token. Deriving it means a route
 * added tomorrow is covered today, and the worst a mistake can do is demand too
 * much authority instead of too little.
 *
 * `path` is the request path without the query string.
 */
export function requestClassFor(method: string, path: string): RequestClass {
  const verb = method.toUpperCase();
  // Managing credentials with a credential is how a narrow one widens itself
  // into a broad one, so it sits at the top level together with the admin API.
  // `/api/me/connections` belongs here for the mirror image of that reason: it
  // can cut off *other* clients, and an agent that can disconnect the connector
  // watching it is an agent that can work unobserved.
  if (
    path.startsWith('/api/admin') ||
    path.startsWith('/api/me/api-tokens') ||
    path.startsWith('/api/me/connections')
  ) {
    return 'admin';
  }
  // Writing an automation rule is not an ordinary write (issue #50, ADR-024):
  // it is a standing instruction that keeps sending this workspace's data
  // outward, or keeps spending money on a model, long after the token that
  // created it has been forgotten about. Reading the rules and their run log is
  // an ordinary read, because what an automation has been doing is exactly what
  // the people it acts on should be able to check.
  if (path.includes('/automations') && !SAFE_METHODS.has(verb)) {
    return 'admin';
  }
  // An agent profile is the same kind of standing decision (issue #143,
  // ADR-071): it says what every run under it may use, write and spend, so a
  // token that may merely write pages must not be able to loosen it.
  if (path.includes('/agent-profiles') && !SAFE_METHODS.has(verb)) {
    return 'admin';
  }
  // An external MCP server is where the workspace's data may go and what an
  // agent may call there (issue #196, ADR-086). The service refuses every
  // token for these writes anyway; classing them as admin keeps a run's write
  // mode from ever being the thing that decides.
  if (path.includes('/mcp-servers') && !SAFE_METHODS.has(verb)) {
    return 'admin';
  }
  // A workflow is a standing instruction too (issue #160, ADR-075): once
  // enabled it starts agents by itself. Checking a graph is a POST only
  // because the graph travels in the body; it stores nothing, so it is a read
  // and a read-only client can still find out why a draft would not publish.
  // Writing a draft is an ordinary write (issue #165, ADR-080): a draft
  // starts nothing until a person publishes it and switches it on, so an
  // agent with a writing token may author one. Publishing, switching on,
  // deleting and starting or cancelling a run (issue #161) stay admin: a
  // run spends what the workflow's agents spend.
  if (
    (path.includes('/workflows') || path.startsWith('/api/workflow-runs/')) &&
    !SAFE_METHODS.has(verb)
  ) {
    if (/^\/api\/workflows\/[^/]+\/validate$/u.test(path)) return 'read';
    if (WORKFLOW_DRAFT_ROUTES.some(([method, pattern]) => method === verb && pattern.test(path))) {
      return 'write';
    }
    return 'admin';
  }
  if (SAFE_METHODS.has(verb)) return 'read';
  if (matches(REPORT_ROUTES, verb, path)) return 'report';
  if (matches(PROPOSE_ROUTES, verb, path)) return 'propose';
  return 'write';
}

/** Which scope a request needs: its class, with reporting counted as proposing. */
export function requiredScopeForRequest(method: string, path: string): ApiTokenScope {
  const requestClass = requestClassFor(method, path);
  return requestClass === 'report' ? 'propose' : requestClass;
}

/** Safe methods in the HTTP sense: they do not change server state. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Rank of each scope; a scope implies every scope below it. */
const SCOPE_RANK: Record<ApiTokenScope, number> = { read: 0, propose: 1, write: 2, admin: 3 };

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
  return Object.hasOwn(SCOPE_RANK, value);
}

/**
 * Whether the built-in AI in a restricted write mode may make this request
 * (issue #141). `read_only` may read and report on its work; `propose` may
 * also propose. `direct` is not restricted here.
 */
export function writeModeAllows(
  mode: 'read_only' | 'propose',
  requestClass: RequestClass,
): boolean {
  if (requestClass === 'read' || requestClass === 'report') return true;
  return mode === 'propose' && requestClass === 'propose';
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
