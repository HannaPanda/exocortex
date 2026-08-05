import fastifyCookie from '@fastify/cookie';
import fastifyHelmet from '@fastify/helmet';
import fastifyMultipart from '@fastify/multipart';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { type FastifyInstance } from 'fastify';

import { type ApiEnv } from '@exocortex/config';
import { createCorrelationId, type Logger } from '@exocortex/logger';

import { AppModule } from './app.module';
import { CORRELATION_HEADER, enterRequestContext } from './common/correlation';
import { API_ENV, LOGGER } from './common/logger.provider';

import 'reflect-metadata';

async function bootstrap(): Promise<void> {
  const adapter = new FastifyAdapter({
    // The API always runs behind nginx in this deployment.
    trustProxy: true,
    bodyLimit: 8 * 1024 * 1024,
    genReqId: () => crypto.randomUUID(),
  });

  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter, {
    // Nest's own logger is replaced by the structured pino logger.
    logger: ['error', 'warn'],
    bufferLogs: true,
  });

  const env = app.get<ApiEnv>(API_ENV);
  const logger = app.get<Logger>(LOGGER);

  const fastify = app.getHttpAdapter().getInstance() as FastifyInstance;

  // Correlation ids are assigned before anything else runs, so every log line
  // and every enqueued job of a request can be traced back to it.
  fastify.addHook('onRequest', (request, reply, done) => {
    const incoming = request.headers[CORRELATION_HEADER];
    const correlationId =
      typeof incoming === 'string' && incoming.length > 0 && incoming.length <= 100
        ? incoming
        : createCorrelationId();
    void reply.header(CORRELATION_HEADER, correlationId);
    enterRequestContext({ correlationId });
    done();
  });

  await fastify.register(fastifyHelmet, {
    contentSecurityPolicy: false, // The API serves JSON; the web app sets its own CSP.
    crossOriginResourcePolicy: { policy: 'same-site' },
  });
  await fastify.register(fastifyCookie);
  await fastify.register(fastifyMultipart, {
    limits: { fileSize: env.MAX_UPLOAD_BYTES, files: 1, fields: 5 },
  });

  // The browser talks to the API through the same origin in production; the
  // explicit allow list exists for local development on a separate port.
  app.enableCors({
    origin: [env.APP_URL, env.PUBLIC_API_URL],
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['content-type', 'x-correlation-id'],
  });

  app.enableShutdownHooks();

  const openApi = new DocumentBuilder()
    .setTitle('Exocortex API')
    .setDescription(
      'REST API of the Exocortex workspace. All error responses use the shared ' +
        'ApiErrorResponse shape: { code, message, details?, correlationId }.',
    )
    .setVersion('0.1.0')
    .addCookieAuth('exocortex.session_token')
    .build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, openApi), {
    jsonDocumentUrl: 'docs/openapi.json',
  });

  await app.listen({ port: env.API_PORT, host: '127.0.0.1' });
  logger.info('API listening', {
    port: env.API_PORT,
    environment: env.NODE_ENV,
    appUrl: env.APP_URL,
  });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info('Shutting down API', { signal });
    try {
      await app.close();
      process.exit(0);
    } catch (error) {
      logger.fatal('Graceful shutdown failed', error);
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

void bootstrap().catch((error: unknown) => {
  console.error('Failed to start the API:', error);
  process.exit(1);
});
