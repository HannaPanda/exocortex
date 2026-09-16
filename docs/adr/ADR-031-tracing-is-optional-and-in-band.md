# ADR-031: Tracing is optional, and the trace travels in band

- Status: accepted
- Date: 2026-09-16

## Context

A single click now crosses four processes. A question asked of the built-in AI
goes `browser → API → PostgreSQL/outbox → Redis/BullMQ → worker → model →
tool call → API → database → event bus → socket → browser`, and the editor's
path through `apps/collaboration` runs beside it.

The logs are structured and carry a correlation id, so the lines belonging to
one request can be found. What they cannot answer is where the time went: an AI
run that took eight seconds might have waited seven of them for a free worker,
spent six inside one tool call, or lost them in the provider's first byte. The
log lines are the same in all three cases (issue #57, named as a gap by #42).

Three things had to be decided rather than merely built.

## Decision

### The tracer is an interface of ours; OpenTelemetry is one implementation

`packages/logger/src/tracing.ts` defines `Span`, `Tracer`, `withSpan` and a
no-op default. `packages/logger/src/otel.ts` is the only file in the repository
that imports `@opentelemetry/*`, and `startTracing()` is the only way it is
installed.

The no-op is not a placeholder, it is the default state of the deployment. A
deployment without a collector runs exactly as it did before tracing existed:
`startTracing` returns `null` before loading anything, the SDK is never
imported (it is a dynamic import inside that function), and every `withSpan`
call is a function call and an object that does nothing.

Configuration for it is environment, not a setting in the database. ADR-013
makes the `setting` table the runtime authority, and this is the documented
exception rather than a violation of it: the tracer has to exist before the
first request is served, which is well before a setting can be read, and
switching an exporter on mid-process would leave every earlier span a no-op
with nothing to say so.

### The trace context travels in band, next to the correlation id

There is no header on a BullMQ job, so the W3C `traceparent` is a field on the
job payload (`jobBase` in `packages/contracts/src/jobs.ts`), stamped by
`QueueRegistry.enqueue` from whatever span is active and read back by
`createTypedWorker` as the parent of the job's span. Optional, because a job
enqueued while tracing is off has no parent to name.

Between worker and API the same context travels as the `traceparent` header the
standard already defines: `createFetchApiClient` asks for it per request, and
the API's `onRequest` hook accepts it as a parent when it parses. That single
hop is what keeps an AI run and the eighty tool calls underneath it in one
trace instead of two unrelated ones.

The outbox is the deliberate exception. An outbox row carries no trace context,
so a dispatch span belongs to the sweep that dispatched it rather than to the
request that wrote the row; the two are still tied together by the correlation
id. Adding a column for it is a schema change for a link nobody has asked for
yet, and the sweep runs every five seconds either way.

### Ids, durations and outcomes. Never content

A span attribute is an identifier, a duration, a count, a model name, a tool
name, a status or an error class. Never a prompt, a message, a tool result, a
page, a title, a header or a credential. This is not a convention to remember
per call site: the spans live at the boundaries (`withSpan` in the queue, the
tool runner, the provider adapter), and each of those has exactly one place
where attributes are set.

The cost of forgetting it would be a copy of the content outside the deployment
in a system with a different access model, which is the one property the
redaction list in `packages/logger/src/redaction.ts` exists to protect for logs.

### A sampled request stays sampled everywhere

The sampler is parent-based. Either a trace is kept with all of its jobs, turns
and tool calls, or none of it is: a per-span ratio produces traces with holes,
and a trace with holes is worse than no trace, because the gap looks like time
that was spent rather than a span that was dropped.

## Consequences

- With no collector configured: no dependency is loaded, no span is allocated,
  no behaviour changes. This is the state `exocortex.app` runs in today.
- With a collector: `service.name` is `exocortex-api`, `exocortex-worker` or
  `exocortex-collaboration`, and one trace spans them. Queue wait time and
  worker execution time are separate values
  (`messaging.bullmq.wait_time_ms` against the job span's own duration).
- Every pino line written while a span is active carries `traceId` and
  `spanId`, so a slow trace leads to its log lines and a suspicious log line
  leads back to its trace.
- Health checks are not traced. They are probed every few seconds forever, and
  tracing them would bury the requests somebody is actually looking for.
- The collaboration server's Yjs hot path has no spans of its own. It is the
  one path where a span per operation would be per keystroke; what it does
  enqueue is traced from the enqueue onwards.
- The exporter is OTLP/HTTP, so the backend is the deployment's choice
  (Jaeger, Tempo, Grafana Alloy, the OpenTelemetry Collector). None of them is
  named anywhere but in a URL.
