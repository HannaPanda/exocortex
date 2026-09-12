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
  /**
   * The automation rule whose action is making this write, when one is
   * (issue #50, ADR-024). Unlike `agentSession` this *is* read for a decision:
   * it is what stops a rule from triggering itself for ever. So it is accepted
   * only from a service token -- `SessionGuard` clears it for every other
   * credential -- and a caller who forges it can at worst silence an automation
   * on a request they were making anyway.
   */
  automation?: AutomationOriginContext;
}

export interface AutomationOriginContext {
  ruleId: string;
  /** How many automations deep this write already is. */
  depth: number;
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

/** The automation whose action is writing, or `undefined` when none is. */
export function currentAutomation(): AutomationOriginContext | undefined {
  return storage.getStore()?.automation;
}

/**
 * Forgets the automation origin of the current request.
 *
 * Called by `SessionGuard` whenever the credential is not a service token. The
 * header is read before authentication runs -- that is where the request
 * context is built -- so the confirmation has to happen afterwards, and
 * forgetting is how it is confirmed.
 */
export function clearAutomationOrigin(): void {
  const context = storage.getStore();
  if (context !== undefined) context.automation = undefined;
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

/**
 * Automation origin (issue #50, ADR-024), written as `<ruleId>:<depth>`.
 *
 * Mirrored from `@exocortex/contracts` for the same reason as the two above:
 * the value travels as a header so no tool and no service has to know it
 * exists.
 */
export const AUTOMATION_ORIGIN_HEADER_NAME = 'x-exocortex-automation';

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

/**
 * Reads the automation origin header.
 *
 * Bounded and parsed strictly: a rule id that is not an id, or a depth that is
 * not a small number, is treated as no origin at all rather than as an origin
 * with surprising values. The decision this feeds -- whether a chain has gone
 * on long enough -- is one where "unparseable" and "zero" must not be the same
 * answer, so an unparseable depth means the header is ignored entirely and the
 * write counts as a fresh one.
 */
export function readAutomationOriginHeader(
  headers: Record<string, string | string[] | undefined>,
): AutomationOriginContext | undefined {
  const raw = headerValue(headers[AUTOMATION_ORIGIN_HEADER_NAME]);
  if (raw === undefined || raw.length > 120) return undefined;
  const separator = raw.lastIndexOf(':');
  if (separator <= 0) return undefined;
  const ruleId = raw.slice(0, separator);
  const depth = Number(raw.slice(separator + 1));
  if (!/^[A-Za-z0-9_-]{1,60}$/.test(ruleId)) return undefined;
  if (!Number.isInteger(depth) || depth < 0 || depth > 100) return undefined;
  return { ruleId, depth };
}
