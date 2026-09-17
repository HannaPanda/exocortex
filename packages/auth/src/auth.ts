import { mcp } from '@better-auth/mcp';
import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { jwt } from 'better-auth/plugins';

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
 * Short, because an access token is now a signed JWT and nothing is asked of
 * the database when one is presented: the only thing that ends a token early
 * is its own expiry. A remote connector refreshes without bothering anyone, so
 * a person only notices this number if refreshing is broken.
 */
const MCP_ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
/** How long a connector may stay away before it has to ask a human again. */
const MCP_REFRESH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30;

/**
 * The OAuth 2.1 issuer identifier of this deployment.
 *
 * Better Auth derives it from its own base URL, and that URL carries the base
 * path, so the issuer is the application origin plus `/api/auth` rather than
 * the bare origin. The `iss` claim of every access token and the `issuer`
 * field of the authorization-server metadata both carry this exact string,
 * which is why `verifyMcpAccessToken` has to be able to build it too.
 */
export function authIssuer(appUrl: string): string {
  return `${appUrl.replace(/\/+$/, '')}${AUTH_BASE_PATH}`;
}

/**
 * The canonical protected-resource identifier (RFC 8707 / RFC 9728).
 *
 * `@better-auth/mcp` requires one and audience-binds every token it issues to
 * it. Naming the endpoint the token actually unlocks is both true and the
 * value an MCP client discovers at `/.well-known/oauth-protected-resource`, so
 * a token minted for this deployment cannot be replayed against another
 * resource and a token minted elsewhere cannot be replayed against this one.
 */
export function mcpResourceIdentifier(appUrl: string): string {
  return `${appUrl.replace(/\/+$/, '')}/api/mcp`;
}

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
 * itself dynamically. Everything this adds is scoped to `/api/auth/oauth2/*`
 * plus the discovery documents; it issues no cookie session, and the tokens it
 * mints are only accepted by `/api/mcp`.
 *
 * `consentPage` is not decoration. The provider asks for consent on its own
 * when it has no stored "yes" for a client, but a stored one would then let
 * every later authorization through silently, and since client registration is
 * open to anyone that is a decision worth repeating: the API adds
 * `prompt=consent` to every authorization request before the plugin sees it,
 * which is what makes the screen unconditional. See `forceConsentPrompt` in
 * `apps/api/src/auth/auth.service.ts`.
 *
 * Registration being explicitly opened is the other half of that trade.
 * `@better-auth/mcp` refuses dynamic registration unless asked, which is the
 * right default for a server that has a known set of clients; this one does
 * not, because the client it was built for registers itself seconds before it
 * asks for a token. The consent screen is the gate in front of it.
 *
 * The return type is inferred rather than widened to `BetterAuthPlugin`, which
 * is what 1.6 needed: better-auth did not list `./plugins/mcp` in its export
 * map, so no declaration file could name the plugin's own type (TS4058).
 * `@better-auth/mcp` is a package with an export map of its own, so the type
 * is nameable again. It is still never used: `verifyMcpAccessToken` verifies
 * an access token itself (ADR-018) rather than going through `auth.api`.
 */
function createMcpPlugin(appUrl: string) {
  return mcp({
    resource: mcpResourceIdentifier(appUrl),
    loginPage: OAUTH_LOGIN_PATH,
    consentPage: OAUTH_CONSENT_PATH,
    allowDynamicClientRegistration: true,
    allowUnauthenticatedClientRegistration: true,
    clientRegistrationRequirePKCE: true,
    accessTokenExpiresIn: MCP_ACCESS_TOKEN_TTL_SECONDS,
    refreshTokenExpiresIn: MCP_REFRESH_TOKEN_TTL_SECONDS,
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

    // `jwt` is not an optional companion: `@better-auth/mcp` signs its access
    // tokens with the key pair this plugin keeps in the `jwks` table and
    // refuses to start without it. It also publishes the public half at
    // `/api/auth/jwks`, which is how any other party could verify a token --
    // this one reads the same rows directly (`verifyMcpAccessToken`).
    plugins: [jwt(), createMcpPlugin(options.appUrl)],

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
export function toWebHeaders(source: Record<string, string | string[] | undefined>): Headers {
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
