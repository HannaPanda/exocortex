import { type WorkerEnv } from '@exocortex/config';
import {
  AI_QUEUE_LOCK_DURATION_MS,
  AI_QUEUE_STALLED_INTERVAL_MS,
  PROJECT_BUILD_QUEUE_LOCK_DURATION_MS,
  PROJECT_BUILD_QUEUE_STALLED_INTERVAL_MS,
  QUEUE_NAMES,
  RENDER_QUEUE_LOCK_DURATION_MS,
  RENDER_QUEUE_STALLED_INTERVAL_MS,
} from '@exocortex/contracts';
import { type Logger } from '@exocortex/logger';
import { createTypedWorker } from '@exocortex/queue';

import { createAiRunProcessor } from './processors/ai-run';
import { createAttachmentTextProcessor } from './processors/attachment-text';
import { createAutomationProcessor } from './processors/automation';
import { createCalendarSyncProcessor } from './processors/calendar-sync';
import { createDocumentCoverProcessor } from './processors/document-cover';
import { createEntityRescanProcessor } from './processors/entity-rescan';
import { createIndexDocumentProcessor } from './processors/index-document';
import { createMaintenanceProcessor } from './processors/maintenance';
import { createMaterializeDocumentProcessor } from './processors/materialize-document';
import { createMemoryCaptureProcessor } from './processors/memory-capture';
import { createMemoryConsolidateProcessor } from './processors/memory-consolidate';
import { createProjectBuildProcessor } from './processors/project-build';
import { createRenderProcessor } from './processors/render';
import { type WorkerRuntime } from './runtime';

/**
 * The twelve queues this process listens on.
 *
 * Concurrency is per queue and deliberately uneven: materialization is cheap
 * and parallel, PDF extraction is CPU-bound and runs one at a time.
 */
/**
 * What the shutdown path needs from a started worker, and nothing else.
 *
 * Structural rather than `ReturnType<typeof createTypedWorker>`: each queue has
 * its own payload type, so the twelve of them only share this much.
 */
export interface QueueWorker {
  worker: { close: () => Promise<void> };
  connection: { quit: () => Promise<unknown> };
}

/**
 * The twelve queues this process listens on, in two groups.
 *
 * Concurrency is per queue and deliberately uneven: materialization is cheap
 * and parallel, PDF extraction is an external call and runs one at a time so it
 * cannot crowd document materialization out.
 */
export function startQueueWorkers(
  env: WorkerEnv,
  runtime: WorkerRuntime,
  logger: Logger,
): QueueWorker[] {
  return [...startCoreWorkers(env, runtime, logger), ...startMediaWorkers(env, runtime, logger)];
}

/** Materialization, search indexing, the AI runs and the maintenance sweeps. */
function startCoreWorkers(env: WorkerEnv, runtime: WorkerRuntime, logger: Logger): QueueWorker[] {
  const {
    prisma,
    queues,
    bus,
    providerFor,
    storage,
    search,
    readSettings,
    toolRunnerFactory,
    visionPreprocessorFor,
    modelRegistry,
    publishProgress,
  } = runtime;

  const materialization = createTypedWorker({
    name: QUEUE_NAMES.documentMaterialization,
    redisUrl: env.REDIS_URL,
    logger,
    concurrency: 4,
    handler: createMaterializeDocumentProcessor({
      prisma,
      queues,
      bus,
      settings: readSettings,
    }),
    onProgress: async (payload, progress, label, job) => {
      await publishProgress({
        queue: QUEUE_NAMES.documentMaterialization,
        workspaceId: payload.workspaceId,
        correlationId: payload.correlationId,
        jobId: job.id ?? '',
        progress,
        label,
        documentId: payload.documentId,
      });
    },
    onCompleted: async (payload, job, durationMs) => {
      await bus.publish({
        type: 'job.completed',
        workspaceId: payload.workspaceId,
        correlationId: payload.correlationId,
        emittedAt: new Date().toISOString(),
        payload: {
          jobId: job.id ?? '',
          queue: QUEUE_NAMES.documentMaterialization,
          progress: 100,
          label: 'Seite verarbeitet',
          documentId: payload.documentId,
          durationMs,
        },
      });
    },
    onFailed: async (payload, job, error) => {
      if (payload === null) return;
      await bus.publish({
        type: 'job.failed',
        workspaceId: payload.workspaceId,
        correlationId: payload.correlationId,
        emittedAt: new Date().toISOString(),
        payload: {
          jobId: job?.id ?? '',
          queue: QUEUE_NAMES.documentMaterialization,
          progress: 0,
          label: 'Seite konnte nicht verarbeitet werden',
          documentId: payload.documentId,
          reason: error.message,
          attemptsMade: job?.attemptsMade ?? 0,
          willRetry: (job?.attemptsMade ?? 0) < (job?.opts.attempts ?? 1),
        },
      });
    },
  });

  const indexing = createTypedWorker({
    name: QUEUE_NAMES.searchIndexing,
    redisUrl: env.REDIS_URL,
    logger,
    concurrency: 4,
    handler: createIndexDocumentProcessor({ prisma, search }),
  });

  const ai = createTypedWorker({
    name: QUEUE_NAMES.ai,
    redisUrl: env.REDIS_URL,
    logger,
    concurrency: 2,
    // A run's own budget (`ai.maxRunMs`) can run into the minutes, so the
    // queue's lock has to comfortably outlast it; `stalledInterval` follows
    // the same reasoning (see `packages/contracts/src/ai-runtime.ts`).
    lockDuration: AI_QUEUE_LOCK_DURATION_MS,
    stalledInterval: AI_QUEUE_STALLED_INTERVAL_MS,
    handler: createAiRunProcessor({
      prisma,
      providerFor,
      bus,
      storage,
      settings: readSettings,
      toolRunnerFactory,
      visionPreprocessorFor,
      modelRegistry,
    }),
    onFailed: async (payload, job, error) => {
      if (payload === null) return;
      logger.error('AI job failed', error, { runId: payload.runId, jobId: job?.id });

      // `createAiRunProcessor` never throws on a provider or timeout failure --
      // it writes a terminal status itself -- so landing here at all means an
      // infrastructure error (crashed process, lost database connection) left
      // the row on PENDING or RUNNING. Second rescue path alongside the
      // maintenance reaper (`reap-stale-ai-runs`), and a faster one: this
      // fires the moment BullMQ gives up rather than on the reaper's
      // up-to-a-minute cycle. Guarded on attempts exhausted, since the `ai`
      // queue's `attempts: 1` still leaves this the only attempt anyway.
      const attemptsAllowed = job?.opts.attempts ?? 1;
      if (job !== undefined && job.attemptsMade < attemptsAllowed) return;
      const closed = await prisma.aiRun.updateMany({
        where: { id: payload.runId, status: { in: ['PENDING', 'RUNNING'] } },
        data: { status: 'FAILED', errorCode: 'ai_run_abandoned', finishedAt: new Date() },
      });
      if (closed.count === 1) {
        await bus.publish({
          type: 'ai.run.failed',
          workspaceId: payload.workspaceId,
          correlationId: payload.correlationId,
          emittedAt: new Date().toISOString(),
          payload: {
            runId: payload.runId,
            status: 'failed',
            errorCode: 'ai_run_abandoned',
            reason: 'The job failed and BullMQ has no attempts left',
          },
        });
      }
    },
  });

  const maintenance = createTypedWorker({
    name: QUEUE_NAMES.maintenance,
    redisUrl: env.REDIS_URL,
    logger,
    concurrency: 1,
    handler: createMaintenanceProcessor({
      prisma,
      queues,
      storage,
      bus,
      search,
      settings: readSettings,
    }),
  });

  return [materialization, indexing, ai, maintenance];
}

/** Everything that turns a file, a page or a calendar into something else. */
function startMediaWorkers(env: WorkerEnv, runtime: WorkerRuntime, logger: Logger): QueueWorker[] {
  const {
    prisma,
    bus,
    provider,
    storage,
    readSettings,
    apiClientFor,
    resolveCalendarCredentials,
    reminderNotifier,
    imageGeneratorFor,
    pdfDocumentInfo,
    pdfExtractorChain,
    credentialKey,
  } = runtime;

  // Concurrency 1: PDF extraction is an external call and must not crowd out
  // document materialization.
  const attachmentText = createTypedWorker({
    name: QUEUE_NAMES.attachmentText,
    redisUrl: env.REDIS_URL,
    logger,
    concurrency: 1,
    handler: createAttachmentTextProcessor({
      prisma,
      storage,
      extractors: pdfExtractorChain,
      documentInfo: pdfDocumentInfo,
      settings: readSettings,
    }),
    onFailed: async (payload, job, error) => {
      if (payload === null) return;
      logger.error('Attachment text extraction job failed', error, {
        attachmentId: payload.attachmentId,
        jobId: job?.id,
      });

      // Once BullMQ is out of retries the row would otherwise stay PENDING for
      // good, and `GET /attachments/:id/text` only re-enqueues a FAILED or
      // NOT_APPLICABLE one -- so the attachment would report "extraction is
      // still running" forever with nothing left to run it.
      const attempts = job?.opts.attempts ?? 0;
      if (job !== undefined && job.attemptsMade >= attempts) {
        await prisma.attachment.updateMany({
          where: { id: payload.attachmentId, textStatus: 'PENDING' },
          data: {
            textStatus: 'FAILED',
            textExtractionError: `Extraction failed after ${job.attemptsMade} attempts: ${
              error instanceof Error ? error.message : String(error)
            }`.slice(0, 500),
          },
        });
      }
    },
  });

  // Concurrency 1: an image model is slow, expensive and rate limited, and a
  // page has exactly one cover -- there is nothing to gain from drawing two at
  // once, and a burst would only hit the provider's limit.
  const documentCover = createTypedWorker({
    name: QUEUE_NAMES.documentCover,
    redisUrl: env.REDIS_URL,
    logger,
    concurrency: 1,
    handler: createDocumentCoverProcessor({
      imageGeneratorFor,
      apiClientFor,
      bus,
      settings: readSettings,
    }),
  });

  // Concurrency 1: this talks to someone else's mail server. Two passes over the
  // same account would race on the sync token, and a parallel burst per calendar
  // is how a sync gets itself rate limited.
  const calendarSync = createTypedWorker({
    name: QUEUE_NAMES.calendarSync,
    redisUrl: env.REDIS_URL,
    logger,
    concurrency: 1,
    handler: createCalendarSyncProcessor({
      prisma,
      apiClientFor,
      credentialsFor: resolveCalendarCredentials,
      notifier: reminderNotifier,
      settings: readSettings,
      appUrl: env.APP_URL,
    }),
  });

  // Concurrency 1: one model call per finished session, and several sessions
  // ending at once is exactly the burst that should queue rather than fan out
  // into parallel paid calls.
  const memoryCapture = createTypedWorker({
    name: QUEUE_NAMES.memoryCapture,
    redisUrl: env.REDIS_URL,
    logger,
    concurrency: 1,
    handler: createMemoryCaptureProcessor({
      provider,
      apiClientFor,
      settings: readSettings,
      defaultModel: env.OPENROUTER_DEFAULT_MODEL ?? null,
    }),
  });

  // Concurrency 1 for the same reason: a nightly fan-out over ten projects is
  // ten paid calls, and they should be ten in a row rather than ten at once.
  const memoryConsolidate = createTypedWorker({
    name: QUEUE_NAMES.memoryConsolidate,
    redisUrl: env.REDIS_URL,
    logger,
    concurrency: 1,
    handler: createMemoryConsolidateProcessor({
      prisma,
      provider,
      apiClientFor,
      settings: readSettings,
      defaultModel: env.OPENROUTER_DEFAULT_MODEL ?? null,
    }),
  });

  // Concurrency 1 because a rescan is a full-text scan of the deployment, and
  // two of them at once is the one way this cheap job becomes expensive.
  const entityRescan = createTypedWorker({
    name: QUEUE_NAMES.entityRescan,
    redisUrl: env.REDIS_URL,
    logger,
    concurrency: 1,
    handler: createEntityRescanProcessor({ prisma, settings: readSettings }),
  });

  // Concurrency 2: an automation is either a short POST to somebody else's
  // server or one paid model call, and a page tree somebody reorganised can
  // fire a handful at once. Two keeps that moving without turning a burst of
  // rules into a burst of spending.
  const automation = createTypedWorker({
    name: QUEUE_NAMES.automation,
    redisUrl: env.REDIS_URL,
    logger,
    concurrency: 2,
    handler: createAutomationProcessor({
      prisma,
      provider,
      apiClientFor,
      settings: readSettings,
      defaultModel: env.OPENROUTER_DEFAULT_MODEL ?? null,
      credentialKey,
    }),
  });

  // Concurrency 1: a LaTeX run is CPU-bound and this host shares its cores with
  // everything else on it. Two builds at once would not finish a single PDF any
  // sooner and would take the machine down with them on a big document.
  const render = createTypedWorker({
    name: QUEUE_NAMES.render,
    redisUrl: env.REDIS_URL,
    logger,
    concurrency: 1,
    // `render.timeoutSeconds` allows a build up to fifteen minutes, so the lock
    // has to outlast it or BullMQ declares the job stalled and hands it to a
    // second worker while the first one is still holding a container open.
    lockDuration: RENDER_QUEUE_LOCK_DURATION_MS,
    stalledInterval: RENDER_QUEUE_STALLED_INTERVAL_MS,
    handler: createRenderProcessor({
      prisma,
      storage,
      apiClientFor,
      settings: readSettings,
      bus,
    }),
  });

  // Concurrency 1 for the same reason as the render queue: latexmk is
  // CPU-bound and this host shares its cores with everything else on it.
  const projectBuild = createTypedWorker({
    name: QUEUE_NAMES.projectBuild,
    redisUrl: env.REDIS_URL,
    logger,
    concurrency: 1,
    lockDuration: PROJECT_BUILD_QUEUE_LOCK_DURATION_MS,
    stalledInterval: PROJECT_BUILD_QUEUE_STALLED_INTERVAL_MS,
    handler: createProjectBuildProcessor({
      prisma,
      storage,
      apiClientFor,
      settings: readSettings,
      bus,
    }),
  });

  return [
    attachmentText,
    documentCover,
    calendarSync,
    memoryCapture,
    memoryConsolidate,
    entityRescan,
    automation,
    render,
    projectBuild,
  ];
}
