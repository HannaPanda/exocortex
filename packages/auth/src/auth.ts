import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
// `better-auth/plugins/mcp` is built but not listed in the package's export
// map in 1.6.25; the barrel is the only importable path.
import { mcp } from 'better-auth/plugins';
import { type BetterAuthPlugin } from 'better-auth/types';

import { type PrismaClient } from '@exocortex/database';
import { type Logger } from '@exocortex/logger';

import { type Mailer } from './mailer';

export const AUTH_BASE_PATH = '/api/auth';

/** Where an unauthenticated OAuth authorization request sends the person. */
export const OAUTH_LOGIN_PATH = '/anmelden';
/** Where an authorization request that needs an explicit "yes" sends them. */
export const OAUTH_CONSENT_PATH = '/verbinden';

/**
 * How long an MCP access token lives, in seconds.
 *
 * Short, because these tokens are stored in the clear (the plugin looks a
 * token up by its own value) and because a remote connector refreshes without
 * bothering anyone. A person only notices this number if refreshing is broken.
 */
const MCP_ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
/** How long a connector may stay away before it has to ask a human again. */
const MCP_REFRESH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30;

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
 * OAuth 2.1 authorization server for remote MCP clients (ADR-018).
 *
 * ChatGPT cannot spawn the stdio MCP bin and offers no field for an API token,
 * so a connector authenticates by authorization code with PKCE and registers
 * itself dynamically. Everything this adds is scoped to `/api/auth/mcp/*` plus
 * the two `.well-known` documents; it issues no cookie session, and the tokens
 * it mints are only accepted by `/api/mcp`.
 *
 * `consentPage` is not decoration. Without it the plugin hands out an
 * authorization code the moment a signed-in browser reaches `/authorize`, and
 * since client registration is open to anyone, any website could redirect a
 * signed-in person and collect a working token. The consent screen is what
 * makes that a decision instead of a side effect. Better Auth only routes
 * there when the client asks with `prompt=consent`, so the API adds that
 * parameter itself before the plugin sees the request; see
 * `forceConsentPrompt` in `apps/api/src/auth/auth.service.ts`.
 *
 * The return type is widened to the base plugin interface on purpose. The
 * plugin's own type mentions `MCPOptions`, and better-auth 1.6.25 does not
 * list `./plugins/mcp` in its export map, so no declaration file that names
 * that type can be emitted (TS4058). Widening costs nothing here: the endpoints
 * it would otherwise add to `auth.api` are ones this codebase never calls.
 * Access tokens are verified directly against the `oauth_access_token` table by
 * `verifyMcpAccessToken`, the same way `SessionGuard` verifies an `exo_` token,
 * so the MCP endpoint does not depend on the plugin's typing at all. The value
 * handed to `betterAuth` is the whole plugin; only its type is narrowed.
 */
function createMcpPlugin(): BetterAuthPlugin {
  return mcp({
    loginPage: OAUTH_LOGIN_PATH,
    oidcConfig: {
      // Repeated from the option above: `oidcConfig` is the underlying OIDC
      // provider's own type and declares it required. The plugin overwrites it
      // with the outer `loginPage` either way.
      loginPage: OAUTH_LOGIN_PATH,
      consentPage: OAUTH_CONSENT_PATH,
      requirePKCE: true,
      allowPlainCodeChallengeMethod: false,
      accessTokenExpiresIn: MCP_ACCESS_TOKEN_TTL_SECONDS,
      refreshTokenExpiresIn: MCP_REFRESH_TOKEN_TTL_SECONDS,
    },
  });
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
    appName: 'eXocortex',
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
      // Deliberately `false`, and no longer for want of a working relay: mail
      // goes out through Brevo since 2026-08-09.
      //
      // Verification exists to stop someone registering with an address they do
      // not own, and `disableSignUp` above already makes that impossible --
      // every account is created by the seed script or by an administrator.
      // What turning it on would still do is lock out any account whose address
      // was never verified, and that currently includes the only administrator.
      // The cost is real and the remaining benefit is not, so it stays off until
      // there is a reason beyond tidiness.
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

    plugins: [createMcpPlugin()],

    databaseHooks: {
      session: {
        create: {
          /**
           * A disabled account gets no session (issue #3).
           *
           * This is the only place the check has to live. Disabling already
           * deletes every existing session and revokes every token, so the one
           * remaining way for a switched-off account to act is to make a *new*
           * session, and every path that does -- the sign-in form, the OAuth
           * authorization flow, auto-sign-in after verification -- goes through
           * this hook. That is why `SessionGuard` needs no per-request lookup:
           * the state cannot exist rather than being filtered out afterwards.
           *
           * Returning `false` fails the sign-in with Better Auth's generic
           * message. Deliberately not a distinct "this account is disabled":
           * the sign-in form is unauthenticated, and an error that tells apart
           * "wrong password" from "account exists but is off" tells anybody who
           * asks which addresses have accounts here.
           */
          before: async (session): Promise<boolean> => {
            const user = await prisma.user.findUnique({
              where: { id: session.userId },
              select: { disabledAt: true },
            });
            if (user !== null && user.disabledAt !== null) {
              logger.warn('Session creation refused for disabled account', {
                userId: session.userId,
              });
              return false;
            }
            return true;
          },
        },
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
