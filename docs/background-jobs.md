# Background jobs

BullMQ 6 on Redis. Expensive work never happens inside an API request handler.

## Queues

| Queue | Producer | Consumer | Status |
| ----- | -------- | -------- | ------ |
| `document-materialization` | collaboration server (debounced), API (import, snapshot restore) | `createMaterializeDocumentProcessor` | real |
| `search-indexing` | materialization, document mutations, outbox dispatch | `createIndexDocumentProcessor` | real |
| `ai` | `AiService.createRun`, `ConversationsService.postMessage` | `createAiRunProcessor` | real, mock provider |
| `maintenance` | repeatable schedulers, outbox dispatch | `createMaintenanceProcessor` | real (`dispatch-outbox`, `prune-snapshots`, `collect-orphaned-covers`, `reap-stale-ai-runs`, `resolve-document-links`, `backfill-document-links`), documented placeholder (`vacuum-search-index`) |
| `attachment-text` | attachment upload, `GET /api/attachments/:id/text` (on demand) | `createAttachmentTextProcessor` | real |
| `document-cover` | `POST /api/documents/:id/cover/generate` | `createDocumentCoverProcessor` | real |

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

`documentCoverJobSchema`: `{ correlationId, documentId, workspaceId, userId,
prompt }`. `createDocumentCoverProcessor`
(`apps/worker/src/processors/document-cover.ts`, concurrency 1 — an image model
is slow and rate limited, and a page has one cover) is the one processor that
writes through the REST API instead of Prisma: it mints a service token for
`userId` and posts the finished picture to `POST /api/documents/:id/cover`, so a
generated cover passes exactly the permission checks, the magic-byte check and
the downscaling an uploaded one does (ADR-014). It is also the one job enqueued
with `attempts: 1`, because every retry would be a second paid image; failures
are reported to the browser as `document.cover.generated` with a German reason
and the job then ends successfully.

`AiRunJob` gained no new fields for the tool loop or conversations: it still
carries only `{ correlationId, runId, workspaceId, userId }`. The worker reads
everything else — the model, the conversation, its live message list — from
the `AiRun` and `AiConversation` rows themselves.

The `ai` queue is the one queue that overrides the defaults above (ADR-017,
`QUEUE_JOB_OPTIONS` in `packages/queue/src/registry.ts`):

* **`attempts: 1`**, not the usual 5. `createAiRunProcessor` never throws on a
  provider or timeout failure — it always writes a terminal status
  (`FAILED`/`TIMED_OUT`/`CANCELLED`) itself — so a retry would only ever fire
  for an infrastructure error, and retrying an agentic run pays for the prompt
  a second time and can duplicate a write made through `exo_page_write`,
  which is not idempotent.
* **`lockDuration: 300_000` / `stalledInterval: 60_000`**
  (`AI_QUEUE_LOCK_DURATION_MS` / `AI_QUEUE_STALLED_INTERVAL_MS`,
  `packages/contracts/src/ai-runtime.ts`), well above the default 60 s: a run
  legitimately takes minutes, and both values only exist to catch a worker
  that is actually dead, not merely busy.

`resolve-document-links` and `backfill-document-links` keep the reference
index of issue #19 honest. The index itself is written by materialization,
which extracts every `[[Titel]]`, `@[[Titel]]` and page-link block from the
same ProseMirror JSON it derives Markdown and plain text from and replaces the
source page's rows wholesale (ADR-007, `apps/worker/src/processors/document-links.ts`).

* `resolve-document-links` carries a `documentId` and runs when a page appears,
  is renamed or changes workspace. A reference addresses a *title*, not an
  identity (issue #14), so the index would otherwise go stale from the target
  side without the source page ever changing. It is enqueued by the outbox
  dispatcher for `document.created`, `document.updated` and `document.moved`,
  and the API writes `document.updated` **only on an actual rename**, which is
  what keeps this from firing on every save. The work is one correlated
  `UPDATE` over the two or three title keys involved, so it stays an index
  range rather than a workspace-wide sweep.
* `backfill-document-links` (every 5 minutes, 50 content rows per run) pulls
  pages that existed before the index did. `DocumentContent.linksIndexedAt` is
  `null` for exactly those rows; once the sweep is done each run costs one
  indexed query and nothing else.

`reap-stale-ai-runs` (every 60 s) is the second-line rescue for a run whose
worker never got a chance to close it out itself — a hard process kill, a lost
job. It closes a `RUNNING` run whose heartbeat or total budget has expired
(`ai_run_abandoned` or `ai_timeout`) and a `PENDING` run old enough that it was
evidently never picked up (`ai_run_lost`, which is also what keeps
`ai_conversation_locked` from becoming permanent). See "Time budget of a run"
in `docs/ai-architecture.md` and ADR-017 for the full mechanism, including the
heartbeat the worker itself relies on to detect a cancellation.

## Guarantees

* **Runtime-validated payloads.** `QueueRegistry.enqueue` parses with zod before
  writing to Redis; `createTypedWorker` parses again before running. A structurally
  invalid payload throws `UnrecoverableError`, so it is not retried but stays in the
  failed set for inspection.
* **Retries with explicit backoff.** `attempts: 5`, exponential from 1 s —
  except the `ai` queue, which gets `attempts: 1` (see above).
* **Idempotent handlers.**
  * materialization compares `materializedAt` with `yjsUpdatedAt` and skips when the
    derived data is already fresh
  * search indexing is a full upsert of the current state
  * AI runs process a `PENDING` record, or a `RUNNING` one whose heartbeat has
    gone stale (closed as abandoned rather than resumed); a `RUNNING` record
    with a fresh heartbeat is left alone, and every other status is skipped
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
| stale AI run reap interval | 60 seconds, 100 runs per pass |
| reference backfill interval | 5 minutes, 50 documents per run |

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

### The queue prefix keeps a test run out of the deployment

Every queue lives under a Redis key prefix: `DEFAULT_QUEUE_PREFIX` (`bull`,
BullMQ's own default) for the deployment, and `testQueuePrefix('<suite>')` for a
test suite. Redis is shared with the running deployment on this machine, so a
queue *name* is not a boundary — whichever worker polls that name gets the job.
Before the prefixes existed, a test's enqueued job was executed by the live
`exocortex-worker` and then failed there (the run's user is deleted again in
`afterAll`, so its service token resolved to nobody), and the queue test's
`obliterate` erased the live materialization queue.

So: any test that builds a `QueueRegistry` passes its own prefix, and tears down
with `await queues.obliterateAll()` before `close()` — nothing consumes a test
namespace, so its jobs would otherwise stay in Redis for good. `obliterateAll`
refuses to run on any prefix that is not a test namespace, which is what keeps
that teardown from ever reaching the deployment's jobs.

A worker under a test prefix is safe to construct, which is how
`packages/queue/src/queue.integration.test.ts` covers `createTypedWorker`
end-to-end; a mismatch between producer and consumer prefix shows up there as a
handler that is never called.

### What the processor tests cover

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
* references: all three notations are extracted on materialization, a second
  materialization replaces them instead of adding to them, a reference to a
  page created later is resolved, a rename releases the old binding and hands
  it to a new namesake, the backfill picks up a content row the index never
  saw, and the outbox dispatcher turns `document.updated` into a resolution job
