import { randomUUID } from 'node:crypto';

import { Controller, Delete, Get, Inject, Param, Post, Req, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { type FastifyReply, type FastifyRequest } from 'fastify';

import { type ApiEnv } from '@exocortex/config';
import { agentSessionExternalIdSchema } from '@exocortex/contracts';
import { type Logger } from '@exocortex/logger';
import {
  JSON_RPC_ERROR_CODES,
  type JsonRpcRequest,
  type JsonRpcResponse,
  LATEST_PROTOCOL_VERSION,
  type McpRequestHandler,
  type ToolSurface,
} from '@exocortex/mcp-tools';

import { Public } from '../auth/session.guard';
import { AppError } from '../common/app-error';
import { API_ENV, LOGGER } from '../common/logger.provider';

import { type McpCaller, McpService } from './mcp.service';
import { McpStreamsService } from './mcp-streams.service';

/**
 * MCP over Streamable HTTP.
 *
 * One POST carries one JSON-RPC message (or, for the older protocol revision,
 * a batch of them) and the response comes straight back as JSON. A POST is
 * still never answered with a stream: nothing this server does mid-call
 * needs one.
 *
 * `GET` is the standalone SSE channel of the specification, and since issue #48
 * it opens one instead of refusing: `resources/subscribe` promises messages
 * that arrive long after the call that asked for them, and this is where they
 * travel. The two narrow surfaces serve no resources and so still refuse.
 *
 * An `Mcp-Session-Id` names the connection in the write journal (ADR-022), and
 * since #48 it also keys that connection's subscriptions in this process's
 * memory. That is the one thing a second API process would not share; the
 * consequence is bounded and visible, because a client whose POSTs land on the
 * other process finds its stream quiet and reconnects. A client that does not
 * echo the id back loses the grouping and the subscriptions and keeps
 * everything else -- each write is then its own one-line session.
 *
 * Routes are `@Public()` so `SessionGuard` steps aside. That is not an
 * exemption from authentication: `McpService.authenticate` runs on every
 * request and is stricter than the guard, because it refuses cookie sessions.
 */
@ApiExcludeController()
@Controller('api/mcp')
export class McpController {
  constructor(
    private readonly mcp: McpService,
    private readonly streams: McpStreamsService,
    @Inject(API_ENV) private readonly env: ApiEnv,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  @Public()
  @Post()
  async handleFull(@Req() request: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    await this.handle(request, reply, 'mcp');
  }

  /**
   * The two-tool surface for ChatGPT's deep research connector. A separate URL
   * rather than a negotiated capability, because the choice belongs to whoever
   * configures the connector: the full catalogue is far more than deep research
   * can use well, and deep research needs two names the full catalogue must not
   * carry.
   */
  @Public()
  @Post('research')
  async handleResearch(@Req() request: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    await this.handle(request, reply, 'research');
  }

  /**
   * The three-tool memory surface (issue #34): `recall`, `remember`, `fetch`.
   *
   * Its own URL for the same reason the research one has its own: which
   * catalogue a client should see is a decision belonging to whoever configures
   * it, not something to negotiate at runtime. A chat client handed the full
   * forty-six tools reaches for the wrong one; handed three, it uses the
   * memory it is connected to.
   */
  @Public()
  @Post('memory')
  async handleMemory(@Req() request: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    await this.handle(request, reply, 'memory');
  }

  /**
   * What the consent page shows about the client asking for access.
   *
   * Not `@Public()`: only a signed-in person is answering a consent prompt, so
   * only a signed-in person needs this. Everything it returns was written by
   * the client itself during dynamic registration, which is exactly why a human
   * gets to look at it before saying yes.
   */
  @Get('clients/:clientId')
  async describeClient(@Param('clientId') clientId: string): Promise<{
    clientId: string;
    name: string;
    redirectUrls: string[];
    disabled: boolean;
    registeredAt: string;
  }> {
    return this.mcp.describeClient(clientId);
  }

  /**
   * The Streamable HTTP channel this connection's notifications travel on
   * (issue #48, ADR-035).
   *
   * Only the full surface opens one: it is the only surface that serves
   * resources at all, so it is the only one with anything to notify about.
   * A client that opens it without ever subscribing gets a quiet socket with a
   * heartbeat, which is exactly what the specification describes.
   */
  @Public()
  @Get()
  async openStream(@Req() request: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    const headers = request.headers as Record<string, string | string[] | undefined>;
    if (!acceptsEventStream(headers.accept)) {
      this.refuseStream(reply);
      return;
    }

    let caller: McpCaller;
    try {
      caller = await this.mcp.authenticate(headers);
    } catch (error) {
      this.unauthorized(reply, error);
      return;
    }

    const opened = this.streams.openSessionStream({
      userId: caller.session.userId,
      sessionId: agentSessionId(headers['mcp-session-id']),
      reply,
    });
    if (!opened) this.tooManyStreams(reply);
  }

  /**
   * The change feed a stdio MCP server listens on.
   *
   * Its own endpoint rather than the session stream above, because the
   * subprocess is not an MCP client here: it holds the subscriptions itself
   * and needs the raw facts, not notifications addressed to a session this
   * process knows nothing about.
   */
  @Public()
  @Get('changes')
  async openChangeFeed(@Req() request: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    const headers = request.headers as Record<string, string | string[] | undefined>;

    let caller: McpCaller;
    try {
      caller = await this.mcp.authenticate(headers);
    } catch (error) {
      this.unauthorized(reply, error);
      return;
    }

    const opened = this.streams.openChangeFeed({ userId: caller.session.userId, reply });
    if (!opened) this.tooManyStreams(reply);
  }

  @Public()
  @Get('research')
  openResearchStream(@Res() reply: FastifyReply): void {
    this.refuseStream(reply);
  }

  @Public()
  @Get('memory')
  openMemoryStream(@Res() reply: FastifyReply): void {
    this.refuseStream(reply);
  }

  /**
   * Ending a session. There is none to end, but a client that reaches for this
   * on shutdown deserves a plain "fine" rather than a 404 it has to interpret.
   */
  @Public()
  @Delete()
  endSession(@Res() reply: FastifyReply): void {
    void reply.status(204).send();
  }

  @Public()
  @Delete('research')
  endResearchSession(@Res() reply: FastifyReply): void {
    void reply.status(204).send();
  }

  @Public()
  @Delete('memory')
  endMemorySession(@Res() reply: FastifyReply): void {
    void reply.status(204).send();
  }

  private refuseStream(reply: FastifyReply): void {
    void reply.status(405).header('allow', 'POST, DELETE').send({
      code: 'validation_failed',
      message:
        'This MCP endpoint answers POST only. It serves no resources, so there is nothing to notify about.',
    });
  }

  /**
   * A refusal rather than a ninth socket. Held connections are the one thing
   * this endpoint cannot shed under load, so the limit is per account and the
   * message says so: a client that leaks streams should find out from the
   * answer, not from an operator reading a connection count.
   */
  private tooManyStreams(reply: FastifyReply): void {
    void reply.status(429).send({
      code: 'rate_limited',
      message: 'This account already holds the maximum number of open MCP streams.',
    });
  }

  private async handle(
    request: FastifyRequest,
    reply: FastifyReply,
    surface: ToolSurface,
  ): Promise<void> {
    const headers = request.headers as Record<string, string | string[] | undefined>;

    let caller: McpCaller;
    try {
      caller = await this.mcp.authenticate(headers);
    } catch (error) {
      this.unauthorized(reply, error);
      return;
    }

    const sessionId = agentSessionId(headers['mcp-session-id']);
    const messages = toMessages(request.body);
    if (messages === null) {
      void reply.status(400).send({
        jsonrpc: '2.0',
        id: null,
        error: { code: JSON_RPC_ERROR_CODES.invalidRequest, message: 'Invalid Request' },
      });
      return;
    }

    const handler = await this.mcp.createHandler(caller, surface, sessionId);
    const responses: JsonRpcResponse[] = [];
    for (const message of messages) {
      const response = await this.dispatch(handler, message, caller, surface);
      if (response !== null) responses.push(response);
    }

    // Only notifications: nothing to answer, and the specification asks for
    // 202 rather than an empty 200 so the client can tell the difference.
    if (responses.length === 0) {
      void reply.status(202).send();
      return;
    }

    void reply
      .status(200)
      .header('content-type', 'application/json')
      .header('mcp-protocol-version', LATEST_PROTOCOL_VERSION)
      // The specification has the client read this off the initialize response
      // and repeat it. Sent on every response rather than only that one, so a
      // client that reconnects mid-conversation still finds an id to keep.
      .header('mcp-session-id', sessionId)
      .send(Array.isArray(request.body) ? responses : responses[0]);
  }

  /**
   * Runs one message and turns an unexpected throw into a JSON-RPC error.
   *
   * A tool that fails is not an exception here: the handler already reports
   * API errors and validation failures as tool results, because a model has to
   * be able to read them and try something else. What reaches this catch is a
   * genuine defect, and it must not take down the whole request.
   */
  private async dispatch(
    handler: McpRequestHandler,
    message: JsonRpcRequest,
    caller: McpCaller,
    surface: ToolSurface,
  ): Promise<JsonRpcResponse | null> {
    const toolName =
      message.method === 'tools/call' &&
      isRecord(message.params) &&
      typeof message.params.name === 'string'
        ? message.params.name
        : undefined;

    // One line per call, so "two agents wrote from two systems" is a question
    // the log can answer.
    this.logger.info('MCP request', {
      method: message.method,
      surface,
      credential: caller.kind,
      credentialId: caller.credentialId,
      userId: caller.session.userId,
      ...(toolName === undefined ? {} : { tool: toolName }),
    });

    try {
      return await handler(message);
    } catch (error) {
      this.logger.error('MCP request failed', error, {
        method: message.method,
        userId: caller.session.userId,
      });
      const id =
        typeof message.id === 'string' || typeof message.id === 'number' ? message.id : null;
      if (id === null) return null;
      return {
        jsonrpc: '2.0',
        id,
        error: { code: JSON_RPC_ERROR_CODES.internalError, message: 'Internal error' },
      };
    }
  }

  /**
   * A 401 that an OAuth client can act on.
   *
   * `WWW-Authenticate` with `resource_metadata` is what turns a rejection into
   * a discovery step: it is how a connector that has never seen this server
   * finds the authorization server and starts the flow (RFC 9728). Without the
   * header ChatGPT reports a dead endpoint instead of asking to sign in.
   */
  private unauthorized(reply: FastifyReply, error: unknown): void {
    const challenge = `Bearer resource_metadata="${this.env.APP_URL}/.well-known/oauth-protected-resource"`;
    const status = error instanceof AppError ? error.status : 401;
    const message = error instanceof AppError ? error.message : 'Authentication is required';
    void reply
      .status(status === 401 || status === 403 ? 401 : status)
      .header('www-authenticate', challenge)
      .header('access-control-expose-headers', 'WWW-Authenticate')
      .send({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32_000, message: `Unauthorized: ${message}` },
      });
  }
}

/**
 * The session id this request belongs to: the client's own when it sent one
 * that survives validation, a fresh one otherwise. Validated because it is
 * written to the journal and shown to a person, and because a client is free
 * to put anything in a header.
 */
function agentSessionId(header: string | string[] | undefined): string {
  const value = Array.isArray(header) ? header[0] : header;
  const parsed = agentSessionExternalIdSchema.safeParse(value);
  return parsed.success ? parsed.data : `http-${randomUUID()}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Whether this `GET` is asking for the notification stream.
 *
 * A browser following the URL, a monitor, a link preview: all of them send
 * `Accept: text/html` or a wildcard, and all of them would otherwise be handed
 * socket that never closes. The specification has the client ask for
 * `text/event-stream` explicitly, so asking for it is the signal.
 */
function acceptsEventStream(accept: string | string[] | undefined): boolean {
  const value = Array.isArray(accept) ? accept.join(',') : (accept ?? '');
  return value.toLowerCase().includes('text/event-stream');
}

/**
 * Normalizes a parsed body into a list of JSON-RPC messages, or `null` when it
 * is not one at all. Batches were removed from the protocol in the 2025-06-18
 * revision and are still accepted, because a client that speaks the older one
 * is not wrong.
 */
function toMessages(body: unknown): JsonRpcRequest[] | null {
  const candidates = Array.isArray(body) ? body : [body];
  if (candidates.length === 0) return null;
  const messages: JsonRpcRequest[] = [];
  for (const candidate of candidates) {
    if (!isRecord(candidate) || typeof candidate.method !== 'string') return null;
    messages.push(candidate as unknown as JsonRpcRequest);
  }
  return messages;
}
