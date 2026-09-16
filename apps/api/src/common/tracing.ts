import { type FastifyInstance, type FastifyRequest } from 'fastify';

import { getTracer, type Span, type TraceCarrier } from '@exocortex/logger';

import { getRequestContext } from './correlation';

/**
 * The spans that answer "where did the request go" (issue #57).
 *
 * One span per HTTP request, opened before anything else runs and closed when
 * the reply is on the wire. Everything the request causes -- a job it
 * enqueues, an AI run that job starts, the tool calls that run makes -- hangs
 * underneath it, because the span is active for the whole handler and the
 * trace context travels on from there.
 *
 * Deliberately not an interceptor: Nest's interceptors do not see the requests
 * that never reach a controller (a 404, a rejected body, the Better Auth
 * handler, `/api/mcp`), and those are exactly the requests somebody is
 * debugging when they turn tracing on.
 */

/**
 * Health checks are not traced.
 *
 * systemd, nginx and the deploy script probe readiness every few seconds
 * forever. Tracing them buys nothing and would drown every real trace in a
 * collector's list.
 */
const UNTRACED_PREFIXES = ['/health'];

/** The open span of a request, so `onResponse` can finish what `onRequest` began. */
const spans = new WeakMap<FastifyRequest, Span>();

/**
 * The trace context on the request, when there is one.
 *
 * Only a syntactically valid `traceparent` is accepted. The header is
 * attacker-controlled like any other, and the cost of a malformed one is a
 * trace nobody can follow, so an unparseable value means "no parent" rather
 * than a broken one.
 */
function incomingParent(request: FastifyRequest): TraceCarrier | undefined {
  const raw = request.headers['traceparent'];
  const traceparent = Array.isArray(raw) ? raw[0] : raw;
  if (typeof traceparent !== 'string') return undefined;
  if (!/^[\da-f]{2}-[\da-f]{32}-[\da-f]{16}-[\da-f]{2}$/.test(traceparent)) return undefined;
  const rawState = request.headers['tracestate'];
  const tracestate = Array.isArray(rawState) ? rawState[0] : rawState;
  return typeof tracestate === 'string' && tracestate.length <= 512
    ? { traceparent, tracestate }
    : { traceparent };
}

/** Route pattern if the request matched one, the raw path otherwise. */
function routeName(request: FastifyRequest): string {
  const pattern = request.routeOptions.url;
  if (pattern !== undefined && pattern.length > 0) return pattern;
  const [path] = request.url.split('?');
  return path ?? request.url;
}

export function installHttpTracing(fastify: FastifyInstance): void {
  fastify.addHook('onRequest', (request, _reply, done) => {
    if (UNTRACED_PREFIXES.some((prefix) => request.url.startsWith(prefix))) {
      done();
      return;
    }
    const tracer = getTracer();
    const route = routeName(request);
    // A request that arrives with a trace context continues that trace instead
    // of starting a new one. Today that is the worker's tool loop calling back
    // into the API, which is the one hop that would otherwise split an AI run
    // into two unrelated traces.
    const parent = incomingParent(request);
    const span = tracer.startSpan(`${request.method} ${route}`, {
      kind: 'server',
      ...(parent === undefined ? {} : { parent }),
      // The hook registered before this one has already entered the request
      // context, so the id here is the one every log line of this request
      // carries -- not merely the one the caller may have sent.
      correlationId: getRequestContext()?.correlationId,
      attributes: {
        'http.request.method': request.method,
        'http.route': route,
        'url.path': request.url.split('?')[0],
        'server.address': request.hostname,
      },
    });
    spans.set(request, span);
    // The rest of the request is not a callback we could wrap, so the span is
    // bound to the async execution the same way the correlation id next to it
    // is. See `enterSpan`.
    tracer.enterSpan(span);
    done();
  });

  fastify.addHook('onError', (request, _reply, error, done) => {
    spans.get(request)?.recordException(error);
    done();
  });

  fastify.addHook('onResponse', (request, reply, done) => {
    const span = spans.get(request);
    if (span === undefined) {
      done();
      return;
    }
    spans.delete(request);
    span.setAttribute('http.response.status_code', reply.statusCode);
    // A 4xx is the caller's mistake, not a failed request: marking it as an
    // error would paint every unauthenticated poll red and hide the 500s.
    span.setStatus(reply.statusCode >= 500 ? 'error' : 'ok');
    span.end();
    done();
  });
}
