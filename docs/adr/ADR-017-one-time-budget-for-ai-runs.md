# ADR-017: A run's own budget is two derived clocks, not five independent ones

* Status: accepted
* Date: 2026-08-07

## Context

Issue #16 found that a long-running AI run had no way to end cleanly. Five
timing values already existed (`ai.timeoutMs`, the OpenRouter adapter's
`AI_DEFAULT_LIMITS`, BullMQ's `lockDuration`, nginx's `proxy_read_timeout`,
`TimeoutStopSec` in the systemd unit), and none of them did what its name
suggested:

* `ai.timeoutMs` was read as the budget for the whole run, including every
  tool round-trip (`ai.maxToolIterations`), because the `AbortController` was
  created once before the turn loop and only cleared in its `finally`. A run
  that called several tools could exceed it long before any single model
  answer was slow.
* When it fired, the resulting `AbortError` was caught by the same handler
  that catches a genuine provider outage and stored as `ai_provider_unavailable`
  / `FAILED`. `TIMED_OUT` (already a value of `AiRunStatus`) was never written
  by anything. This was a misclassification, not a missing code path.
* `POST /api/ai/runs/:runId/cancel` only ever touched the database row. The
  worker never read it again, so cancelling a run changed nothing about the
  process actually running it, and the run's final write still overwrote the
  row with `COMPLETED`.
* A job that BullMQ redelivered while its row was still `RUNNING` returned
  immediately (the idempotency guard treated "not PENDING" as "already
  answered"). That left the row `RUNNING` forever, and
  `ai_conversation_locked` (`conversations.service.ts`) then refused every
  further message in that conversation, permanently.

`AI_DEFAULT_LIMITS` turned out to be dead code: nothing but the mock provider
and one unused field of the OpenRouter adapter ever read it.

## Decision

**Two clocks, one settings-derived source, no others.**

* `ai.timeoutMs` becomes the limit for **one model answer** (one turn). This
  is a behaviour change for the same key: previously read, incorrectly, as the
  whole run's budget.
* A new setting, `ai.maxRunMs` (default 900 000 ms / 15 minutes), is the limit
  for the **whole run**, across every turn and tool round-trip.
* `deriveAiRunTimeouts` (`packages/contracts/src/ai-runtime.ts`) is the only
  place either value is turned into a clock. It also holds the invariant that
  a run's budget can never be shorter than a single turn's timeout — an admin
  setting `ai.maxRunMs` below `ai.timeoutMs` gets the turn timeout instead,
  because a run with tools enabled could otherwise never finish its first
  answer — and every other constant a run needs (heartbeat interval and
  staleness, the queue's lock duration, the tool-call ceiling, the reaper's
  grace period). Nothing downstream invents its own number.
* The worker (`apps/worker/src/processors/ai-run.ts`) now runs two
  `AbortController`s: one for the run, aborted by a `setTimeout` at
  `runBudgetMs` and by a failed heartbeat write (see below); one per turn,
  chained to the run's, aborted by its own `setTimeout` at `turnTimeoutMs`. An
  `abortReason` set at whichever `abort()` fired first turns the resulting
  `AbortError`, caught once at the bottom of the run, into the right error
  code: `ai_timeout` for either clock, `ai_cancelled` for the heartbeat case.
* The run writes a `heartbeatAt` timestamp (new nullable column on `AiRun`)
  every few seconds while `RUNNING`. The write is also the cancellation
  channel: it is a status-filtered `updateMany` on `status: 'RUNNING'`, and
  `count === 0` means the row left `RUNNING` from outside — cancelled through
  the API, or reaped by maintenance — so the run aborts itself without a
  second signalling path.
* A stale heartbeat is what lets the idempotency guard tell "another worker is
  still answering this" (skip) apart from "the previous worker died mid-run"
  (close the row out as `FAILED` / `ai_run_abandoned` and publish
  `ai.run.failed`, never resume it).
* A repeatable `reap-stale-ai-runs` maintenance job is the second-line rescue:
  it closes out a `RUNNING` run whose heartbeat or budget has expired even if
  its worker never got a chance to run the guard above (a hard process kill,
  a lost job), and a `PENDING` run old enough that it was evidently never
  picked up at all (`ai_run_lost`).
* `attempts: 1` for the `ai` queue (`QUEUE_JOB_OPTIONS`,
  `packages/queue/src/registry.ts`). `createAiRunProcessor` never throws on a
  provider or timeout failure — it always writes a terminal status itself —
  so a BullMQ retry would only ever fire for an infrastructure failure, and
  retrying an agentic run pays for the prompt again and can duplicate writes
  made through `exo_page_write`, which is not idempotent.
* `AI_DEFAULT_LIMITS`'s 60 s timeout field is removed as dead code along with
  this change; `docs/ai-architecture.md` says so instead of leaving it to be
  rediscovered.

## Consequences

* A run now ends in exactly one of `COMPLETED`, `FAILED`, `CANCELLED`,
  `TIMED_OUT`, or `FAILED` with `errorCode: 'ai_run_abandoned'`. "Stuck on
  RUNNING forever" is no longer reachable: every path that can leave `RUNNING`
  either writes a terminal status itself or is closed out by the reaper within
  a bounded time (`runBudgetMs + 30s`, or a heartbeat's staleness window).
* Cancelling a run now actually stops the worker, using the mechanism already
  proposed for issue #6 rather than a new one: `POST /cancel`'s existing
  database write is enough, because the heartbeat is what notices it.
* `ai.timeoutMs` changes meaning for existing deployments. `docs/admin.md` and
  the admin form's label and help text call this out at the setting itself
  rather than only here.
* Every terminal write in the worker moved from `update` to a status-filtered
  `updateMany`, so a race between the run's own completion and the reaper (or
  a cancellation) can no longer resurrect a row that already ended: the loser
  finds `count === 0` and discards its own result instead of overwriting.

## Rejected alternative

**Resume an abandoned run instead of ending it.** Rejected: resuming pays for
the prompt a second time, and — through the tool loop — can repeat a write
that already landed, since `exo_page_write` is not idempotent. Ending the run
visibly and asking the user to ask again is the version that cannot cost
double.
