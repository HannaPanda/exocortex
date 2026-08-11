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
import { AuthService } from './auth/auth.service';
import { CORRELATION_HEADER, enterRequestContext } from './common/correlation';
import { API_ENV, LOGGER } from './common/logger.provider';

import 'reflect-metadata';

async function bootstrap(): Promise<void> {
  const adapter = new FastifyAdapter({
    // The API always runs behind exactly one reverse proxy (nginx on loopback),
    // so trust exactly one hop.
    //
    // `true` trusted the whole chain and took the *leftmost* `X-Forwarded-For`
    // entry as the client address. nginx builds that header with
    // `$proxy_add_x_forwarded_for`, which appends the real address to whatever
    // the caller sent -- so the leftmost entry is caller-controlled. Every
    // per-IP rate limit in Better Auth was therefore reset by sending a
    // different fake address, which is unlimited password guessing against
    // `/sign-in/email`. With one hop, the address is read from the right and
    // the fake prefix is ignored.
    trustProxy: 1,
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

  // CORS for the MCP endpoint, which needs different rules than the rest of
  // the API and must therefore be answered before the global CORS middleware
  // sees the request.
  //
  // `*` is safe here and nowhere else: `/api/mcp` refuses cookie sessions
  // outright and authenticates by bearer token only, so a cross-origin caller
  // has nothing ambient to ride on -- it must present a credential the user
  // handed it. `WWW-Authenticate` is exposed because that header is how a
  // client discovers the authorization server after a 401.
  fastify.addHook('onRequest', (request, reply, done) => {
    if (!request.url.startsWith('/api/mcp')) {
      done();
      return;
    }
    void reply.header('access-control-allow-origin', '*');
    void reply.header('access-control-allow-methods', 'GET, POST, DELETE, OPTIONS');
    void reply.header(
      'access-control-allow-headers',
      'authorization, content-type, mcp-protocol-version, mcp-session-id',
    );
    void reply.header('access-control-expose-headers', 'WWW-Authenticate, Mcp-Session-Id');
    void reply.header('access-control-max-age', '86400');
    if (request.method === 'OPTIONS') {
      void reply.status(204).send();
      return;
    }
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

  // Swagger is mounted straight onto Fastify, so none of Nest's guards see it:
  // `SessionGuard` never runs for /docs. Until now the HTTP basic auth in front
  // of the deployment was the only thing keeping the full API surface -- 57
  // paths, their payload shapes and their error codes -- from being world
  // readable, which makes removing that basic auth a bigger step than it looks.
  // This hook applies the same session check the rest of the API uses.
  const authService = app.get(AuthService);
  fastify.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/docs')) return;
    const headers = request.headers as Record<string, string | string[] | undefined>;
    const session = await authService.verifySession(headers);
    if (session !== null) return;
    void reply.code(401).send({
      code: 'unauthenticated',
      message: 'Sign in to read the API documentation',
      correlationId: reply.getHeader(CORRELATION_HEADER),
    });
  });

  const openApi = new DocumentBuilder()
    .setTitle('eXocortex API')
    .setDescription(
      'REST API of the eXocortex workspace. All error responses use the shared ' +
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
