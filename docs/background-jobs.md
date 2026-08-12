# Background jobs

BullMQ 6 on Redis. Expensive work never happens inside an API request handler.

## Queues

| Queue | Producer | Consumer | Status |
| ----- | -------- | -------- | ------ |
| `document-materialization` | collaboration server (debounced), API (import, snapshot restore) | `createMaterializeDocumentProcessor` | real |
| `search-indexing` | materialization, document mutations, outbox dispatch | `createIndexDocumentProcessor` | real |
| `ai` | `AiService.createRun`, `ConversationsService.postMessage` | `createAiRunProcessor` | real, mock provider |
| `maintenance` | repeatable schedulers, outbox dispatch | `createMaintenanceProcessor` | real (`dispatch-outbox`, `prune-snapshots`, `collect-orphaned-covers`, `reap-stale-ai-runs`, `resolve-document-links`, `backfill-document-links`, `snapshot-active-documents`), documented placeholder (`vacuum-search-index`) |
| `attachment-text` | attachment upload, `GET /api/attachments/:id/text` (on demand) | `createAttachmentTextProcessor` | real |
| `document-cover` | `POST /api/documents/:id/cover/generate` | `createDocumentCoverProcessor` | real |
| `memory-capture` | `POST /api/memory/capture` (Claude Code hook, Hermes, any client) | `createMemoryCaptureProcessor` | real |
| `calendar-sync` | repeatable schedulers (`calendar-pull` every 5 min, `calendar-remind` every minute, `calendar-discover` daily 05:15) | `createCalendarSyncProcessor` | real (mailbox.org CalDAV); writes outward only for a `PUSH`/`BOTH` link |

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
  is renamed or changes workspace. A reference resolves by identity first
  (`targetHintId`, issue #14) and by title second, and the title half would
  otherwise go stale from the target side without the source page ever
  changing. It is enqueued by the outbox dispatcher for `document.created`,
  `document.updated` and `document.moved`, and the API writes
  `document.updated` **only on an actual rename**, which is what keeps this
  from firing on every save. The work is one correlated `UPDATE` over the two
  or three title keys involved plus the rows naming this page by identity, so
  it stays an index range rather than a workspace-wide sweep.
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

### The Aktivität tab (issue #20): snapshots as history

`prune-snapshots` (daily at 04:00) used to keep a flat count per document; it
now thins with age instead, tuned from `activity.*` settings (ADR-013, table
in `docs/admin.md`) rather than a constructor option, so retention changes
without a redeploy. `pruneSnapshotIds` (`apps/worker/src/processors/maintenance.ts`,
pure and unit-tested on its own) buckets a document's non-`MANUAL` snapshots
into an epoch-day or epoch-week index — not real ISO calendar weeks, a
deterministic index is all thinning needs — and keeps the newest of each
bucket:

* younger than `activity.snapshotRetentionFullDays`: every snapshot survives.
* between that and `activity.snapshotRetentionDailyDays`: at most one per day.
* older than `activity.snapshotRetentionDailyDays`: at most one per week.
* `MANUAL` snapshots are exempt from all three tiers — a deliberately named
  version is not "the regular checkpoint" this retention is about.

A bucket with only one snapshot in it loses nothing, which is what keeps a
lightly edited document from being thinned at all — the edge case worth
testing explicitly, alongside "dry run changes nothing in the database".
`activity.snapshotRetentionDryRun` defaults **on**: it computes and logs what
would be deleted without deleting it, so the first run after this shipped
cannot silently remove snapshots that already existed on a live deployment.

`snapshot-active-documents` (every 5 min, a no-op unless
`activity.editSessionSnapshotsEnabled` is on) is what feeds a real session
*range* into the Aktivität tab rather than the single point
`Document.updatedAt` alone carries ("Bearbeitungen im Editor verdichten").
It takes a `SCHEDULED` `DocumentSnapshot` of a page whose `yjsUpdatedAt` moved
within `activity.editSessionSnapshotIntervalMinutes` and whose last snapshot
is both older than that content change and older than the interval itself —
two independent guards, so a page with no new content since its last
checkpoint is skipped even if the checkpoint is old, and a page mid-burst of
edits is not re-snapshotted on every five-minute sweep. `DocumentActivityService`
(`apps/api/src/documents/document-activity.service.ts`) later folds
consecutive same-actor `SCHEDULED` snapshots less than 30 minutes apart into
one `editingSession` entry; ordinary `MANUAL`/`API_WRITE`/`IMPORT`/`PRE_RESTORE`
snapshots stay out of that folding because they already appear as their own
precise, individually restorable entries, and burying a restore point inside
a vague session range would be a regression, not a condensation.

The Aktivität tab itself (`GET /api/documents/:documentId/activity`,
`exo_page_activity`) merges this with the audit log (`document.moved`,
`document.moved_workspace`, `document.archived`, `document.restored`,
`document.snapshot_restored`, plus the new `document.renamed` — a title has no
other history, so a rename needed its own audit entry) and the document row's
own `createdAt`/`createdById` — deliberately **not** what `AuditLog`'s own doc
comment scopes it to ("destructive and permission-relevant operations"): this
is the page's own history, not a compliance trail, and every entry it adds
carries structural metadata only (who, when, a title, a byte size), never
document content.

### `memory-capture`: one session becomes one note

`memoryCaptureJobSchema`: `{ correlationId, workspaceId, userId, project,
projectKey, client, sessionId, transcript, hint, startedAt }`. This is the one
job that carries bulk text, and that is the point: the API refuses to store a
raw conversation, so the transcript lives in the Redis payload for as long as
the job runs and nowhere else (issue #34, ADR-019).

`createMemoryCaptureProcessor` asks the model named by `memory.captureModelSlug`
(falling back to `ai.compactionModelSlug`, then `ai.defaultModelSlug`) for a
title line and a handful of German bullet points, then writes them through
`POST /api/memory/remember` with a service token minted for the capturing user
(ADR-014). Only the summary is written; nothing keeps the transcript.

Concurrency 1 and `attempts: 1`, for the same reason as `document-cover`: every
attempt is a paid model call, and the processor reports its own failures instead
of throwing, so a retry could only ever repeat an infrastructure problem and pay
twice. A failed capture is a memory that was not written, not an incident: the
hook that triggered it exited when the session did.

Two filters keep the memory from filling with noise, which is what makes recall
worse over time. `memory.captureMinChars` throws away the shortest sessions in
the API, before a model is ever paid; and the prompt allows the model to answer
`NICHTS`, in which case nothing is written at all.

### `calendar-sync`: mirroring a remote calendar

`calendarSyncJobSchema`: `{ correlationId, accountId, mode: 'discover' | 'pull',
full }`. There is no `userId`: a repeatable schedule has no user context, so it
sits on the `CalendarAccount` row, and every row the mirror writes goes through
the REST API with a service token minted for that person (ADR-014, ADR-016).
`createCalendarSyncProcessor` runs at concurrency 1 and isolates failures per
account and per link, because one calendar with a revoked password must not stop
the other two from staying current; the message lands in `lastError` on the row
that caused it.

`discover` lists the collections and provisions one COLLECTION document per
calendar (ADR-011) with the columns the sync writes. The `CalendarLink` row is
written **before** the columns, with an empty property map: a run that created the
document and then failed on a column used to leave an orphan database behind, and
the next run, finding no link, created a second one next to it.

`pull` reads changed objects. It costs one REPORT per calendar when nothing
happened, which is what makes a five-minute cadence affordable: a `sync-token`
(RFC 6578) reports only what moved, and an unchanged `getetag` means the body is
never fetched. A rejected token is data, not an error, and forces a full re-read
rather than being mistaken for "nothing changed".

Recurring appointments are the one thing that goes stale without anything
changing remotely. A series is mirrored at the occurrence that is **current or
next** (`resolveOccurrence` in `packages/calendar/src/recurrence.ts`), never at
its DTSTART, which for a yearly appointment is the one date it will not happen
again. Because that occurrence moves with the clock and not with the object,
`CalendarObjectState.recurrenceIcs` caches the raw body of recurring objects
only, and every pass re-expands the rule locally and moves the row forward
(`refreshed` in the log line). No network is involved. RECURRENCE-ID overrides are
applied to the occurrence they belong to instead of becoming rows of their own,
so a moved instance shows its new time and a series stays one appointment. The
`Wiederholung` column holds a German phrase (`describeRecurrence`), not the raw
RRULE, which is still in the cached body when a write-back needs it.

`push` writes local changes back, and only for a link whose `direction` is `PUSH`
or `BOTH`. A link is `PULL` until somebody says otherwise, so an untouched
deployment makes no request here at all. The order inside a pass is fixed: read
first, then write. The pull settles what the remote side currently says and
records it on every state, so the push has only genuinely local changes left to
send; the other order would decide what changed locally against a picture of the
remote side that is one pass old.

Loop prevention is a hash, not a timestamp. `CalendarObjectState.lastPushedHash`
holds a fingerprint of the fields eXocortex owns (title, span, location,
description; `hashCalendarEventPayload`), and **both** directions write it: a pull
records what it put into the row, a push records what it sent outward. A row whose
fingerprint still matches is silent. With a modification time instead, our own push
would change the remote object, the next pull would rewrite the row, and that echo
would look like a fresh local edit: one write per pass, forever.

Four things the push will never do, and each of them is load-bearing:

* **Touch an object with an ORGANIZER.** It arrived as an invitation, the
  organizer owns the appointment, and rewriting the time would put an ITIP
  counter-proposal on the wire that nobody asked for.
* **Touch a recurring object.** The row holds *one occurrence* of the series (see
  above), so writing the row back would flatten the whole rule onto that date.
* **Write unconditionally.** A create sends `If-None-Match: *`, a replace and a
  delete send `If-Match` with the etag just read. A refused precondition (412) is
  counted as a conflict and left to the next pull, never retried with the same
  stale body: the calendar is open in a phone and in a mail client too.
* **Delete an object it did not create.** Only `origin: LOCAL` is removed, and only
  after the row was confirmed archived or gone by a direct lookup rather than
  inferred from its absence in a listing. Archiving a mirrored row is tidying a
  table; cancelling somebody's appointment because of it is not what they asked
  for.

An existing object is **patched**, never rebuilt: its body is parsed, the owned
fields are replaced and everything else is written back untouched
(`patchEventIcs`). Rebuilding it from the mirrored columns would delete its
VALARM, which is to say the reminder someone's phone depends on. The times are
removed and re-added rather than updated in place, because ical.js keeps a
property's existing parameters and an event authored in a zone came out as
`DTSTART;TZID=Europe/Berlin:…Z`: a zone and a UTC marker on one value.

`remind` touches no calendar server at all and runs **every minute**, which is the
point: a reminder is a promise about a time, and one that arrives four minutes late
has broken it. It costs one indexed query per tick while nothing is due.

It is a sweep, not a delayed job per appointment, and that is a decision rather
than a shortcut. A delayed job has to be found and cancelled whenever an
appointment moves, and a mirrored series moves *by itself* as the clock passes each
occurrence, so the queue would fill with jobs for times that no longer exist while
the one job that mattered got lost in a restart. A sweep holds no state that can
rot: it asks what is due and derives the answer from the mirror every time.

Idempotence is `remindedFor` compared against `occurrenceStart`, not a flag. Equal
means announced; an appointment that moved gets a fresh reminder because its start
no longer matches, which is right — a new time is news. A delivery that fails is
left unmarked and logged, so the next minute retries it while the appointment is
still ahead.

The due moment comes from the span, in the configured zone
(`calendar.timeZone`). A timed appointment is announced
`calendar.reminderLeadMinutes` before it starts and stays worth sending for 15
minutes after ("you are late"), never an hour. An all-day appointment has no start
time to count back from, so it is announced at `calendar.reminderAllDayHour` local
time on its own date and stays valid until that local day is over: a birthday
announced at 23:00 is late, announced the next morning it is wrong.
`reminder-time.ts` resolves the local hour through `Intl` with a two-pass offset
correction, because on the day the clocks change a single pass can land on the
wrong side of the transition.

Delivery goes through `CALENDAR_REMINDER_COMMAND` and
`CALENDAR_REMINDER_TARGET`: an executable that takes the message on stdin
(`<command> send --to <target> --quiet --file -`). On this host that is Hermes'
one-shot sender, which reaches Telegram with the gateway's own credentials and
without starting an LLM. In the environment rather than in the `setting` table
because it is an absolute path on one machine; unset leaves reminders off however
`calendar.remindersEnabled` is switched, the same seam as a missing
`SERVICE_TOKEN_SECRET`. The body travels on stdin, never as an argument: an
argument list has a length limit and a message beginning with a dash would be read
as an option. Spawned without a shell (CLAUDE.md rule 6 is why this lives in the
worker and nowhere else).

Deliberate gaps: VTODO is never written outward (its own shape, with STATUS and
PERCENT-COMPLETE, is a separate step) and never announced (a deadline is not an
appointment), a repeating VTODO keeps its plain DUE date, a written event is stored
in UTC rather than in its authored zone, reminders are all-or-nothing rather than
per calendar, and there are still no REST endpoints or MCP tools for calendar
accounts and links, so an account row is created by hand and `direction` is flipped
by hand.

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
| snapshots per document | tiered by age, not a flat count: full for `activity.snapshotRetentionFullDays` (default 7d), then one/day until `activity.snapshotRetentionDailyDays` (default 30d), then one/week; `MANUAL` exempt (`prune-snapshots`, daily at 04:00, dry-run by default) |
| active-document snapshot interval | `activity.editSessionSnapshotIntervalMinutes` (default 15 min), off by default (`activity.editSessionSnapshotsEnabled`) |
| replaced page covers | deleted 1 hour after they stop being a cover (`collect-orphaned-covers`, daily at 04:30) |
| outbox dispatch interval | 5 seconds, 100 rows per run |
| stale AI run reap interval | 60 seconds, 100 runs per pass |
| reference backfill interval | 5 minutes, 50 documents per run |
| snapshot-active-documents interval | 5 minutes (scheduler cadence; see `activity.editSessionSnapshotIntervalMinutes` for the per-document minimum) |

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
* tiered snapshot pruning: keeps everything inside the full-retention window,
  thins to one/day then one/week outside it, never touches `MANUAL` snapshots,
  and — the edge case that matters most — deletes nothing from a bucket that
  only has one snapshot in it; `activity.snapshotRetentionDryRun` computes the
  same deletions but leaves every row in place
* `snapshot-active-documents` is a no-op with the setting off, takes exactly
  one `SCHEDULED` snapshot for a page that changed since its last checkpoint,
  and skips a page whose last checkpoint is still inside the configured
  interval even though its content changed again since
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
