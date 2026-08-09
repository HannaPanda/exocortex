import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { type FastifyRequest } from 'fastify';

import {
  AUTH_BASE_PATH,
  createAuth,
  createMailer,
  type ExocortexAuth,
  type Mailer,
  toWebHeaders,
  type VerifiedSession,
  verifySessionFromHeaders,
} from '@exocortex/auth';
import { type ApiEnv } from '@exocortex/config';
import { type PrismaClient } from '@exocortex/database';
import { type Logger } from '@exocortex/logger';

import { API_ENV, LOGGER } from '../common/logger.provider';
import { PRISMA } from '../platform/platform.module';

/**
 * Owns the Better Auth instance.
 *
 * The API is the only process that constructs it. Session verification for HTTP
 * requests and for WebSocket handshakes both go through `verifySession`, so the
 * two transports can never diverge.
 */
@Injectable()
export class AuthService implements OnApplicationShutdown {
  public readonly auth: ExocortexAuth;
  private readonly mailer: Mailer;

  constructor(
    @Inject(PRISMA) prisma: PrismaClient,
    @Inject(API_ENV) private readonly env: ApiEnv,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {
    this.mailer = createMailer({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      from: env.SMTP_FROM,
      user: env.SMTP_USER,
      password: env.SMTP_PASSWORD,
      logger,
    });

    this.auth = createAuth({
      prisma,
      secret: env.BETTER_AUTH_SECRET,
      appUrl: env.APP_URL,
      mailer: this.mailer,
      logger,
      secureCookies: env.APP_URL.startsWith('https://'),
      trustedOrigins: [env.BETTER_AUTH_URL, env.PUBLIC_API_URL],
    });
  }

  get basePath(): string {
    return AUTH_BASE_PATH;
  }

  /** Verifies a session from raw Node headers. */
  async verifySession(
    headers: Record<string, string | string[] | undefined>,
  ): Promise<VerifiedSession | null> {
    try {
      return await verifySessionFromHeaders(this.auth, toWebHeaders(headers));
    } catch (error) {
      this.logger.warn('Session verification failed', {
        reason: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Converts a Fastify request into a Web `Request` and lets Better Auth handle
   * it. Fastify has already parsed the JSON body, so it is re-serialized here;
   * Better Auth only ever receives JSON or form bodies on these routes.
   */
  async handleAuthRequest(request: FastifyRequest): Promise<Response> {
    const url = new URL(request.url, this.env.APP_URL);
    const headers = toWebHeaders(request.headers as Record<string, string | string[] | undefined>);
    // The proxy hostname must not leak into redirect URLs.
    headers.set('host', new URL(this.env.APP_URL).host);

    const method = request.method.toUpperCase();
    const hasBody = method !== 'GET' && method !== 'HEAD';
    let body: string | undefined;
    if (hasBody && request.body !== undefined && request.body !== null) {
      body = typeof request.body === 'string' ? request.body : JSON.stringify(request.body);
      if (!headers.has('content-type')) headers.set('content-type', 'application/json');
    }

    return this.auth.handler(
      new Request(url.toString(), {
        method,
        headers,
        ...(body === undefined ? {} : { body }),
      }),
    );
  }

  async onApplicationShutdown(): Promise<void> {
    await this.mailer.close();
  }
}
