# Background jobs

BullMQ 6 on Redis. Expensive work never happens inside an API request handler.

## Queues

| Queue | Producer | Consumer | Status |
| ----- | -------- | -------- | ------ |
| `document-materialization` | collaboration server (debounced), API (import, snapshot restore) | `createMaterializeDocumentProcessor` | real |
| `search-indexing` | materialization, document mutations, outbox dispatch | `createIndexDocumentProcessor` | real |
| `ai` | `AiService.createRun`, `ConversationsService.postMessage` | `createAiRunProcessor` | real, mock provider |
| `maintenance` | repeatable schedulers | `createMaintenanceProcessor` | real (`dispatch-outbox`, `prune-snapshots`, `collect-orphaned-covers`), documented placeholder (`vacuum-search-index`) |
| `attachment-text` | attachment upload, `GET /api/attachments/:id/text` (on demand) | `createAttachmentTextProcessor` | real |

Queue names and payload schemas live in `packages/contracts/src/jobs.ts`, so
producers and consumers cannot drift apart.

`attachmentTextJobSchema`: `{ correlationId, attachmentId, workspaceId, reason }`
with `reason: 'upload' | 'requested' | 'retry'`. `createAttachmentTextProcessor`
(`apps/worker/src/processors/attachment-text.ts`, concurrency 1 — extraction
is an external call and must not crowd out materialization) treats a missing
or soft-deleted attachment, a non-PDF MIME type, an unconfigured extractor and
an oversized file (`ai.pdfMaxBytes`) as deterministic outcomes and sets
`textStatus` accordingly without retrying; anything else (a storage or
network error) is left to bubble so BullMQ applies the normal retry policy.

`AiRunJob` gained no new fields for the tool loop or conversations: it still
carries only `{ correlationId, runId, workspaceId, userId }`. The worker reads
everything else — the model, the conversation, its live message list — from
the `AiRun` and `AiConversation` rows themselves.

## Guarantees

* **Runtime-validated payloads.** `QueueRegistry.enqueue` parses with zod before
  writing to Redis; `createTypedWorker` parses again before running. A structurally
  invalid payload throws `UnrecoverableError`, so it is not retried but stays in the
  failed set for inspection.
* **Retries with explicit backoff.** `attempts: 5`, exponential from 1 s.
* **Idempotent handlers.**
  * materialization compares `materializedAt` with `yjsUpdatedAt` and skips when the
    derived data is already fresh
  * search indexing is a full upsert of the current state
  * AI runs only process a record in `PENDING` state
  * outbox dispatch sets `processedAt` and increments `attempts`
  * attachment text extraction returns immediately once `textStatus` is
    `READY`, so a retried job never re-extracts
* **Progress reporting.** `reportProgress(percent, germanLabel)` updates the BullMQ
  job and publishes a `job.progress` event, which the UI renders.
* **Correlation ids.** Every payload carries one; it flows from the HTTP request
  through the queue into the worker log lines.
* **Graceful shutdown.** `SIGTERM` closes all five workers (waiting for
  in-flight jobs), then the Redis connections, the event bus, the queues and
  Prisma.
* **No silently ignored failures.** Every handler either succeeds or throws;
  `worker.on('failed')` logs with the attempt count and publishes `job.failed`.
* **Failed-job inspection.** `removeOnFail: { age: 7 days, count: 5000 }` keeps
  failures. Inspect with `Queue.getFailed()` or any BullMQ dashboard against
  `REDIS_URL`.

## Retention

| Setting | Value |
| ------- | ----- |
| completed jobs | 1 hour / 1000 jobs |
| failed jobs | 7 days / 5000 jobs |
| snapshots per document | 20 (`prune-snapshots`, daily at 04:00) |
| replaced page covers | deleted 1 hour after they stop being a cover (`collect-orphaned-covers`, daily at 04:30) |
| outbox dispatch interval | 5 seconds, 100 rows per run |

## Adding a background job

1. **Define the payload** in `packages/contracts/src/jobs.ts`: add the queue name to
   `QUEUE_NAMES`, a zod schema, an entry in `JOB_SCHEMAS` and one in `JobPayloadMap`.
   Every payload needs `correlationId`.
2. **Write the processor** in `apps/worker/src/processors/<name>.ts` as a factory
   that takes its dependencies and returns
   `(context: JobContext<typeof QUEUE_NAMES.x>) => Promise<void>`. Make it
   idempotent and report progress.
3. **Register the worker** in `apps/worker/src/main.ts` with `createTypedWorker`,
   including `onProgress` / `onCompleted` / `onFailed` if the UI should see it.
4. **Enqueue** with `queues.enqueue(QUEUE_NAMES.x, payload)` or
   `queues.enqueueDebounced(...)` for edit-driven work. Job ids must not contain
   `:`.
5. **Test** it in `apps/worker/src/processors/processors.integration.test.ts`,
   including a "running it twice changes nothing" case.

## Tests

`apps/worker/src/processors/processors.integration.test.ts` runs the
processors against the real PostgreSQL and Redis:

* materialization derives JSON, plain text and Markdown
* "is idempotent: a repeated job does not change the derived data"
* re-materializes when the canonical state changed again
* skips a missing document instead of failing
* search indexing finds the text and does not duplicate the projection
* removes the projection of a deleted document
* excludes archived documents by default
* "dispatches outbox events exactly once"
* prunes snapshots down to the configured number
* AI runs: describes a document image and prepends it as context, leaves
  messages untouched without images, completes even when an attachment
  cannot be resolved
* a conversation-backed run executes a tool call through a stub `ToolRunner`
  and completes with the follow-up turn's text; `ai.maxToolIterations: 0`
  fails with `ai_tool_limit_exceeded`
* `compactIfNeeded` summarizes older messages and leaves the recent tail
  active; does nothing when already within budget
* attachment text extraction: `NOT_APPLICABLE` for a non-PDF, `FAILED` with a
  clear reason when no extractor is configured
