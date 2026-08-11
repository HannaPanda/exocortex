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

/** The `mcp` plugin's authorization endpoint, relative to the app origin. */
const MCP_AUTHORIZE_PATH = `${AUTH_BASE_PATH}/mcp/authorize`;

/**
 * Makes the consent screen unconditional on the OAuth authorization endpoint.
 *
 * Better Auth only routes to `consentPage` when the *client* asks for it with
 * `prompt=consent`. That puts the decision to ask a human in the hands of the
 * party that wants the token, and since dynamic client registration is open,
 * that party can be anyone: a website could redirect a signed-in person to
 * `/authorize` with a client it registered seconds earlier and receive a
 * working access token without a single visible step. Adding the prompt here
 * takes the choice back. The rewritten query is also what gets stored in the
 * login-prompt cookie, so it survives the detour through the sign-in page.
 */
/**
 * Serializes an already-parsed body back into the wire format its own
 * `Content-Type` announced. Anything that is not form-encoded becomes JSON,
 * which is what every other Better Auth route sends.
 */
export function encodeBody(body: unknown, contentType: string | null): string {
  if (typeof body === 'string') return body;
  if (contentType !== null && contentType.includes('application/x-www-form-urlencoded')) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
      // A repeated field parses into an array; each value has to go back on
      // the wire separately, or the receiver reads one field named `a,b`.
      if (Array.isArray(value)) {
        for (const item of value) params.append(key, String(item));
      } else if (value !== undefined && value !== null) {
        params.append(key, String(value));
      }
    }
    return params.toString();
  }
  return JSON.stringify(body);
}

export function forceConsentPrompt(url: URL): void {
  if (url.pathname !== MCP_AUTHORIZE_PATH) return;
  const prompt = url.searchParams.get('prompt');
  const values = new Set(prompt === null ? [] : prompt.split(' ').filter((value) => value !== ''));
  if (values.has('consent')) return;
  values.add('consent');
  url.searchParams.set('prompt', [...values].join(' '));
}

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
   * it. Fastify has already parsed the body, so it is re-serialized here in the
   * shape the incoming `Content-Type` promised.
   *
   * The form-encoded branch is not hypothetical: the OAuth token endpoint
   * (`/api/auth/mcp/token`) is posted form-encoded by every OAuth client there
   * is, Nest's Fastify adapter parses that into a plain object, and handing
   * Better Auth a JSON string under a form content type would fail in the one
   * exchange the whole connector flow depends on.
   */
  async handleAuthRequest(request: FastifyRequest): Promise<Response> {
    const url = new URL(request.url, this.env.APP_URL);
    forceConsentPrompt(url);
    const headers = toWebHeaders(request.headers as Record<string, string | string[] | undefined>);
    // The proxy hostname must not leak into redirect URLs.
    headers.set('host', new URL(this.env.APP_URL).host);

    const method = request.method.toUpperCase();
    const hasBody = method !== 'GET' && method !== 'HEAD';
    let body: string | undefined;
    if (hasBody && request.body !== undefined && request.body !== null) {
      body = encodeBody(request.body, headers.get('content-type'));
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
