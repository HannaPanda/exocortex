import { type Job, type JobsOptions, Queue, QueueEvents } from 'bullmq';

import {
  JOB_SCHEMAS,
  type JobPayloadMap,
  type MaintenanceJob,
  QUEUE_NAMES,
  type QueueName,
} from '@exocortex/contracts';
import { currentTraceCarrier, type Logger, withSpan } from '@exocortex/logger';

import { createRedisConnection, type Redis } from './connection';

/** The housekeeping jobs, by name; see `scheduleMaintenance`. */
type MaintenanceTaskName = MaintenanceJob['task'];

/** A cadence in milliseconds, for the sweeps that run far more often than daily. */
interface RepeatEvery {
  every: number;
}

/** A cron expression, for the ones that belong at a time of day. */
interface RepeatPattern {
  pattern: string;
}

/** Default retry policy. Every queue retries with exponential backoff. */
export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 1_000 },
  removeOnComplete: { age: 3_600, count: 1_000 },
  // Failed jobs are kept so they can be inspected; see docs/background-jobs.md.
  removeOnFail: { age: 7 * 24 * 3_600, count: 5_000 },
};

/**
 * Per-queue overrides layered on top of `DEFAULT_JOB_OPTIONS`.
 *
 * The `ai` queue gets its own retry policy: `createAiRunProcessor`
 * (`apps/worker/src/processors/ai-run.ts`) never throws on a provider or
 * timeout failure, it writes `FAILED`/`TIMED_OUT` itself, so BullMQ's retries
 * would only ever fire for an infrastructure error -- and a blind second
 * attempt there would pay for the prompt twice and can duplicate writes made
 * through `exo_page_write`, which is not idempotent (ADR-017).
 */
export const QUEUE_JOB_OPTIONS: Partial<Record<QueueName, JobsOptions>> = {
  [QUEUE_NAMES.ai]: {
    attempts: 1,
  },
  // A build is deterministic: a template that does not compile does not
  // compile the second time either, and the processor writes a terminal status
  // with the log itself rather than throwing (issue #44, ADR-026). A retry
  // would only start a second container for a PDF nobody is waiting for any
  // more -- asking again is the human's decision, and there is a button for it.
  [QUEUE_NAMES.render]: {
    attempts: 1,
  },
  // A project build, for exactly the same reason (issue #43, ADR-027): LaTeX
  // that does not compile does not compile the second time either.
  [QUEUE_NAMES.projectBuild]: {
    attempts: 1,
  },
  // A composition is a paid call whose failures the processor records itself
  // (issue #53, ADR-028), and whose input is unchanged on a retry: the second
  // attempt would buy the same paragraph twice. The next change to the page
  // enqueues another run anyway, and the hourly sweep is underneath that.
  [QUEUE_NAMES.documentOverview]: {
    attempts: 1,
  },
  // A notification ages out of usefulness faster than anything else in this
  // list (issue #30, ADR-048): three quick attempts are worth it because a
  // push service does have bad minutes, but the fourth would arrive long
  // after the appointment it was about. The processor deletes a subscription
  // the service says is gone, so a retry never reaches a dead device.
  [QUEUE_NAMES.push]: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5_000 },
  },
};

/** Debounce window for document materialization. */
export const MATERIALIZATION_DEBOUNCE_MS = 2_000;
/** Upper bound so a continuously edited document is still materialized. */
export const MATERIALIZATION_MAX_DELAY_MS = 15_000;

/**
 * Redis key namespace for every queue. BullMQ's own default, kept as the
 * deployment's value so an upgrade never orphans the jobs already in Redis.
 */
export const DEFAULT_QUEUE_PREFIX = 'bull';

/**
 * Namespace for a test suite's queues.
 *
 * Redis is shared with the running deployment on this machine, and a queue name
 * alone is not a boundary: an enqueued job is picked up by whichever worker
 * polls that name, so a test's job went to the live `exocortex-worker` and a
 * test's `obliterate` erased the live queue. The prefix is that boundary. Give
 * each suite its own `label` so two suites running in parallel cannot consume
 * each other's jobs either.
 */
export function testQueuePrefix(label: string): string {
  return `${TEST_QUEUE_PREFIX_MARKER}${label}`;
}

/** Marks a prefix as belonging to a test suite; see `obliterateAll`. */
export const TEST_QUEUE_PREFIX_MARKER = 'exocortex-test-';

export interface QueueRegistryOptions {
  redisUrl: string;
  logger: Logger;
  /** Redis key namespace. Defaults to `DEFAULT_QUEUE_PREFIX`. */
  prefix?: string;
}

export interface EnqueueOptions extends JobsOptions {
  /**
   * Stable job id. Adding a job with an existing id is ignored by BullMQ, which
   * is what makes the producers idempotent.
   */
  jobId?: string;
}

/**
 * Typed access to all Exocortex queues.
 *
 * Payloads are validated with the shared zod schemas before they are written to
 * Redis, so a malformed job can never reach a worker.
 */
export class QueueRegistry {
  private readonly connection: Redis;
  private readonly queues = new Map<QueueName, Queue>();
  private readonly events = new Map<QueueName, QueueEvents>();
  private readonly logger: Logger;
  private readonly prefix: string;

  constructor(options: QueueRegistryOptions) {
    this.connection = createRedisConnection(options.redisUrl);
    this.prefix = options.prefix ?? DEFAULT_QUEUE_PREFIX;
    this.logger = options.logger.child({ component: 'queue-registry' });
  }

  /**
   * Untyped queue handle. BullMQ's own generics do not survive a mapped payload
   * type, so the type safety is provided by the zod validation in `enqueue`
   * instead of by the queue instance.
   */
  private rawQueue(name: QueueName): Queue {
    const existing = this.queues.get(name);
    if (existing !== undefined) return existing;
    const queue = new Queue(name, {
      connection: this.connection,
      prefix: this.prefix,
      defaultJobOptions: { ...DEFAULT_JOB_OPTIONS, ...QUEUE_JOB_OPTIONS[name] },
    });
    this.queues.set(name, queue);
    return queue;
  }

  getQueue<TName extends QueueName>(name: TName): Queue<JobPayloadMap[TName]> {
    return this.rawQueue(name) as unknown as Queue<JobPayloadMap[TName]>;
  }

  /** Queue event stream, used by the API to forward job progress to clients. */
  getQueueEvents(name: QueueName): QueueEvents {
    const existing = this.events.get(name);
    if (existing !== undefined) return existing;
    const queueEvents = new QueueEvents(name, {
      connection: this.connection.duplicate(),
      prefix: this.prefix,
    });
    this.events.set(name, queueEvents);
    return queueEvents;
  }

  /**
   * Stamps the caller's trace context onto a payload that does not name one.
   *
   * This is what keeps a trace going across the queue (issue #57): the worker
   * reads `traceparent` back out and starts the job's span underneath the span
   * that enqueued it. A payload that already carries one is left alone, so a
   * job re-enqueued on behalf of an earlier one keeps pointing at its origin.
   */
  private withTraceContext<TName extends QueueName>(
    payload: JobPayloadMap[TName],
  ): JobPayloadMap[TName] {
    if (payload.traceparent !== undefined) return payload;
    const carrier = currentTraceCarrier();
    if (carrier === undefined) return payload;
    return { ...payload, traceparent: carrier.traceparent };
  }

  /** Validates and enqueues a job. */
  async enqueue<TName extends QueueName>(
    name: TName,
    payload: JobPayloadMap[TName],
    options: EnqueueOptions = {},
  ): Promise<string> {
    return withSpan(
      `queue.enqueue ${name}`,
      async (span) => {
        const parsed = JOB_SCHEMAS[name].parse(
          this.withTraceContext(payload),
        ) as JobPayloadMap[TName];
        const job = await this.rawQueue(name).add(name, parsed, options);
        span.setAttributes({ 'messaging.message.id': job.id });
        this.logger.debug('Job enqueued', {
          queue: name,
          jobId: job.id,
          correlationId: parsed.correlationId,
        });
        return job.id ?? '';
      },
      {
        kind: 'producer',
        correlationId: payload.correlationId,
        attributes: {
          'messaging.system': 'bullmq',
          'messaging.destination.name': name,
          'messaging.operation.name': 'send',
        },
      },
    );
  }

  /**
   * Enqueues a job with a debounce window.
   *
   * If a delayed job with the same id already exists its delay is extended, up
   * to `maxDelayMs` after the first enqueue. This turns a stream of keystroke
   * driven events into at most one job per window (see ADR-005).
   */
  async enqueueDebounced<TName extends QueueName>(
    name: TName,
    payload: JobPayloadMap[TName],
    options: { jobId: string; delayMs?: number; maxDelayMs?: number } & JobsOptions,
  ): Promise<string> {
    const { jobId, delayMs = MATERIALIZATION_DEBOUNCE_MS, maxDelayMs, ...rest } = options;
    // BullMQ forbids ":" in custom job ids; failing here is far easier to
    // diagnose than a rejected `queue.add` deep inside a persistence hook.
    if (jobId.includes(':')) {
      throw new Error(`Invalid job id "${jobId}": custom job ids must not contain ":"`);
    }
    const parsed = JOB_SCHEMAS[name].parse(this.withTraceContext(payload)) as JobPayloadMap[TName];
    const queue = this.rawQueue(name);

    const existing = await queue.getJob(jobId);
    const kept =
      existing === undefined
        ? null
        : await this.keepPendingJob(existing, {
            queue: name,
            jobId,
            data: parsed,
            delayMs,
            cap: maxDelayMs ?? MATERIALIZATION_MAX_DELAY_MS,
          });
    if (kept !== null) return kept;

    // A finished job still holding this id has to go before a new one can take
    // it. `Queue.add` with an id that already exists returns the existing job
    // and adds nothing -- silently, with no error and no second run -- so
    // without this the *first* save of a document materializes and every
    // further save inside `removeOnComplete.age` does not. See the note on
    // `releaseFinishedJob`.
    if (existing !== undefined) await this.releaseFinishedJob(existing, name, jobId);

    const job = await queue.add(name, parsed, { ...rest, jobId, delay: delayMs });
    return job.id ?? jobId;
  }

  /**
   * Reuses a job that is already queued under the same id.
   *
   * Returns its id when the pending job stands in for the new one -- either
   * because its delay was extended, or because `cap` was reached and it must be
   * allowed to run. Returns `null` when the caller has to enqueue a new job.
   *
   * Split out of `enqueueDebounced` so neither half has to carry the other's
   * nesting: the decision here is four independent conditions, not a ladder.
   */
  private async keepPendingJob(
    existing: Job,
    options: { queue: QueueName; jobId: string; data: unknown; delayMs: number; cap: number },
  ): Promise<string | null> {
    const state = await existing.getState();
    if (state !== 'delayed' && state !== 'waiting') return null;

    // Cap reached: let the pending job run and do not postpone it further.
    const elapsed = Date.now() - existing.timestamp;
    if (elapsed + options.delayMs > options.cap) return existing.id ?? options.jobId;

    try {
      await existing.updateData(options.data);
      if (state === 'delayed') await existing.changeDelay(options.delayMs);
      return existing.id ?? options.jobId;
    } catch (error) {
      // The job may have started between the state check and the update.
      this.logger.debug('Debounced job could not be postponed, adding a new one', {
        queue: options.queue,
        jobId: options.jobId,
        reason: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Frees a debounce id whose job has already run.
   *
   * BullMQ keeps a completed job under its custom id until `removeOnComplete`
   * ages it out, and an `add` under an id that is still taken is a no-op that
   * reports success: it hands back the finished job, with its old data and its
   * `completed` state, and nothing runs. For a fixed id like
   * `materialize-<documentId>` that means exactly one materialization per
   * document per retention window -- the first one -- while every caller sees a
   * job id come back and assumes the work is queued.
   *
   * Removing it is safe in both directions. A job that another process removed
   * first throws, and that throw means the id is free, which is what we wanted;
   * a job that has meanwhile been re-added as pending is not in a finished
   * state and is left alone by the guard above.
   */
  private async releaseFinishedJob(job: Job, queue: QueueName, jobId: string): Promise<void> {
    try {
      await job.remove();
    } catch (error) {
      this.logger.debug('Finished debounced job was already gone', {
        queue,
        jobId,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Registers the recurring maintenance jobs. Idempotent.
   *
   * Every one of them has the same shape -- the scheduler is named after the
   * task it runs, and a scheduled sweep is never scoped to one workspace or one
   * page -- so `schedule` below carries that shape and this stays a list of
   * cadences and the reasons for them.
   */
  async scheduleMaintenance(correlationId: string): Promise<void> {
    const queue = this.rawQueue(QUEUE_NAMES.maintenance);
    const schedule = (task: MaintenanceTaskName, repeat: RepeatEvery | RepeatPattern) =>
      queue.upsertJobScheduler(task, repeat, {
        name: QUEUE_NAMES.maintenance,
        data: { correlationId, task, workspaceId: null, documentId: null },
      });

    await schedule('dispatch-outbox', { every: 5_000 });
    await schedule('prune-snapshots', { pattern: '0 4 * * *' });
    await schedule('collect-orphaned-covers', { pattern: '30 4 * * *' });
    // Every minute: the second-line defence for a run whose worker died
    // without a chance to close it out itself (issue #16). See
    // `apps/worker/src/processors/maintenance.ts`.
    await schedule('reap-stale-ai-runs', { every: 60_000 });
    // Once a day, after the snapshot prune: the net underneath the
    // event-driven reference resolution, for rows whose target page appeared
    // in the same import that wrote them and which no later event revisits.
    // A no-op once every reference that can resolve has.
    await schedule('repair-document-links', { pattern: '15 4 * * *' });
    // Every five minutes, a small batch: this is what pulls pages that existed
    // before the reference index into it (issue #19), slowly enough that a
    // running deployment does not notice. Once every content row is marked it
    // costs one indexed query per run and nothing else.
    await schedule('backfill-document-links', { every: 300_000 });
    // Every five minutes, same cadence as the link backfill: the processor
    // itself is a no-op unless `activity.editSessionSnapshotsEnabled` is on,
    // and even then only takes a snapshot for a page whose content is both
    // new since its last checkpoint and due for the next one
    // (`activity.editSessionSnapshotIntervalMinutes`, minimum 5) -- the
    // scheduler's own cadence only has to be at least that fine (issue #20).
    await schedule('snapshot-active-documents', { every: 300_000 });
    // Every two minutes, a small batch. A no-op while semantic search is off,
    // and the only thing that ever fills the vector index for pages that
    // existed before it was switched on (issue #34, AP4). Faster than the link
    // backfill because a deployment that just enabled the feature is waiting
    // for it, and each batch is bounded by a paid call it pays for once.
    await schedule('backfill-embeddings', { every: 120_000 });
    // Every ten minutes, a batch of up to 200 pages, and nothing at all once
    // the projections have caught up: an extraction enqueues its own re-index,
    // so this only ever sees the attachments read before the projection
    // carried their text and the occasional re-index that was lost (issue
    // #101). Slower than the embedding backfill because it costs one query
    // rather than a paid call, and nobody is waiting on it.
    await schedule('backfill-attachment-search-text', { every: 600_000 });
    // Daily, after the snapshot sweep. Does nothing while
    // `memory.retentionDays` is zero, which is the default.
    await schedule('prune-memories', { pattern: '15 4 * * *' });
    // Daily, after the other sweeps. One indexed DELETE that matches nothing on
    // almost every run: invitations expire in a week and are kept for a month
    // after that, so this only ever has work in a deployment that invites people
    // and gets ignored (issue #3).
    await schedule('prune-invitations', { pattern: '45 4 * * *' });
    // Hourly, not nightly. A message carries its own `expiresAt`, so unlike
    // every other sweep here this one is not waiting for a retention setting
    // somebody has to switch on -- it is the mechanism the mailbox's promise
    // rests on, and "expires in a day" should mean a day rather than a day plus
    // however long until 4am (issue #51).
    await schedule('prune-agent-messages', { pattern: '20 * * * *' });
    // Daily, with the other sweeps. Two indexed DELETEs that usually match
    // nothing: the journal is kept for ninety days by default, so this only has
    // work once a deployment has been letting agents write for a season
    // (issue #49).
    await schedule('prune-agent-journal', { pattern: '50 4 * * *' });
    // Daily, before the note prune: facts are distilled from notes, so the
    // distilling has to happen while the notes are still there. A no-op while
    // `memory.consolidationEnabled` is off, which is the default.
    await schedule('consolidate-memories', { pattern: '0 3 * * *' });
    // Daily, after the consolidation: a fact confirmed tonight should not lose
    // weight in the same hour it gained it.
    await schedule('decay-memory-facts', { pattern: '45 3 * * *' });
    // Daily, last of the nightly sweeps. A no-op while
    // `ai.runPayloadRetentionDays` is zero, which is the default; once it is
    // set, one indexed UPDATE that finds a handful of rows a day (issue #10).
    // Hourly. Who serves a model, and what a `latest` alias points at, both
    // move on their own, and every request's provider allowlist is planned
    // from that snapshot (ADR-032). Hourly rather than every few minutes:
    // prices and providers change on the scale of days, and a run that sees an
    // alias answer as something else marks the row for the next sweep itself.
    await schedule('sync-ai-model-routes', { pattern: '7 * * * *' });
    await schedule('prune-ai-run-payloads', { pattern: '30 5 * * *' });
    // Daily, after the journal prune. A no-op while
    // `automations.runRetentionDays` is zero; once it is set, one indexed
    // DELETE that finds nothing on a deployment quieter than its retention
    // window (issue #50).
    await schedule('prune-automation-runs', { pattern: '55 4 * * *' });
    // Every minute, which is also the finest a schedule can be (issue #73).
    // The clock's half of the automation trigger side: one indexed query over
    // `nextRunAt` that finds nothing on a deployment with no scheduled rules.
    await schedule('run-due-automations', { every: 60_000 });
    // Every two minutes: this one is not a nightly sweep. Half of it closes
    // builds whose worker is gone, and a person watching a spinner should not
    // have to wait until tomorrow to be told that nothing is coming (issue #44).
    await schedule('reap-render-jobs', { every: 120_000 });
    // And the same cadence for project builds, for the same reason (issue #43).
    await schedule('reap-project-builds', { every: 120_000 });
    // Hourly, off the hour so it never lands with the nightly sweeps. The
    // safety net under materialization: whoever writes the canonical state
    // enqueues the job that derives everything else, and a lost enqueue is
    // lost in silence. A run costs one indexed query while nothing is behind.
    await schedule('rematerialize-stale-content', { pattern: '25 * * * *' });
    // Hourly, twenty minutes after the materialization net so the two never
    // run together: the same kind of safety net one layer further out. An
    // overview is composed from digests that materialization produces, and a
    // sweep that ran first would compose from yesterday's text (issue #53).
    await schedule('refresh-stale-overviews', { pattern: '45 * * * *' });
    this.logger.info('Maintenance schedulers registered');
  }

  /**
   * Registers the calendar sync schedulers.
   *
   * Three cadences, because the three modes cost very different things. `pull`
   * reads changed objects and, thanks to sync tokens and etags, costs one REPORT
   * per calendar when nothing happened -- cheap enough for every five minutes.
   * `discover` re-lists the collections and may create documents and columns, so
   * it runs once a day: a new calendar appearing on someone's phone does not need
   * to show up here within the minute.
   *
   * `remind` runs every minute and talks to no calendar server at all. The tight
   * cadence is the point: a reminder is a promise about a time, and one that
   * arrives four minutes late has broken it. It costs one indexed query per tick
   * and nothing else while nothing is due.
   *
   * All three are no-ops without a `calendar_account` row, so registering them on
   * a deployment that has no calendar costs one indexed query per tick.
   */
  async scheduleCalendarSync(correlationId: string): Promise<void> {
    const queue = this.rawQueue(QUEUE_NAMES.calendarSync);
    await queue.upsertJobScheduler(
      'calendar-pull',
      { every: 300_000 },
      {
        name: QUEUE_NAMES.calendarSync,
        data: { correlationId, accountId: null, mode: 'pull', full: false },
      },
    );
    await queue.upsertJobScheduler(
      'calendar-discover',
      { pattern: '15 5 * * *' },
      {
        name: QUEUE_NAMES.calendarSync,
        data: { correlationId, accountId: null, mode: 'discover', full: false },
      },
    );
    await queue.upsertJobScheduler(
      'calendar-remind',
      { every: 60_000 },
      {
        name: QUEUE_NAMES.calendarSync,
        data: { correlationId, accountId: null, mode: 'remind', full: false },
      },
    );
    this.logger.info('Calendar sync schedulers registered');
  }

  async ping(): Promise<boolean> {
    const result = await this.connection.ping();
    return result === 'PONG';
  }

  /**
   * Deletes every queue in this registry's namespace, jobs included.
   *
   * For test teardown: a suite's jobs are never consumed, since no worker runs
   * on a test prefix, so without this they stay in Redis for good. It refuses to
   * run on any other prefix, because on the deployment's namespace it would
   * delete the work the live worker is about to do -- which is exactly what
   * happened while the suites shared it.
   */
  async obliterateAll(): Promise<void> {
    if (!this.prefix.startsWith(TEST_QUEUE_PREFIX_MARKER)) {
      throw new Error(
        `obliterateAll refused: prefix "${this.prefix}" is not a test namespace. ` +
          'Pass `prefix: testQueuePrefix("<suite>")` to the registry.',
      );
    }
    for (const name of Object.values(QUEUE_NAMES)) {
      await this.rawQueue(name)
        .obliterate({ force: true })
        .catch(() => {
          // A queue no test touched was never created; nothing to clean up.
        });
    }
  }

  /** Closes every queue and the shared connection. */
  async close(): Promise<void> {
    await Promise.all([...this.queues.values()].map((queue) => queue.close()));
    await Promise.all([...this.events.values()].map((events) => events.close()));
    this.queues.clear();
    this.events.clear();
    await this.connection.quit();
    this.logger.info('Queue registry closed');
  }
}
