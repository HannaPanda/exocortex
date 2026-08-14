import { type Job, UnrecoverableError, Worker, type WorkerOptions } from 'bullmq';

import { JOB_SCHEMAS, type JobPayloadMap, type QueueName } from '@exocortex/contracts';
import { type Logger } from '@exocortex/logger';

import { createRedisConnection, type Redis } from './connection';
import { DEFAULT_QUEUE_PREFIX } from './registry';

export interface JobContext<TName extends QueueName> {
  payload: JobPayloadMap[TName];
  job: Job<JobPayloadMap[TName]>;
  logger: Logger;
  /** Reports progress in percent; forwarded to clients as a `job.progress` event. */
  reportProgress(progress: number, label: string): Promise<void>;
}

export type JobHandler<TName extends QueueName> = (context: JobContext<TName>) => Promise<void>;

export interface CreateWorkerOptions<TName extends QueueName> {
  name: TName;
  redisUrl: string;
  logger: Logger;
  handler: JobHandler<TName>;
  /**
   * Redis key namespace. Must match the producer's, or this worker polls a
   * namespace nobody writes to. Defaults to `DEFAULT_QUEUE_PREFIX`.
   */
  prefix?: string;
  concurrency?: number;
  /** Overrides the default lock duration; see `AI_QUEUE_LOCK_DURATION_MS`. */
  lockDuration?: number;
  /** Overrides BullMQ's own default; see `AI_QUEUE_STALLED_INTERVAL_MS`. */
  stalledInterval?: number;
  /** Optional hook invoked whenever progress is reported. */
  onProgress?: (
    payload: JobPayloadMap[TName],
    progress: number,
    label: string,
    job: Job<JobPayloadMap[TName]>,
  ) => void | Promise<void>;
  onCompleted?: (
    payload: JobPayloadMap[TName],
    job: Job<JobPayloadMap[TName]>,
    durationMs: number,
  ) => void | Promise<void>;
  onFailed?: (
    payload: JobPayloadMap[TName] | null,
    job: Job<JobPayloadMap[TName]> | undefined,
    error: Error,
  ) => void | Promise<void>;
}

export class InvalidJobPayloadError extends Error {
  constructor(queue: string, jobId: string, reason: string) {
    super(`Invalid payload for job ${jobId} on queue "${queue}": ${reason}`);
    this.name = 'InvalidJobPayloadError';
  }
}

/**
 * Creates a BullMQ worker with runtime-validated payloads, correlation-aware
 * logging and progress reporting.
 *
 * Failures are always logged and rethrown so BullMQ can apply the retry policy;
 * a job is never silently dropped.
 */
export function createTypedWorker<TName extends QueueName>(
  options: CreateWorkerOptions<TName>,
): { worker: Worker<JobPayloadMap[TName]>; connection: Redis } {
  const connection = createRedisConnection(options.redisUrl);
  const baseLogger = options.logger.child({ queue: options.name });

  const workerOptions: WorkerOptions = {
    connection,
    prefix: options.prefix ?? DEFAULT_QUEUE_PREFIX,
    concurrency: options.concurrency ?? 4,
    // Keep the lock long enough for a large materialization run. The `ai`
    // queue overrides this to a much longer value (see main.ts): an agentic
    // run can legitimately take minutes, and BullMQ renews the lock itself
    // every `lockDuration / 2` anyway.
    lockDuration: options.lockDuration ?? 60_000,
    ...(options.stalledInterval === undefined ? {} : { stalledInterval: options.stalledInterval }),
  };

  const worker = new Worker<JobPayloadMap[TName]>(
    options.name,
    async (job) => {
      const startedAt = Date.now();
      const parsed = JOB_SCHEMAS[options.name].safeParse(job.data);
      if (!parsed.success) {
        const reason = parsed.error.issues
          .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
          .join('; ');
        const error = new InvalidJobPayloadError(options.name, job.id ?? 'unknown', reason);
        baseLogger.error('Rejecting job with invalid payload', error, { jobId: job.id });
        // Structurally invalid payloads can never succeed, so they must not be
        // retried. They stay in the failed set for inspection.
        throw new UnrecoverableError(error.message);
      }

      const payload = parsed.data as JobPayloadMap[TName];
      const logger = baseLogger.child({
        jobId: job.id,
        correlationId: payload.correlationId,
      });

      const reportProgress = async (progress: number, label: string): Promise<void> => {
        const clamped = Math.max(0, Math.min(100, Math.round(progress)));
        await job.updateProgress(clamped);
        await options.onProgress?.(payload, clamped, label, job);
      };

      logger.debug('Job started');
      await options.handler({ payload, job, logger, reportProgress });
      const durationMs = Date.now() - startedAt;
      logger.info('Job completed', { durationMs });
      await options.onCompleted?.(payload, job, durationMs);
    },
    workerOptions,
  );

  worker.on('failed', (job, error) => {
    const attemptsMade = job?.attemptsMade ?? 0;
    baseLogger.error('Job failed', error, {
      jobId: job?.id,
      attemptsMade,
    });
    const parsed = job === undefined ? null : JOB_SCHEMAS[options.name].safeParse(job.data);
    void options.onFailed?.(
      parsed !== null && parsed.success ? (parsed.data as JobPayloadMap[TName]) : null,
      job,
      error,
    );
  });

  worker.on('error', (error) => {
    baseLogger.error('Worker error', error);
  });

  return { worker, connection };
}
