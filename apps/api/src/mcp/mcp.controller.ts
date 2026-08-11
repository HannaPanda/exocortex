import { Controller, Delete, Get, Inject, Param, Post, Req, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { type FastifyReply, type FastifyRequest } from 'fastify';

import { type ApiEnv } from '@exocortex/config';
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

/**
 * MCP over Streamable HTTP.
 *
 * One POST carries one JSON-RPC message (or, for the older protocol revision,
 * a batch of them) and the response comes straight back as JSON. The
 * specification also allows answering with an SSE stream, which exists so a
 * server can push notifications and its own requests mid-call; this server
 * never does either, so a stream would only be an idle socket. `GET` is
 * therefore refused rather than upgraded, and no `Mcp-Session-Id` is issued:
 * there is no per-connection state to key, which is what lets two API
 * processes serve the same client interchangeably.
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

  @Public()
  @Get()
  openStream(@Res() reply: FastifyReply): void {
    this.refuseStream(reply);
  }

  @Public()
  @Get('research')
  openResearchStream(@Res() reply: FastifyReply): void {
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

  private refuseStream(reply: FastifyReply): void {
    void reply
      .status(405)
      .header('allow', 'POST, DELETE')
      .send({
        code: 'validation_failed',
        message:
          'This MCP endpoint answers POST only. It sends no server-initiated messages, so there is no stream to open.',
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

    const messages = toMessages(request.body);
    if (messages === null) {
      void reply.status(400).send({
        jsonrpc: '2.0',
        id: null,
        error: { code: JSON_RPC_ERROR_CODES.invalidRequest, message: 'Invalid Request' },
      });
      return;
    }

    const handler = this.mcp.createHandler(caller, surface);
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
      message.method === 'tools/call' && isRecord(message.params) && typeof message.params.name === 'string'
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
      const id = typeof message.id === 'string' || typeof message.id === 'number' ? message.id : null;
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
    const message =
      error instanceof AppError ? error.message : 'Authentication is required';
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
