# Observability

Three things answer "what happened": structured logs, the health endpoints, and
distributed tracing. This document is about the third, and about how the three
find each other.

The decision behind it is [ADR-031](adr/ADR-031-tracing-is-optional-and-in-band.md).

## What is on by default

Logs and health checks. Tracing is off until a collector is configured, and
"off" means the OpenTelemetry SDK is never loaded: `startTracing()` returns
before importing it, and every span in the code is a no-op object.

| Signal | Where                                                  | On by default |
| ------ | ------------------------------------------------------ | ------------- |
| Logs   | `packages/logger` (pino), journal of each systemd unit | yes           |
| Health | `GET /health/live`, `GET /health/ready`                | yes           |
| Traces | OTLP/HTTP to a collector you configure                 | no            |

## Switching tracing on

Four variables, in `.env`, read by `apps/api`, `apps/worker` and
`apps/collaboration`:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318   # empty means tracing is off
OTEL_EXPORTER_OTLP_HEADERS=                         # key=value,key2=value2
OTEL_TRACES_SAMPLER_RATIO=1                         # 0 to 1
OTEL_TRACES_ENABLED=true                            # false switches it off
```

The endpoint is the collector's OTLP/HTTP base URL; `/v1/traces` is appended
unless the URL already names it. Restart the units afterwards, then look for the
one line each process writes:

```
sudo journalctl -u exocortex-api -n 50 | grep 'Tracing enabled'
```

A collector to try it against, without installing anything permanently:

```bash
docker run --rm -p 16686:16686 -p 4318:4318 jaegertracing/all-in-one:latest
```

Jaeger's UI is then on `http://127.0.0.1:16686`; Tempo, Grafana Alloy and the
OpenTelemetry Collector speak the same protocol.

## What a trace contains

One trace covers a request and everything it causes, across processes.

| Span                     | Opened in                                     | Says                                           |
| ------------------------ | --------------------------------------------- | ---------------------------------------------- |
| `GET /api/documents/:id` | `apps/api/src/common/tracing.ts`              | route, status code, correlation id             |
| `queue.enqueue <queue>`  | `QueueRegistry.enqueue`                       | which queue, which job id                      |
| `job <queue>`            | `createTypedWorker`                           | attempt, **queue wait time**, job duration     |
| `outbox.dispatch <type>` | `apps/worker/.../maintenance-tasks/outbox.ts` | which event type the sweep spent its time on   |
| `ai.run`                 | `apps/worker/src/processors/ai-run.ts`        | model, tool iterations, tokens, cost           |
| `ai.turn`                | `.../ai-run/execution.ts`                     | turn index, finish reason, tokens of that turn |
| `ai.tool <name>`         | `apps/worker/src/tool-runner.ts`              | tool name, whether it failed or was refused    |
| `ai.provider.request`    | `packages/ai/src/openrouter-provider.ts`      | HTTP status, streaming or not, time to headers |

`messaging.bullmq.wait_time_ms` on the job span is what separates "the queue was
busy" from "the work was slow": it is the time between enqueue and pickup, while
the span's own duration is the work.

The job's own delay is subtracted from it, so a debounced save and a repeatable
maintenance run report the time they actually waited for a worker rather than
the interval they were scheduled at. Without that the p95 on an idle queue is
the debounce window, which looks alarming and means nothing.

An AI run reads end to end: the HTTP request that started it, the enqueue, the
job, the run, each turn, each tool call, and each provider request. The tool
calls go back into the API over loopback and continue the same trace, because
the client sends `traceparent` and the API accepts it as a parent.

## What is deliberately not traced

- **Health checks.** Probed every few seconds forever; tracing them would bury
  everything else.
- **The Yjs hot path** in `apps/collaboration`. A span per document update is a
  span per keystroke. What the collaboration server enqueues is traced from the
  enqueue onwards, which is where the interesting time is.
- **The outbox row's origin.** A dispatch span sits under the sweep, not under
  the request that wrote the row: the row carries no trace context. The two are
  still tied together by the correlation id (ADR-031).
- **Database and Redis calls.** No auto-instrumentation is installed. A slow
  query shows up as a slow span around it; adding a span per statement is a
  choice for the day one of them is actually the suspect.

## Never in a span

Identifiers, durations, counts, model names, tool names, statuses and error
classes. **Never** prompts, messages, tool results, page content, titles,
headers or credentials.

Traces leave the deployment for a collector with a different access model than
the application's, so the rule is stricter than for logs, where
`packages/logger/src/redaction.ts` catches the payload fields. There is no
redaction list for spans: the attributes are written at a handful of boundaries,
and each of those is a place where somebody is deciding what to record.

## Finding the log lines of a trace, and back

Every pino line written while a span is active carries `traceId` and `spanId`
(the `mixin` in `packages/logger/src/logger.ts`):

```bash
sudo journalctl -u exocortex-worker -o cat | grep '"traceId":"4bf92f3577b34da6a3ce929d0e0e4736"'
```

Without tracing configured the fields are simply absent, and the lines look
exactly as they did before.

## Adding a span

Use `withSpan` from `@exocortex/logger`. Never import `@opentelemetry/*`
anywhere but `packages/logger/src/otel.ts`.

```ts
import { withSpan } from '@exocortex/logger';

await withSpan(
  'render.pandoc',
  async (span) => {
    const result = await runContainer(input);
    span.setAttributes({ 'render.exit_code': result.exitCode });
    return result;
  },
  { correlationId, attributes: { 'render.template': templateId } },
);
```

Three rules:

1. The span covers a boundary, not a function. A crossing between processes, a
   paid call, a container, a queue. Everything else is noise a profiler answers
   better.
2. Attributes are ids, counts and outcomes. See above.
3. A failure the code handles itself rather than throwing has to set the status:
   `span.setStatus('error', code)`. `withSpan` marks a thrown error, and
   deliberately does not stamp `ok` over a status the operation set.

## Correlation ids, which are older and still there

A correlation id is one request, one socket session or one job, and it exists
whether or not tracing is on. It arrives as `x-correlation-id`, is entered into
`AsyncLocalStorage` before anything else runs, travels into job payloads, and is
on every log line and every API error response.

Tracing does not replace it. The correlation id is what a person pastes into a
search; the trace is what a timeline is built from. Where both exist, the span
carries the correlation id as `exocortex.correlation_id`.
