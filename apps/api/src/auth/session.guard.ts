import {
  type CanActivate,
  createParamDecorator,
  type ExecutionContext,
  Inject,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { type FastifyRequest } from 'fastify';

import {
  API_TOKEN_PREFIX,
  hashApiToken,
  type PageScopeRestriction,
  readBearerToken,
  SERVICE_TOKEN_PREFIX,
  type VerifiedSession,
  verifyServiceToken,
} from '@exocortex/auth';
import { type ApiEnv } from '@exocortex/config';
import { type PrismaClient } from '@exocortex/database';
import { type Logger } from '@exocortex/logger';

import { AppError } from '../common/app-error';
import {
  clearAutomationOrigin,
  setPageScopeRestriction,
  setRequestAiRun,
  setRequestUser,
} from '../common/correlation';
import { isHttpContext } from '../common/http-context';
import { API_ENV, LOGGER } from '../common/logger.provider';
import { PRISMA } from '../platform/platform.module';

import {
  API_TOKEN_CREDENTIAL_SELECT,
  assertApiTokenUsable,
  pageScopesOf,
} from './api-token-credential';
import { AuthService } from './auth.service';

export const IS_PUBLIC_ROUTE = 'exocortex:isPublicRoute';

/** Marks a route as reachable without a session (health checks, auth routes). */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_ROUTE, true);

/** Which credential kind authenticated the current request. */
export type ExocortexCredential = 'session' | 'api_token' | 'service_token';

export interface AuthenticatedRequest extends FastifyRequest {
  exocortexSession?: VerifiedSession;
  /** The built-in AI service uses this to know whether tools are allowed. */
  exocortexCredential?: ExocortexCredential;
  /**
   * Scopes of the `exo_` token that authenticated this request, if any. A cookie
   * session and a service token carry the full authority of their user and set
   * nothing here; `TokenScopeGuard` only narrows persistent API tokens.
   */
  exocortexTokenScopes?: readonly string[];
  /**
   * The pages this credential is confined to, if any (issue #83, ADR-044).
   * Mirrored onto the request for the same reason as the scopes above: a guard
   * or an interceptor can read it without reaching into async storage.
   */
  exocortexPageScopes?: PageScopeRestriction;
  /**
   * The row of the `exo_` token behind this request, if one is. An upload
   * ticket (ADR-064) records it so redeeming the ticket can re-check that
   * token rather than trusting what it could do when the ticket was minted.
   */
  exocortexApiTokenId?: string;
}

/** A far-future expiry for tokens that never expire (`ApiToken.expiresAt === null`). */
const NEVER_EXPIRES = new Date('2999-01-01T00:00:00.000Z');

interface VerifiedBearer {
  session: VerifiedSession;
  credential: ExocortexCredential;
  /** Only set for `api_token`; see `AuthenticatedRequest.exocortexApiTokenId`. */
  apiTokenId?: string;
  /** Only set for `api_token`; see `AuthenticatedRequest.exocortexTokenScopes`. */
  scopes?: readonly string[];
  /** Only set for `api_token`; see `AuthenticatedRequest.exocortexPageScopes`. */
  pageScopes?: PageScopeRestriction;
  /** Only set for a service token minted for one AI run (issue #140). */
  aiRunId?: string;
}

/**
 * Global guard: every route requires a valid session unless explicitly marked
 * `@Public()`. Authorization (workspace membership, roles) is a separate layer
 * handled by the policies in `@exocortex/auth`.
 *
 * Accepts three credential kinds, resolved in this order:
 *  1. a Better Auth session cookie (humans, the web app)
 *  2. an `exos_`-prefixed HMAC service token (the worker's tool loop, D3)
 *  3. an `exo_`-prefixed persistent API token (external clients, MCP, D1)
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    private readonly authService: AuthService,
    private readonly reflector: Reflector,
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(API_ENV) private readonly env: ApiEnv,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_ROUTE, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic === true) return true;
    if (!isHttpContext(context)) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const headers = request.headers as Record<string, string | string[] | undefined>;

    const cookieSession = await this.authService.verifySession(headers);
    if (cookieSession !== null) {
      if (cookieSession.expiresAt.getTime() <= Date.now()) {
        throw new AppError('session_expired', 'The session has expired');
      }
      request.exocortexSession = cookieSession;
      request.exocortexCredential = 'session';
      setRequestUser(cookieSession.userId);
      clearAutomationOrigin();
      setRequestAiRun(undefined);
      // A browser session is the person themselves and is never confined to a
      // branch. Said explicitly rather than left alone, so a reused context
      // object cannot carry a previous request's confinement.
      setPageScopeRestriction(null);
      return true;
    }

    const bearer = readBearerToken(headers);
    if (bearer === null) {
      throw AppError.unauthenticated('No valid session cookie was provided');
    }

    const { session, credential, scopes, pageScopes, apiTokenId, aiRunId } =
      await this.verifyBearerToken(bearer);
    request.exocortexSession = session;
    request.exocortexCredential = credential;
    request.exocortexApiTokenId = apiTokenId;
    request.exocortexTokenScopes = scopes;
    request.exocortexPageScopes = pageScopes;
    setRequestUser(session.userId);
    setPageScopeRestriction(pageScopes ?? null);
    // Set for every bearer, `undefined` included, so a reused context cannot
    // lend one request's run to the next (issue #140).
    setRequestAiRun(aiRunId);
    // The automation origin header is read before authentication runs, because
    // that is where the request context is built. Only the worker may assert
    // it, and a service token is the only way the worker speaks to this API
    // (issue #50, ADR-024) -- so for everybody else it is forgotten here.
    if (credential !== 'service_token') clearAutomationOrigin();
    return true;
  }

  private async verifyBearerToken(token: string): Promise<VerifiedBearer> {
    if (token.startsWith(SERVICE_TOKEN_PREFIX)) {
      return this.verifyServiceBearerToken(token);
    }
    if (token.startsWith(API_TOKEN_PREFIX)) {
      return this.verifyApiBearerToken(token);
    }
    throw new AppError('api_token_invalid', 'Unrecognized bearer token format');
  }

  private async verifyServiceBearerToken(token: string): Promise<VerifiedBearer> {
    if (this.env.SERVICE_TOKEN_SECRET === undefined) {
      throw new AppError('api_token_invalid', 'Service tokens are not configured');
    }

    const result = verifyServiceToken({
      secret: this.env.SERVICE_TOKEN_SECRET,
      token,
      // The API accepts the worker's tool-loop tokens and the ones its own
      // MCP endpoint mints for an OAuth-authenticated client; a
      // `collaboration-write` token is for the Hocuspocus process alone.
      expectedPurpose: ['ai-tools', 'mcp-tools'],
    });
    if (!result.valid) {
      if (result.reason === 'expired') {
        throw new AppError('api_token_expired', 'The service token has expired');
      }
      throw new AppError('api_token_invalid', 'The service token is invalid');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: result.claims.userId },
      select: { id: true, email: true, name: true, emailVerified: true, disabledAt: true },
    });
    if (user === null) {
      throw new AppError('api_token_invalid', 'The service token references an unknown user');
    }
    // A service token is HMAC-signed and therefore not revocable, so unlike a
    // session or an `exo_` token it cannot be taken away when the account is
    // switched off -- it has to be refused on use. The lookup was happening
    // anyway, so this costs one more selected column.
    if (user.disabledAt !== null) {
      throw new AppError('user_disabled', 'This account is disabled');
    }

    return {
      session: {
        userId: user.id,
        sessionId: `service:${result.claims.purpose}`,
        email: user.email,
        name: user.name,
        emailVerified: user.emailVerified,
        expiresAt: new Date(result.claims.expiresAt),
      },
      credential: 'service_token',
      ...(result.claims.runId === undefined ? {} : { aiRunId: result.claims.runId }),
    };
  }

  private async verifyApiBearerToken(token: string): Promise<VerifiedBearer> {
    const apiToken = await this.prisma.apiToken.findUnique({
      where: { tokenHash: hashApiToken(token) },
      select: API_TOKEN_CREDENTIAL_SELECT,
    });
    if (apiToken === null) {
      throw new AppError('api_token_invalid', 'Unknown API token');
    }
    assertApiTokenUsable(apiToken);

    // Token auth stays a single indexed read on the hot path: the timestamp
    // update happens in the background and a failure here never fails the request.
    void this.prisma.apiToken
      .update({ where: { id: apiToken.id }, data: { lastUsedAt: new Date() } })
      .catch((error: unknown) => {
        this.logger.warn('Failed to update API token lastUsedAt', {
          apiTokenId: apiToken.id,
          reason: error instanceof Error ? error.message : String(error),
        });
      });

    return {
      session: {
        userId: apiToken.user.id,
        sessionId: `token:${apiToken.id}`,
        email: apiToken.user.email,
        name: apiToken.user.name,
        emailVerified: apiToken.user.emailVerified,
        expiresAt: apiToken.expiresAt ?? NEVER_EXPIRES,
      },
      credential: 'api_token',
      apiTokenId: apiToken.id,
      scopes: apiToken.scopes,
      pageScopes: pageScopesOf(apiToken),
    };
  }
}

/** Injects the verified session into a controller method. */
export const CurrentSession = createParamDecorator(
  (_data: unknown, context: ExecutionContext): VerifiedSession => {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (request.exocortexSession === undefined) {
      throw AppError.unauthenticated('Route is not protected by SessionGuard');
    }
    return request.exocortexSession;
  },
);
