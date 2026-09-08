import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiBody, ApiOkResponse, ApiTags } from '@nestjs/swagger';

import { type VerifiedSession } from '@exocortex/auth';
import {
  type AgentSessionDetailResponse,
  agentSessionDetailResponseSchema,
  type AgentSessionListResponse,
  agentSessionListResponseSchema,
  type AgentSessionRevertResponse,
  agentSessionRevertResponseSchema,
  type RegisterAgentSessionRequest,
  registerAgentSessionRequestSchema,
} from '@exocortex/contracts';

import { CurrentSession } from '../auth/session.guard';
import { currentCorrelationId } from '../common/correlation';
import { openApiResponseSchema, openApiSchema, zodPipe } from '../common/zod';

import { AgentSessionsService } from './agent-sessions.service';

/**
 * Provenance per agent session (issue #49, ADR-022).
 *
 * Not under `/api/admin`, although the browser reaches it from the admin area:
 * an agent announces its own session here, and a route an agent has to call
 * cannot live behind a guard that only admins pass. The narrowing happens in
 * the service instead, where it can be "your own, or everything if you
 * administer this deployment".
 */
@ApiTags('agent-sessions')
@Controller('api/agent-sessions')
export class AgentSessionsController {
  constructor(private readonly sessions: AgentSessionsService) {}

  /** Announced by an MCP connection at `initialize`. Idempotent. */
  @Post()
  @ApiBody({ schema: openApiSchema(registerAgentSessionRequestSchema) })
  async register(
    @CurrentSession() session: VerifiedSession,
    @Body(zodPipe(registerAgentSessionRequestSchema)) body: RegisterAgentSessionRequest,
  ): Promise<{ id: string; externalId: string }> {
    return this.sessions.register(session.userId, body);
  }

  @Get()
  @ApiOkResponse({ schema: openApiResponseSchema(agentSessionListResponseSchema) })
  async list(@CurrentSession() session: VerifiedSession): Promise<AgentSessionListResponse> {
    return this.sessions.list(session.userId);
  }

  @Get(':id')
  @ApiOkResponse({ schema: openApiResponseSchema(agentSessionDetailResponseSchema) })
  async detail(
    @Param('id') id: string,
    @CurrentSession() session: VerifiedSession,
  ): Promise<AgentSessionDetailResponse> {
    return this.sessions.detail(id, session.userId);
  }

  /**
   * Takes the whole session back, page by page.
   *
   * Partial by nature, so it answers 200 with two lists rather than failing:
   * "these went back, these did not and here is why" is the only honest report
   * a non-atomic operation can give.
   */
  @Post(':id/revert')
  @ApiOkResponse({ schema: openApiResponseSchema(agentSessionRevertResponseSchema) })
  async revert(
    @Param('id') id: string,
    @CurrentSession() session: VerifiedSession,
  ): Promise<AgentSessionRevertResponse> {
    return this.sessions.revert(id, session.userId, currentCorrelationId());
  }
}
