import { AsyncLocalStorage } from 'node:async_hooks';

import { createCorrelationId } from '@exocortex/logger';

export interface RequestContext {
  correlationId: string;
  userId?: string;
  /**
   * The agent connection this request belongs to, when it named one
   * (ADR-022). A correlation id covers exactly one request, which is what
   * makes it useless for the question people actually ask about an agent:
   * what did it touch all afternoon.
   */
  agentSession?: AgentSessionContext;
}

export interface AgentSessionContext {
  /** The session id as its client knows it. Trusted only within one account. */
  externalId: string;
  /** `clientInfo` from the handshake, verbatim and unverified. */
  clientLabel?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** Runs `operation` with a request context available to every nested call. */
export function runWithRequestContext<TResult>(
  context: RequestContext,
  operation: () => TResult,
): TResult {
  return storage.run(context, operation);
}

/**
 * Binds a context to the current async execution. Used from the Fastify
 * `onRequest` hook, which cannot wrap the downstream handler in a callback.
 */
export function enterRequestContext(context: RequestContext): void {
  storage.enterWith(context);
}

export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

/**
 * Correlation id of the current request, or a fresh one when called outside a
 * request (background jobs, bootstrap).
 */
export function currentCorrelationId(): string {
  return storage.getStore()?.correlationId ?? createCorrelationId();
}

export function setRequestUser(userId: string): void {
  const context = storage.getStore();
  if (context !== undefined) context.userId = userId;
}

/** The agent session of the current request, or `undefined` outside one. */
export function currentAgentSession(): AgentSessionContext | undefined {
  return storage.getStore()?.agentSession;
}

export const CORRELATION_HEADER = 'x-correlation-id';

/**
 * Provenance headers (ADR-022), mirrored from `@exocortex/mcp-tools`.
 *
 * Written out rather than imported: `apps/api` may not depend on the tool
 * catalogue -- the dependency runs the other way, since the catalogue reaches
 * the domain only through this API.
 */
export const AGENT_SESSION_HEADER = 'x-exocortex-agent-session';
export const AGENT_CLIENT_HEADER = 'x-exocortex-agent-client';

function headerValue(value: string | string[] | undefined): string | undefined {
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === 'string' && first.length > 0 ? first : undefined;
}

/**
 * Reads the provenance headers off a request.
 *
 * Both are attacker-controlled strings, so both are bounded here and neither
 * is ever used for a decision: the session id groups rows inside the caller's
 * own account, and the label is only ever shown to a person.
 */
export function readAgentSessionHeaders(
  headers: Record<string, string | string[] | undefined>,
): AgentSessionContext | undefined {
  const externalId = headerValue(headers[AGENT_SESSION_HEADER]);
  if (externalId === undefined || externalId.length > 100) return undefined;
  const clientLabel = headerValue(headers[AGENT_CLIENT_HEADER])?.slice(0, 200);
  return { externalId, clientLabel };
}
