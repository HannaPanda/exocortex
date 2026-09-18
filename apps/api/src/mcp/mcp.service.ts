import { Inject, Injectable } from '@nestjs/common';

import {
  API_TOKEN_PREFIX,
  hashApiToken,
  issueServiceToken,
  readBearerToken,
  tokenHasScope,
  type VerifiedSession,
  verifyMcpAccessToken,
} from '@exocortex/auth';
import { type ApiEnv } from '@exocortex/config';
import { type PrismaClient } from '@exocortex/database';
import { type Logger } from '@exocortex/logger';
import {
  createFetchApiClient,
  createMcpRequestHandler,
  type McpRequestHandler,
  toolsFor,
  type ToolSurface,
  WriteConfirmationGate,
} from '@exocortex/mcp-tools';

import { AppError } from '../common/app-error';
import { API_ENV, LOGGER } from '../common/logger.provider';
import { PRISMA } from '../platform/platform.module';
import { SettingsService } from '../platform/settings.service';

import { McpStreamsService } from './mcp-streams.service';

/** How long the loopback credential minted for an OAuth client stays valid. */
const LOOPBACK_TOKEN_TTL_SECONDS = 120;

/** Which credential authenticated an MCP connection. */
export type McpCredentialKind = 'api_token' | 'oauth';

export interface McpCaller {
  session: VerifiedSession;
  kind: McpCredentialKind;
  /**
   * Bearer credential the tool catalogue uses for its calls back into the REST
   * API. For an `exo_` token this is that same token, unchanged, so
   * `TokenScopeGuard` narrows the tool's effect exactly as it narrows a direct
   * call. An OAuth client holds no such token, so it gets a short-lived
   * service token instead and its limit is the tool list it was served.
   */
  loopbackToken: string;
  /** For logs: the OAuth client, or the API token's id. */
  credentialId: string;
}

/**
 * Everything behind `POST /api/mcp`.
 *
 * The endpoint exists because the stdio bin in `apps/mcp` requires a client
 * that can start a subprocess, and the two clients this was built for cannot:
 * ChatGPT talks HTTP to a URL, and an agent on someone else's machine has no
 * business having a shell on this one. Both now speak the same protocol to the
 * same catalogue.
 *
 * Tools reach the domain through the REST API and nothing else (ADR-014), so
 * this service calls back into its own process over loopback HTTP rather than
 * touching Prisma. That is one extra hop per tool call, and it buys the
 * guarantee that a tool cannot skip a policy check: every workspace membership
 * test, every validation and every audit entry happens exactly as it does for a
 * browser request, because it *is* the same request.
 */
@Injectable()
export class McpService {
  /**
   * One gate for the whole deployment, keyed per user (see `principal`).
   * It has to be shared: HTTP is stateless, so the announcement and the
   * confirmation of a write arrive as two unrelated requests, and a gate built
   * per request would confirm everything on the first try.
   */
  private readonly gate = new WriteConfirmationGate();

  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(API_ENV) private readonly env: ApiEnv,
    @Inject(LOGGER) private readonly logger: Logger,
    private readonly settings: SettingsService,
    private readonly streams: McpStreamsService,
  ) {}

  /**
   * Resolves the bearer credential on an MCP request.
   *
   * Cookie sessions are deliberately not accepted. A cookie travels with any
   * request the browser is talked into making, so accepting one here would
   * make every mutating tool reachable by cross-site request forgery from a
   * page a signed-in person happens to open. A bearer token has to be handed
   * over on purpose.
   */
  async authenticate(headers: Record<string, string | string[] | undefined>): Promise<McpCaller> {
    const bearer = readBearerToken(headers);
    if (bearer === null) {
      throw AppError.unauthenticated('MCP requires a bearer token');
    }

    if (bearer.startsWith(API_TOKEN_PREFIX)) {
      return this.authenticateApiToken(bearer);
    }
    return this.authenticateOAuthToken(bearer);
  }

  private async authenticateApiToken(token: string): Promise<McpCaller> {
    const apiToken = await this.prisma.apiToken.findUnique({
      where: { tokenHash: hashApiToken(token) },
      select: {
        id: true,
        scopes: true,
        expiresAt: true,
        revokedAt: true,
        user: { select: { id: true, email: true, name: true, emailVerified: true } },
      },
    });
    if (apiToken === null) {
      throw new AppError('api_token_invalid', 'Unknown API token');
    }
    if (apiToken.revokedAt !== null) {
      throw new AppError('api_token_invalid', 'The API token has been revoked');
    }
    if (apiToken.expiresAt !== null && apiToken.expiresAt.getTime() <= Date.now()) {
      throw new AppError('api_token_expired', 'The API token has expired');
    }
    // A token that may not even read is refused at the door rather than being
    // let in to a catalogue where every single tool then fails.
    if (!tokenHasScope(apiToken.scopes, 'read')) {
      throw new AppError(
        'api_token_insufficient_scope',
        "This API token does not carry the 'read' scope",
      );
    }

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
        expiresAt: apiToken.expiresAt ?? new Date('2999-01-01T00:00:00.000Z'),
      },
      kind: 'api_token',
      loopbackToken: token,
      credentialId: apiToken.id,
    };
  }

  private async authenticateOAuthToken(token: string): Promise<McpCaller> {
    const result = await verifyMcpAccessToken({
      prisma: this.prisma,
      accessToken: token,
      appUrl: this.env.APP_URL,
    });
    if (!result.valid) {
      if (result.reason === 'expired') {
        throw new AppError('api_token_expired', 'The access token has expired');
      }
      throw new AppError('api_token_invalid', 'The access token is not valid');
    }

    if (this.env.SERVICE_TOKEN_SECRET === undefined) {
      // Without the secret there is no way to authenticate the loopback call,
      // and quietly reaching for a different credential would hand the client
      // more authority than it was granted. Better to say so.
      this.logger.error(
        'An OAuth MCP client authenticated but SERVICE_TOKEN_SECRET is not configured',
        { clientId: result.token.clientId },
      );
      throw AppError.internal('MCP over OAuth is not configured on this deployment');
    }

    const loopback = issueServiceToken({
      secret: this.env.SERVICE_TOKEN_SECRET,
      userId: result.token.session.userId,
      purpose: 'mcp-tools',
      ttlSeconds: LOOPBACK_TOKEN_TTL_SECONDS,
    });

    return {
      session: result.token.session,
      kind: 'oauth',
      loopbackToken: loopback.token,
      credentialId: result.token.clientId,
    };
  }

  /**
   * Builds the JSON-RPC handler for one connection.
   *
   * The tool list is fixed here and the handler resolves `tools/call` against
   * that same list, so a connection to the research endpoint cannot reach a
   * writing tool by naming it.
   *
   * `agentSessionId` is the client's `Mcp-Session-Id`, which is what makes the
   * write journal group by connection rather than by request.
   */
  async createHandler(
    caller: McpCaller,
    surface: ToolSurface,
    agentSessionId: string,
  ): Promise<McpRequestHandler> {
    const client = createFetchApiClient({
      // Loopback, not the public origin: this call must not leave the machine,
      // must not depend on nginx being up, and must not be counted as external
      // traffic. It is the same process answering its own request.
      baseUrl: `http://127.0.0.1:${String(this.env.API_PORT)}`,
      token: caller.loopbackToken,
      appUrl: this.env.APP_URL,
    });

    return createMcpRequestHandler({
      client,
      tools: toolsFor(surface),
      // What groups this connection's writes (ADR-022). It holds no state
      // here: the id is stamped on the loopback calls and recorded in the
      // journal, so a second API process serves the same client unchanged.
      agentSession: { externalId: agentSessionId, transport: 'http' },
      // Resources and prompts only on the full surface. The research and
      // memory endpoints exist because a narrow catalogue is used better than
      // a wide one; handing them an attach menu of every recent page would
      // give back exactly the breadth they were carved out to avoid.
      context: surface === 'mcp',
      // And with them the third part, `resources/subscribe` (issue #48). The
      // set lives in `McpStreamsService` rather than here, because this
      // handler is built per request and a subscription has to outlive one.
      subscriptions:
        surface === 'mcp'
          ? this.streams.subscriptionsFor(caller.session.userId, agentSessionId)
          : undefined,
      gate: this.gate,
      // `mcp.writeConfirmationRequired` widens the gate to every write. It was
      // written, shown in the admin area and documented, and then read by
      // nobody: the gate ran unconditionally regardless of the switch.
      confirm: (await this.settings.getKey('mcp.writeConfirmationRequired'))
        ? 'all'
        : 'irreversible',
      principal: caller.session.userId,
      logger: this.logger,
    });
  }

  /**
   * The client behind a consent prompt, as it described itself when it
   * registered. Nothing here is verified and nothing here should be trusted;
   * it is shown so a person can recognise the connector they just set up, or
   * fail to recognise one they did not.
   */
  async describeClient(clientId: string): Promise<{
    clientId: string;
    name: string;
    redirectUrls: string[];
    disabled: boolean;
    registeredAt: string;
  }> {
    const client = await this.prisma.oauthClient.findUnique({
      where: { clientId },
      select: { clientId: true, name: true, redirectUris: true, disabled: true, createdAt: true },
    });
    if (client === null) {
      throw AppError.notFound('The OAuth client');
    }
    return {
      // `name` is optional in RFC 7591, so a client that registered without one
      // is shown by its identifier rather than by an empty quotation mark.
      clientId: client.clientId,
      name: client.name ?? client.clientId,
      redirectUrls: client.redirectUris,
      disabled: client.disabled ?? false,
      registeredAt: (client.createdAt ?? new Date()).toISOString(),
    };
  }
}
