/**
 * The OpenTelemetry implementation of the tracing contract (issue #57).
 *
 * `startTracing()` is the only entry point. It is a no-op without an OTLP
 * endpoint, and the SDK is imported lazily inside it, so a deployment that
 * configures no collector never loads a line of it: no exporter, no batch
 * processor, no context manager, and `getTracer()` keeps handing out the
 * no-op tracer from `tracing.ts`.
 *
 * Nothing else in the repository imports `@opentelemetry/*`. Instrumentation
 * calls `withSpan` and lets this file decide what that means.
 */
import {
  type Attributes,
  context,
  propagation,
  ROOT_CONTEXT,
  type Span as OtelSpan,
  SpanKind as OtelSpanKind,
  SpanStatusCode,
  trace,
  type Tracer as OtelApiTracer,
} from '@opentelemetry/api';
import type { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';

import { type Logger } from './logger';
import {
  resetTracer,
  setTracer,
  type Span,
  type SpanAttributes,
  type SpanKind,
  type SpanStatus,
  type StartSpanOptions,
  type TraceCarrier,
  type TraceIds,
  type Tracer,
} from './tracing';

const SPAN_KINDS: Record<SpanKind, OtelSpanKind> = {
  internal: OtelSpanKind.INTERNAL,
  server: OtelSpanKind.SERVER,
  client: OtelSpanKind.CLIENT,
  producer: OtelSpanKind.PRODUCER,
  consumer: OtelSpanKind.CONSUMER,
};

/** Drops the `undefined` values our attribute type allows and OpenTelemetry does not. */
function toOtelAttributes(attributes: SpanAttributes | undefined): Attributes {
  if (attributes === undefined) return {};
  const result: Attributes = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

class OtelSpanAdapter implements Span {
  constructor(readonly span: OtelSpan) {}

  setAttribute(key: string, value: string | number | boolean): void {
    this.span.setAttribute(key, value);
  }

  setAttributes(attributes: SpanAttributes): void {
    this.span.setAttributes(toOtelAttributes(attributes));
  }

  recordException(error: unknown): void {
    this.span.recordException(error instanceof Error ? error : { message: String(error) });
  }

  setStatus(status: SpanStatus, message?: string): void {
    this.span.setStatus({
      code: status === 'ok' ? SpanStatusCode.OK : SpanStatusCode.ERROR,
      ...(message === undefined ? {} : { message }),
    });
  }

  end(): void {
    this.span.end();
  }
}

class OtelTracerAdapter implements Tracer {
  constructor(
    private readonly tracer: OtelApiTracer,
    private readonly contextManager: AsyncLocalStorageContextManager,
  ) {}

  startSpan(name: string, options?: StartSpanOptions): Span {
    const parent =
      options?.parent === undefined
        ? context.active()
        : propagation.extract(ROOT_CONTEXT, {
            traceparent: options.parent.traceparent,
            ...(options.parent.tracestate === undefined
              ? {}
              : { tracestate: options.parent.tracestate }),
          });
    const attributes = toOtelAttributes(options?.attributes);
    if (options?.correlationId !== undefined) {
      attributes['exocortex.correlation_id'] = options.correlationId;
    }
    const span = this.tracer.startSpan(
      name,
      { kind: SPAN_KINDS[options?.kind ?? 'internal'], attributes },
      parent,
    );
    return new OtelSpanAdapter(span);
  }

  withActiveSpan<TResult>(span: Span, operation: () => TResult): TResult {
    if (!(span instanceof OtelSpanAdapter)) return operation();
    return context.with(trace.setSpan(context.active(), span.span), operation);
  }

  enterSpan(span: Span): void {
    if (!(span instanceof OtelSpanAdapter)) return;
    // `attach` is the imperative half of `with`: it binds the context to the
    // current async execution and hands back a token nobody here holds on to.
    // That is deliberate. The callers are request hooks whose chain ends with
    // the request, exactly like the correlation id that is entered beside it.
    this.contextManager.attach(trace.setSpan(context.active(), span.span));
  }

  activeCarrier(): TraceCarrier | undefined {
    const carrier: Record<string, string> = {};
    propagation.inject(context.active(), carrier);
    const traceparent = carrier['traceparent'];
    if (traceparent === undefined) return undefined;
    const tracestate = carrier['tracestate'];
    return tracestate === undefined ? { traceparent } : { traceparent, tracestate };
  }

  activeIds(): TraceIds | undefined {
    const spanContext = trace.getSpanContext(context.active());
    if (spanContext === undefined) return undefined;
    return { traceId: spanContext.traceId, spanId: spanContext.spanId };
  }
}

export interface StartTracingOptions {
  /** Shows up as `service.name`; one per process, e.g. `api` or `worker`. */
  serviceName: string;
  /**
   * OTLP/HTTP endpoint of the collector. Without it tracing stays off, which
   * is what makes a deployment with no collector behave exactly as before.
   */
  endpoint?: string;
  /** `key=value,key2=value2`, for a collector that wants an authorization header. */
  headers?: string;
  /** Fraction of traces to keep, 0 to 1. Children follow their parent's decision. */
  sampleRatio?: number;
  /** `false` switches tracing off even when an endpoint is configured. */
  enabled?: boolean;
  /** Recorded as `deployment.environment.name`. */
  environment?: string;
  /** Used for the one line that says tracing came up, and for exporter failures. */
  logger?: Logger;
}

export interface TracingHandle {
  /** Sends what is buffered without stopping the tracer. */
  flush(): Promise<void>;
  /** Flushes what is buffered and restores the no-op tracer. */
  shutdown(): Promise<void>;
}

/** `key=value,key2=value2` into a header object. Malformed pairs are skipped. */
function parseHeaders(headers: string | undefined): Record<string, string> {
  if (headers === undefined) return {};
  const result: Record<string, string> = {};
  for (const pair of headers.split(',')) {
    const separator = pair.indexOf('=');
    if (separator <= 0) continue;
    const key = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    if (key.length > 0 && value.length > 0) result[key] = value;
  }
  return result;
}

/**
 * The full URL spans are posted to.
 *
 * `OTEL_EXPORTER_OTLP_ENDPOINT` is by convention the collector's base URL
 * (`http://localhost:4318`), and the signal's path is appended to it. An
 * endpoint that already names the path is taken as given, so pointing at a
 * collector behind a rewrite stays possible.
 */
function tracesUrl(endpoint: string): string {
  const trimmed = endpoint.replace(/\/+$/, '');
  return trimmed.endsWith('/v1/traces') ? trimmed : `${trimmed}/v1/traces`;
}

/**
 * Installs the OpenTelemetry tracer, or returns `null` when tracing is off.
 *
 * Call it once, as early in `bootstrap()` as the environment is available:
 * every span started before this runs is a no-op span, which costs nothing but
 * also shows nothing.
 */
export async function startTracing(options: StartTracingOptions): Promise<TracingHandle | null> {
  const endpoint = options.endpoint?.trim();
  if (options.enabled === false || endpoint === undefined || endpoint.length === 0) return null;

  const [
    { BatchSpanProcessor, NodeTracerProvider, ParentBasedSampler, TraceIdRatioBasedSampler },
    { OTLPTraceExporter },
    { resourceFromAttributes },
    { W3CTraceContextPropagator },
    { AsyncLocalStorageContextManager },
  ] = await Promise.all([
    import('@opentelemetry/sdk-trace-node'),
    import('@opentelemetry/exporter-trace-otlp-http'),
    import('@opentelemetry/resources'),
    import('@opentelemetry/core'),
    import('@opentelemetry/context-async-hooks'),
  ]);

  const exporter = new OTLPTraceExporter({
    url: tracesUrl(endpoint),
    headers: parseHeaders(options.headers),
  });

  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({
      'service.name': `exocortex-${options.serviceName}`,
      'service.namespace': 'exocortex',
      ...(options.environment === undefined
        ? {}
        : { 'deployment.environment.name': options.environment }),
    }),
    // Parent-based: once a request is sampled every job, turn and tool call it
    // causes is sampled too, in every process. A ratio applied per span would
    // produce traces with holes in them, which is worse than no trace.
    sampler: new ParentBasedSampler({
      root: new TraceIdRatioBasedSampler(options.sampleRatio ?? 1),
    }),
    spanProcessors: [new BatchSpanProcessor(exporter)],
  });

  const contextManager = new AsyncLocalStorageContextManager();
  contextManager.enable();
  provider.register({ propagator: new W3CTraceContextPropagator(), contextManager });

  setTracer(new OtelTracerAdapter(provider.getTracer(options.serviceName), contextManager));
  options.logger?.info('Tracing enabled', {
    endpoint: tracesUrl(endpoint),
    sampleRatio: options.sampleRatio ?? 1,
  });

  return {
    async flush(): Promise<void> {
      await provider.forceFlush();
    },
    async shutdown(): Promise<void> {
      resetTracer();
      try {
        await provider.shutdown();
      } catch (error) {
        // A collector that is gone must never keep a service from stopping.
        options.logger?.warn('Tracing shutdown failed', {
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}
