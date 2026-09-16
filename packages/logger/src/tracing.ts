/**
 * The tracing contract, free of any SDK.
 *
 * Everything in this repository that opens a span talks to the interfaces
 * below, never to OpenTelemetry directly. Two reasons, and neither is
 * abstraction for its own sake:
 *
 *   1. The default is a no-op that allocates nothing. A deployment without a
 *      collector runs exactly as it did before tracing existed (issue #57),
 *      and the SDK is not even loaded -- `startTracing` imports it lazily.
 *   2. The instrumented code stays readable. `withSpan('ai.turn', …)` says what
 *      is being measured; a tracer, a context, a status code and a `finally`
 *      say how OpenTelemetry works.
 *
 * `packages/logger/src/otel.ts` is the one implementation, installed by
 * `startTracing()` during process bootstrap.
 */
export type SpanAttributeValue = string | number | boolean;
export type SpanAttributes = Record<string, SpanAttributeValue | undefined>;

export type SpanStatus = 'ok' | 'error';

/**
 * Where a span sits relative to the work it measures. The names are
 * OpenTelemetry's, because mapping them onto our own words would only make the
 * exported trace harder to read.
 */
export type SpanKind = 'internal' | 'server' | 'client' | 'producer' | 'consumer';

/**
 * A trace as it travels between processes: the W3C `traceparent` header value,
 * and the vendor state that rides along with it.
 *
 * This is the whole propagation surface. A job payload carries one of these
 * next to its correlation id, and that is how an AI run started by an HTTP
 * request ends up in the same trace as the request.
 */
export interface TraceCarrier {
  traceparent: string;
  tracestate?: string;
}

export interface Span {
  setAttribute(key: string, value: SpanAttributeValue): void;
  setAttributes(attributes: SpanAttributes): void;
  recordException(error: unknown): void;
  setStatus(status: SpanStatus, message?: string): void;
  end(): void;
}

export interface StartSpanOptions {
  attributes?: SpanAttributes;
  /** Correlation identifier propagated from the caller. */
  correlationId?: string;
  kind?: SpanKind;
  /** Parent from another process, as it arrived on a header or a job payload. */
  parent?: TraceCarrier;
}

export interface Tracer {
  startSpan(name: string, options?: StartSpanOptions): Span;
  /** Runs `operation` with `span` active, so spans started inside become its children. */
  withActiveSpan<TResult>(span: Span, operation: () => TResult): TResult;
  /**
   * Binds `span` to the current async execution without a callback, for the
   * callers that cannot wrap one: a Fastify `onRequest` hook hands control
   * back to the framework rather than invoking the rest of the request itself.
   */
  enterSpan(span: Span): void;
  /** The active span as a carrier, for work that leaves this process. */
  activeCarrier(): TraceCarrier | undefined;
  /** Ids of the active span, so a log line can be found from a trace and back. */
  activeIds(): TraceIds | undefined;
}

export interface TraceIds {
  traceId: string;
  spanId: string;
}

class NoopSpan implements Span {
  setAttribute(): void {}
  setAttributes(): void {}
  recordException(): void {}
  setStatus(): void {}
  end(): void {}
}

const noopSpan = new NoopSpan();

class NoopTracer implements Tracer {
  startSpan(): Span {
    return noopSpan;
  }
  withActiveSpan<TResult>(_span: Span, operation: () => TResult): TResult {
    return operation();
  }
  enterSpan(): void {}
  activeCarrier(): undefined {
    return undefined;
  }
  activeIds(): undefined {
    return undefined;
  }
}

let activeTracer: Tracer = new NoopTracer();

export function setTracer(tracer: Tracer): void {
  activeTracer = tracer;
}

/** Restores the no-op default. Used when tracing is shut down, and by tests. */
export function resetTracer(): void {
  activeTracer = new NoopTracer();
}

export function getTracer(): Tracer {
  return activeTracer;
}

/**
 * Runs `operation` inside a span, recording exceptions and always ending the
 * span. Errors are rethrown; they are never swallowed.
 *
 * The operation runs with the span active, so anything it starts -- a nested
 * span here, an enqueued job, a provider request -- becomes a child without
 * having to be handed the parent.
 */
export async function withSpan<TResult>(
  name: string,
  operation: (span: Span) => Promise<TResult>,
  options?: StartSpanOptions,
): Promise<TResult> {
  const tracer = activeTracer;
  const span = tracer.startSpan(name, options);
  return tracer.withActiveSpan(span, async () => {
    try {
      // Nothing is set on the way out. An operation that returned is not an
      // error, and an unset status says exactly that; stamping `ok` here would
      // overwrite the `error` an operation set for a failure it handled itself
      // -- which is most of what an AI run does.
      return await operation(span);
    } catch (error) {
      span.recordException(error);
      span.setStatus('error', error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      span.end();
    }
  });
}

/**
 * The carrier of the span that is active right now, or `undefined` when
 * nothing is being traced. Producers call this and put the result next to the
 * correlation id in whatever they are about to send.
 */
export function currentTraceCarrier(): TraceCarrier | undefined {
  return activeTracer.activeCarrier();
}

/** Trace and span id of the active span, for log correlation. */
export function currentTraceIds(): TraceIds | undefined {
  return activeTracer.activeIds();
}
