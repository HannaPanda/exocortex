import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';

import { type PrismaClient } from '@exocortex/database';
import { type Logger } from '@exocortex/logger';

import { type Mailer } from './mailer';

export const AUTH_BASE_PATH = '/api/auth';

export interface CreateAuthOptions {
  prisma: PrismaClient;
  /** Signing secret; validated to be >= 32 characters by @exocortex/config. */
  secret: string;
  /** Public origin of the application, e.g. https://exocortex.app */
  appUrl: string;
  mailer: Mailer;
  logger: Logger;
  /** Additional origins allowed to send credentialed requests. */
  trustedOrigins?: string[];
  secureCookies: boolean;
}

/**
 * Builds the shared Better Auth instance.
 *
 * The instance is created by the NestJS API only. The Next.js frontend talks to
 * it through `/api/auth/*` and never imports server-side auth internals.
 *
 * CSRF: Better Auth validates the request `Origin` header against `baseURL` and
 * `trustedOrigins` for every state-changing request, and all session cookies are
 * `httpOnly` + `sameSite=lax`. See docs/security.md.
 */
export function createAuth(options: CreateAuthOptions) {
  const { prisma, mailer, logger } = options;

  return betterAuth({
    appName: 'Exocortex',
    secret: options.secret,
    baseURL: options.appUrl,
    basePath: AUTH_BASE_PATH,
    trustedOrigins: [options.appUrl, ...(options.trustedOrigins ?? [])],
    database: prismaAdapter(prisma, { provider: 'postgresql' }),

    emailAndPassword: {
      enabled: true,
      minPasswordLength: 12,
      maxPasswordLength: 256,
      // Self-registration is closed. The deployment is a private workspace for a
      // handful of known people, so an open `/sign-up/email` only ever adds
      // accounts nobody asked for -- and every one of them can send a
      // verification mail through our SMTP credentials. Accounts are created by
      // the seed script or by an administrator; see docs/security.md.
      disableSignUp: true,
      // Deliberately still `false`. Turning this on would lock out every account
      // whose address was never verified, and outbound mail does not work in
      // this deployment yet (SMTP points at Mailpit, so nothing leaves the
      // host). Flip it together with real SMTP, not before.
      requireEmailVerification: false,
      sendResetPassword: async ({ user, url }) => {
        await mailer.sendPasswordResetEmail({ to: user.email, name: user.name, url });
      },
    },

    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: true,
      sendVerificationEmail: async ({ user, url }) => {
        await mailer.sendVerificationEmail({ to: user.email, name: user.name, url });
      },
    },

    /**
     * Explicit rate-limit policy instead of relying on library defaults.
     *
     * The limits are per client IP (nginx forwards the real address through
     * `X-Forwarded-For` and Fastify is configured with `trustProxy`). They are
     * strict enough to blunt credential stuffing while leaving room for a person
     * mistyping a password a few times. See docs/security.md.
     */
    rateLimit: {
      enabled: true,
      window: 60,
      max: 100,
      customRules: {
        '/sign-in/email': { window: 60, max: 10 },
        '/sign-up/email': { window: 60, max: 5 },
        '/request-password-reset': { window: 300, max: 5 },
        '/reset-password': { window: 300, max: 5 },
      },
    },

    session: {
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
      cookieCache: { enabled: true, maxAge: 60 },
    },

    advanced: {
      cookiePrefix: 'exocortex',
      useSecureCookies: options.secureCookies,
      defaultCookieAttributes: {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
      },
    },

    onAPIError: {
      onError: (error) => {
        logger.warn('Better Auth request failed', {
          reason: error instanceof Error ? error.message : String(error),
        });
      },
    },
  });
}

export type ExocortexAuth = ReturnType<typeof createAuth>;

export interface VerifiedSession {
  userId: string;
  sessionId: string;
  email: string;
  name: string;
  emailVerified: boolean;
  expiresAt: Date;
}

/**
 * Verifies a session from raw request headers. This is the single entry point
 * used by the NestJS guards and by the WebSocket handshake, so HTTP and
 * WebSocket authentication can never diverge.
 */
export async function verifySessionFromHeaders(
  auth: ExocortexAuth,
  headers: Headers,
): Promise<VerifiedSession | null> {
  const result = await auth.api.getSession({ headers });
  if (result === null || result.session === undefined) return null;
  return {
    userId: result.user.id,
    sessionId: result.session.id,
    email: result.user.email,
    name: result.user.name,
    emailVerified: result.user.emailVerified,
    expiresAt: new Date(result.session.expiresAt),
  };
}

/** Builds a `Headers` object from a Node-style header record. */
export function toWebHeaders(
  source: Record<string, string | string[] | undefined>,
): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else {
      headers.set(key, value);
    }
  }
  return headers;
}
