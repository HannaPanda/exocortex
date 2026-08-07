import { type JobsOptions, Queue, QueueEvents } from 'bullmq';

import {
  JOB_SCHEMAS,
  type JobPayloadMap,
  QUEUE_NAMES,
  type QueueName,
} from '@exocortex/contracts';
import { type Logger } from '@exocortex/logger';

import { createRedisConnection, type Redis } from './connection';

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
};

/** Debounce window for document materialization. */
export const MATERIALIZATION_DEBOUNCE_MS = 2_000;
/** Upper bound so a continuously edited document is still materialized. */
export const MATERIALIZATION_MAX_DELAY_MS = 15_000;

export interface QueueRegistryOptions {
  redisUrl: string;
  logger: Logger;
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

  constructor(options: QueueRegistryOptions) {
    this.connection = createRedisConnection(options.redisUrl);
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
      defaultJobOptions: { ...DEFAULT_JOB_OPTIONS, ...(QUEUE_JOB_OPTIONS[name] ?? {}) },
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
    const queueEvents = new QueueEvents(name, { connection: this.connection.duplicate() });
    this.events.set(name, queueEvents);
    return queueEvents;
  }

  /** Validates and enqueues a job. */
  async enqueue<TName extends QueueName>(
    name: TName,
    payload: JobPayloadMap[TName],
    options: EnqueueOptions = {},
  ): Promise<string> {
    const parsed = JOB_SCHEMAS[name].parse(payload) as JobPayloadMap[TName];
    const job = await this.rawQueue(name).add(name, parsed, options);
    this.logger.debug('Job enqueued', {
      queue: name,
      jobId: job.id,
      correlationId: parsed.correlationId,
    });
    return job.id ?? '';
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
    const parsed = JOB_SCHEMAS[name].parse(payload) as JobPayloadMap[TName];
    const queue = this.rawQueue(name);

    const existing = await queue.getJob(jobId);
    if (existing !== undefined) {
      const state = await existing.getState();
      if (state === 'delayed' || state === 'waiting') {
        const firstEnqueuedAt = existing.timestamp;
        const cap = maxDelayMs ?? MATERIALIZATION_MAX_DELAY_MS;
        const elapsed = Date.now() - firstEnqueuedAt;
        if (elapsed + delayMs <= cap) {
          try {
            await existing.updateData(parsed);
            if (state === 'delayed') await existing.changeDelay(delayMs);
            return existing.id ?? jobId;
          } catch (error) {
            // The job may have started between the state check and the update.
            this.logger.debug('Debounced job could not be postponed, adding a new one', {
              queue: name,
              jobId,
              reason: error instanceof Error ? error.message : String(error),
            });
          }
        } else {
          // Cap reached: let the pending job run and do not postpone it further.
          return existing.id ?? jobId;
        }
      }
    }

    const job = await queue.add(name, parsed, { ...rest, jobId, delay: delayMs });
    return job.id ?? jobId;
  }

  /** Registers the recurring maintenance jobs. Idempotent. */
  async scheduleMaintenance(correlationId: string): Promise<void> {
    const queue = this.rawQueue(QUEUE_NAMES.maintenance);
    await queue.upsertJobScheduler(
      'dispatch-outbox',
      { every: 5_000 },
      {
        name: QUEUE_NAMES.maintenance,
        data: { correlationId, task: 'dispatch-outbox', workspaceId: null },
      },
    );
    await queue.upsertJobScheduler(
      'prune-snapshots',
      { pattern: '0 4 * * *' },
      {
        name: QUEUE_NAMES.maintenance,
        data: { correlationId, task: 'prune-snapshots', workspaceId: null },
      },
    );
    await queue.upsertJobScheduler(
      'collect-orphaned-covers',
      { pattern: '30 4 * * *' },
      {
        name: QUEUE_NAMES.maintenance,
        data: { correlationId, task: 'collect-orphaned-covers', workspaceId: null },
      },
    );
    // Every minute: the second-line defence for a run whose worker died
    // without a chance to close it out itself (issue #16). See
    // `apps/worker/src/processors/maintenance.ts`.
    await queue.upsertJobScheduler(
      'reap-stale-ai-runs',
      { every: 60_000 },
      {
        name: QUEUE_NAMES.maintenance,
        data: { correlationId, task: 'reap-stale-ai-runs', workspaceId: null },
      },
    );
    this.logger.info('Maintenance schedulers registered');
  }

  async ping(): Promise<boolean> {
    const result = await this.connection.ping();
    return result === 'PONG';
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
