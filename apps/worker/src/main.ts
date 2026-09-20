import { loadWorkerEnv } from '@exocortex/config';
import { QUEUE_NAMES } from '@exocortex/contracts';
import {
  createCorrelationId,
  createLogger,
  type Logger,
  startTracing,
  type TracingHandle,
} from '@exocortex/logger';

import { type QueueWorker, startQueueWorkers } from './queue-workers';
import { createWorkerRuntime, type WorkerRuntime } from './runtime';

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

  // Before the first job is picked up: a job whose span is a no-op has no
  // parent to hang the AI run, the turns and the tool calls under (issue #57).
  const tracing = await startTracing({
    serviceName: 'worker',
    endpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
    headers: env.OTEL_EXPORTER_OTLP_HEADERS,
    sampleRatio: env.OTEL_TRACES_SAMPLER_RATIO,
    enabled: env.OTEL_TRACES_ENABLED,
    environment: env.NODE_ENV,
    logger,
  });

  const runtime = createWorkerRuntime(env, logger);
  const workers = startQueueWorkers(env, runtime, logger);

  await runtime.queues.scheduleMaintenance(createCorrelationId());
  await runtime.queues.scheduleCalendarSync(createCorrelationId());

  logger.info('Worker started', {
    environment: env.NODE_ENV,
    queues: Object.values(QUEUE_NAMES),
    aiProvider: runtime.provider.id,
    tools: runtime.toolRunnerFactory !== null,
  });

  installShutdown(workers, runtime, logger, tracing);
}

/**
 * Stops cleanly on a deploy: `close()` waits for in-flight jobs, so no job is
 * lost when systemd restarts this process.
 */
function installShutdown(
  workers: readonly QueueWorker[],
  runtime: WorkerRuntime,
  logger: Logger,
  tracing: TracingHandle | null,
): void {
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('Shutting down worker', { signal });
    try {
      await Promise.all(workers.map((entry) => entry.worker.close()));
      await Promise.all(workers.map((entry) => entry.connection.quit()));
      await runtime.bus.close();
      await runtime.queues.close();
      // After the workers, so a mail job that was still in flight has already
      // handed its message over rather than losing the transport under it.
      await runtime.mailer.close();
      await runtime.prisma.$disconnect();
      await tracing?.shutdown();
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
