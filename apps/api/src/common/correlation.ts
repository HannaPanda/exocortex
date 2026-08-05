import { AsyncLocalStorage } from 'node:async_hooks';

import { createCorrelationId } from '@exocortex/logger';

export interface RequestContext {
  correlationId: string;
  userId?: string;
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

export const CORRELATION_HEADER = 'x-correlation-id';
