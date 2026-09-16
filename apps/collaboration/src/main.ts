import { loadCollaborationEnv } from '@exocortex/config';
import { createPrismaClient } from '@exocortex/database';
import { createLogger, startTracing } from '@exocortex/logger';
import { QueueRegistry } from '@exocortex/queue';

import { createCollaborationServer } from './server';

/**
 * Entry point of the collaboration server.
 *
 * Runs as its own process so a crash in the editing hot path cannot take down
 * the REST API, and so it can be scaled independently.
 */
async function bootstrap(): Promise<void> {
  const env = loadCollaborationEnv();
  const logger = createLogger({
    name: 'collaboration',
    level: env.LOG_LEVEL,
    pretty: env.NODE_ENV === 'development',
  });

  // The collaboration server enqueues materialization for every document it
  // stores; without tracing here that job would start a trace of its own with
  // nothing above it (issue #57).
  const tracing = await startTracing({
    serviceName: 'collaboration',
    endpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
    headers: env.OTEL_EXPORTER_OTLP_HEADERS,
    sampleRatio: env.OTEL_TRACES_SAMPLER_RATIO,
    enabled: env.OTEL_TRACES_ENABLED,
    environment: env.NODE_ENV,
    logger,
  });

  const prisma = createPrismaClient({ databaseUrl: env.DATABASE_URL });
  const queues = new QueueRegistry({ redisUrl: env.REDIS_URL, logger });

  const { server } = createCollaborationServer({
    prisma,
    queues,
    logger,
    ticketSecret: env.COLLABORATION_TICKET_SECRET,
    port: env.COLLABORATION_PORT,
    address: '127.0.0.1',
    redisUrl: env.REDIS_URL,
  });

  await server.listen();
  logger.info('Collaboration server listening', {
    port: env.COLLABORATION_PORT,
    environment: env.NODE_ENV,
  });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('Shutting down collaboration server', { signal });
    try {
      // Destroying the server flushes pending document stores first.
      await server.destroy();
      await queues.close();
      await prisma.$disconnect();
      await tracing?.shutdown();
      logger.info('Collaboration server stopped cleanly');
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
  process.on('uncaughtException', (error) => {
    logger.fatal('Uncaught exception', error);
    void shutdown('uncaughtException');
  });
}

void bootstrap().catch((error: unknown) => {
  // The logger may not exist yet, so write the failure to stderr as well.
  console.error('Failed to start the collaboration server:', error);
  process.exit(1);
});
