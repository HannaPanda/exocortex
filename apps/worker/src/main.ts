import { createAiProvider } from '@exocortex/ai';
import { loadWorkerEnv } from '@exocortex/config';
import { QUEUE_NAMES } from '@exocortex/contracts';
import { createPrismaClient, PostgresSearchAdapter } from '@exocortex/database';
import { createCorrelationId, createLogger } from '@exocortex/logger';
import { createTypedWorker, QueueRegistry, RedisEventBus } from '@exocortex/queue';

import { createAiRunProcessor } from './processors/ai-run';
import { createIndexDocumentProcessor } from './processors/index-document';
import { createMaintenanceProcessor } from './processors/maintenance';
import { createMaterializeDocumentProcessor } from './processors/materialize-document';

/**
 * Worker process.
 *
 * Expensive work never happens inside an API request handler. Every processor is
 * idempotent, reports progress and lets failures bubble up so BullMQ applies the
 * configured retry policy.
 */
async function bootstrap(): Promise<void> {
  const env = loadWorkerEnv();
  const logger = createLogger({
    name: 'worker',
    level: env.LOG_LEVEL,
    pretty: env.NODE_ENV === 'development',
  });

  const prisma = createPrismaClient({ databaseUrl: env.DATABASE_URL });
  const queues = new QueueRegistry({ redisUrl: env.REDIS_URL, logger });
  const bus = new RedisEventBus({ redisUrl: env.REDIS_URL, logger });
  const search = new PostgresSearchAdapter(prisma);
  const provider = createAiProvider({
    providerId: env.AI_PROVIDER,
    logger,
    appUrl: env.APP_URL,
    openRouter: { apiKey: env.OPENROUTER_API_KEY ?? '', baseUrl: env.OPENROUTER_BASE_URL },
  });

  /** Publishes a `job.progress` event so the UI can show live progress. */
  const publishProgress = async (
    queue: (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES],
    workspaceId: string,
    correlationId: string,
    jobId: string,
    progress: number,
    label: string,
    documentId: string | null,
  ): Promise<void> => {
    await bus.publish({
      type: 'job.progress',
      workspaceId,
      correlationId,
      emittedAt: new Date().toISOString(),
      payload: { jobId, queue, progress, label, documentId },
    });
  };

  const materialization = createTypedWorker({
    name: QUEUE_NAMES.documentMaterialization,
    redisUrl: env.REDIS_URL,
    logger,
    concurrency: 4,
    handler: createMaterializeDocumentProcessor({ prisma, queues, bus }),
    onProgress: async (payload, progress, label, job) => {
      await publishProgress(
        QUEUE_NAMES.documentMaterialization,
        payload.workspaceId,
        payload.correlationId,
        job.id ?? '',
        progress,
        label,
        payload.documentId,
      );
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
    handler: createAiRunProcessor({ prisma, provider, bus }),
    onFailed: async (payload, job, error) => {
      if (payload === null) return;
      logger.error('AI job failed', error, { runId: payload.runId, jobId: job?.id });
    },
  });

  const maintenance = createTypedWorker({
    name: QUEUE_NAMES.maintenance,
    redisUrl: env.REDIS_URL,
    logger,
    concurrency: 1,
    handler: createMaintenanceProcessor({ prisma, queues }),
  });

  await queues.scheduleMaintenance(createCorrelationId());

  logger.info('Worker started', {
    environment: env.NODE_ENV,
    queues: Object.values(QUEUE_NAMES),
    aiProvider: provider.id,
  });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('Shutting down worker', { signal });
    try {
      // `close()` waits for in-flight jobs, so no job is lost on deploy.
      await Promise.all([
        materialization.worker.close(),
        indexing.worker.close(),
        ai.worker.close(),
        maintenance.worker.close(),
      ]);
      await Promise.all([
        materialization.connection.quit(),
        indexing.connection.quit(),
        ai.connection.quit(),
        maintenance.connection.quit(),
      ]);
      await bus.close();
      await queues.close();
      await prisma.$disconnect();
      logger.info('Worker stopped cleanly');
      process.exit(0);
    } catch (error) {
      logger.fatal('Graceful shutdown failed', error);
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled promise rejection', reason);
  });
}

void bootstrap().catch((error: unknown) => {
  console.error('Failed to start the worker:', error);
  process.exit(1);
});
