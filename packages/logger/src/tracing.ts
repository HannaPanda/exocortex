/**
 * Minimal, OpenTelemetry-compatible tracing abstraction.
 *
 * The shape intentionally mirrors the parts of the OpenTelemetry `Tracer` API
 * that Exocortex uses, so a real SDK can be plugged in later by implementing
 * `Tracer` and calling `setTracer()` during process bootstrap. No tracing
 * backend is required to run the application.
 */
export type SpanAttributeValue = string | number | boolean;
export type SpanAttributes = Record<string, SpanAttributeValue | undefined>;

export type SpanStatus = 'ok' | 'error';

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
}

export interface Tracer {
  startSpan(name: string, options?: StartSpanOptions): Span;
}

class NoopSpan implements Span {
  setAttribute(): void {}
  setAttributes(): void {}
  recordException(): void {}
  setStatus(): void {}
  end(): void {}
}

class NoopTracer implements Tracer {
  startSpan(): Span {
    return new NoopSpan();
  }
}

let activeTracer: Tracer = new NoopTracer();

export function setTracer(tracer: Tracer): void {
  activeTracer = tracer;
}

export function getTracer(): Tracer {
  return activeTracer;
}

/**
 * Runs `operation` inside a span, recording exceptions and always ending the
 * span. Errors are rethrown; they are never swallowed.
 */
export async function withSpan<TResult>(
  name: string,
  operation: (span: Span) => Promise<TResult>,
  options?: StartSpanOptions,
): Promise<TResult> {
  const span = activeTracer.startSpan(name, options);
  try {
    const result = await operation(span);
    span.setStatus('ok');
    return result;
  } catch (error) {
    span.recordException(error);
    span.setStatus('error', error instanceof Error ? error.message : String(error));
    throw error;
  } finally {
    span.end();
  }
}
