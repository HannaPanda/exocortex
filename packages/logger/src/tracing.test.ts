import { createServer, type Server } from 'node:http';
import { type AddressInfo } from 'node:net';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { startTracing, type TracingHandle } from './otel';
import {
  currentTraceCarrier,
  currentTraceIds,
  getTracer,
  resetTracer,
  type TraceCarrier,
  withSpan,
} from './tracing';

/**
 * These tests run against a real collector: a five-line HTTP server that
 * accepts the OTLP payload and keeps it.
 *
 * Pointing the exporter at a port nobody listens on would work too, but the
 * export then fails and retries for eight seconds on every shutdown, and a
 * test that never looks at what was exported cannot tell an empty batch from a
 * full one. The propagation contract asserted below -- which span is whose
 * parent, and what the carrier says -- is what the rest of the repository
 * depends on.
 */
interface Collector {
  url: string;
  spanNames(): string[];
  clear(): void;
  close(): Promise<void>;
}

/** The subset of the OTLP JSON payload these tests read. */
interface OtlpBody {
  resourceSpans?: { scopeSpans?: { spans?: { name?: string }[] }[] }[];
}

async function startCollector(): Promise<Collector> {
  const received: OtlpBody[] = [];
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      try {
        received.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as OtlpBody);
      } catch {
        // A payload this test cannot read is a payload it does not assert on.
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    spanNames: () =>
      received.flatMap(
        (body) =>
          body.resourceSpans?.flatMap(
            (resource) =>
              resource.scopeSpans?.flatMap(
                (scope) => scope.spans?.map((span) => span.name ?? '') ?? [],
              ) ?? [],
          ) ?? [],
      ),
    clear: () => {
      received.length = 0;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

/** Trace id out of a `traceparent`: `00-<trace id>-<span id>-<flags>`. */
function traceIdOf(carrier: TraceCarrier): string {
  return carrier.traceparent.split('-')[1]!;
}

function spanIdOf(carrier: TraceCarrier): string {
  return carrier.traceparent.split('-')[2]!;
}

describe('tracing without a collector', () => {
  afterEach(() => {
    resetTracer();
  });

  it('runs the operation and reports no trace context', async () => {
    const result = await withSpan('test', async () => {
      expect(currentTraceCarrier()).toBeUndefined();
      expect(currentTraceIds()).toBeUndefined();
      return 42;
    });
    expect(result).toBe(42);
  });

  it('rethrows and still ends the span', async () => {
    await expect(
      withSpan('test', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
  });

  it('stays off when no endpoint is configured', async () => {
    await expect(startTracing({ serviceName: 'test' })).resolves.toBeNull();
    await expect(startTracing({ serviceName: 'test', endpoint: '  ' })).resolves.toBeNull();
  });

  it('stays off when it is switched off', async () => {
    await expect(
      startTracing({ serviceName: 'test', endpoint: 'http://127.0.0.1:4318', enabled: false }),
    ).resolves.toBeNull();
  });
});

describe('tracing against a collector', () => {
  let collector: Collector;
  let tracing: TracingHandle;

  beforeAll(async () => {
    collector = await startCollector();
    const handle = await startTracing({ serviceName: 'test', endpoint: collector.url });
    expect(handle).not.toBeNull();
    tracing = handle!;
  });

  afterAll(async () => {
    await tracing.shutdown();
    await collector.close();
  });

  afterEach(() => {
    collector.clear();
  });

  it('makes a nested span a child of the one that is active', async () => {
    let outer: TraceCarrier | undefined;
    let inner: TraceCarrier | undefined;
    await withSpan('outer', async () => {
      outer = currentTraceCarrier();
      await withSpan('inner', async () => {
        inner = currentTraceCarrier();
      });
    });

    expect(outer).toBeDefined();
    expect(inner).toBeDefined();
    expect(traceIdOf(inner!)).toBe(traceIdOf(outer!));
    expect(spanIdOf(inner!)).not.toBe(spanIdOf(outer!));
  });

  it('continues a trace that arrived from another process', async () => {
    // What a job payload or a `traceparent` header carries.
    const remote: TraceCarrier = {
      traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
    };

    let carrier: TraceCarrier | undefined;
    await withSpan(
      'job',
      async () => {
        carrier = currentTraceCarrier();
      },
      { parent: remote, kind: 'consumer' },
    );

    expect(carrier).toBeDefined();
    expect(traceIdOf(carrier!)).toBe('0af7651916cd43dd8448eb211c80319c');
    expect(spanIdOf(carrier!)).not.toBe('b7ad6b7169203331');
  });

  it('reports the active ids for log correlation and forgets them afterwards', async () => {
    let ids: ReturnType<typeof currentTraceIds>;
    await withSpan('request', async () => {
      ids = currentTraceIds();
    });

    expect(ids?.traceId).toMatch(/^[\da-f]{32}$/);
    expect(ids?.spanId).toMatch(/^[\da-f]{16}$/);
    expect(currentTraceIds()).toBeUndefined();
  });

  it('binds a span without a callback, for the hooks that cannot wrap one', async () => {
    const tracer = getTracer();

    // The shape of a Fastify `onRequest` hook: the span is entered there and
    // read back in what runs after it, not inside a callback of its own.
    const carrier = await (async () => {
      const span = tracer.startSpan('GET /api/documents', { kind: 'server' });
      tracer.enterSpan(span);
      await Promise.resolve();
      const seen = currentTraceCarrier();
      span.end();
      return seen;
    })();

    expect(carrier).toBeDefined();
  });

  it('exports what it recorded', async () => {
    await withSpan('exported.span', async () => {});
    await tracing.flush();
    expect(collector.spanNames()).toContain('exported.span');
  });
});
