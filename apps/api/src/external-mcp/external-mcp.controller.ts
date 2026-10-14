import { Body, Controller, Delete, Get, Param, Patch, Post, Req } from '@nestjs/common';
import { ApiBody, ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';

import { type VerifiedSession } from '@exocortex/auth';
import {
  type CreateExternalMcpServerRequest,
  createExternalMcpServerRequestSchema,
  type DeleteExternalMcpServerResponse,
  deleteExternalMcpServerResponseSchema,
  type ExternalMcpServerListResponse,
  externalMcpServerListResponseSchema,
  type ExternalMcpServerResponse,
  externalMcpServerResponseSchema,
  type SetExternalMcpToolAccessRequest,
  setExternalMcpToolAccessRequestSchema,
  type UpdateExternalMcpServerRequest,
  updateExternalMcpServerRequestSchema,
} from '@exocortex/contracts';

import { type AuthenticatedRequest, CurrentSession } from '../auth/session.guard';
import { currentCorrelationId } from '../common/correlation';
import { openApiResponseSchema, openApiSchema, zodPipe } from '../common/zod';
import { workItemActorOf } from '../work-items/work-item-actor';

import { type ExternalMcpCaller, ExternalMcpService } from './external-mcp.service';

function callerOf(session: VerifiedSession, request: AuthenticatedRequest): ExternalMcpCaller {
  return {
    actor: workItemActorOf(session),
    viaBrowser: request.exocortexCredential === 'session',
  };
}

/**
 * External MCP servers of a workspace (issue #196, ADR-086).
 *
 * Deliberately not in the tool catalogue (`scripts/check-mcp-catalog.mjs`):
 * which servers the built-in AI may call and which of their tools it may use
 * is decided by a person, and the service refuses every token for the
 * changes. Every write is of the `admin` request class as well.
 */
@ApiTags('external-mcp')
@Controller('api/workspaces/:workspaceId/mcp-servers')
export class ExternalMcpController {
  constructor(private readonly servers: ExternalMcpService) {}

  @Get()
  @ApiOkResponse({ schema: openApiResponseSchema(externalMcpServerListResponseSchema) })
  async list(
    @CurrentSession() session: VerifiedSession,
    @Req() request: AuthenticatedRequest,
    @Param('workspaceId') workspaceId: string,
  ): Promise<ExternalMcpServerListResponse> {
    return this.servers.list(workspaceId, callerOf(session, request));
  }

  @Post()
  @ApiBody({ schema: openApiSchema(createExternalMcpServerRequestSchema) })
  @ApiCreatedResponse({ schema: openApiResponseSchema(externalMcpServerResponseSchema) })
  async create(
    @CurrentSession() session: VerifiedSession,
    @Req() request: AuthenticatedRequest,
    @Param('workspaceId') workspaceId: string,
    @Body(zodPipe(createExternalMcpServerRequestSchema)) body: CreateExternalMcpServerRequest,
  ): Promise<ExternalMcpServerResponse> {
    return this.servers.create(
      workspaceId,
      callerOf(session, request),
      body,
      currentCorrelationId(),
    );
  }

  @Get(':serverId')
  @ApiOkResponse({ schema: openApiResponseSchema(externalMcpServerResponseSchema) })
  async get(
    @CurrentSession() session: VerifiedSession,
    @Req() request: AuthenticatedRequest,
    @Param('workspaceId') workspaceId: string,
    @Param('serverId') serverId: string,
  ): Promise<ExternalMcpServerResponse> {
    return this.servers.get(workspaceId, serverId, callerOf(session, request));
  }

  @Patch(':serverId')
  @ApiBody({ schema: openApiSchema(updateExternalMcpServerRequestSchema) })
  @ApiOkResponse({ schema: openApiResponseSchema(externalMcpServerResponseSchema) })
  async update(
    @CurrentSession() session: VerifiedSession,
    @Req() request: AuthenticatedRequest,
    @Param('workspaceId') workspaceId: string,
    @Param('serverId') serverId: string,
    @Body(zodPipe(updateExternalMcpServerRequestSchema)) body: UpdateExternalMcpServerRequest,
  ): Promise<ExternalMcpServerResponse> {
    return this.servers.update(
      workspaceId,
      serverId,
      callerOf(session, request),
      body,
      currentCorrelationId(),
    );
  }

  @Delete(':serverId')
  @ApiOkResponse({ schema: openApiResponseSchema(deleteExternalMcpServerResponseSchema) })
  async remove(
    @CurrentSession() session: VerifiedSession,
    @Req() request: AuthenticatedRequest,
    @Param('workspaceId') workspaceId: string,
    @Param('serverId') serverId: string,
  ): Promise<DeleteExternalMcpServerResponse> {
    return this.servers.remove(
      workspaceId,
      serverId,
      callerOf(session, request),
      currentCorrelationId(),
    );
  }

  @Post(':serverId/check')
  @ApiOkResponse({ schema: openApiResponseSchema(externalMcpServerResponseSchema) })
  async check(
    @CurrentSession() session: VerifiedSession,
    @Req() request: AuthenticatedRequest,
    @Param('workspaceId') workspaceId: string,
    @Param('serverId') serverId: string,
  ): Promise<ExternalMcpServerResponse> {
    return this.servers.check(workspaceId, serverId, callerOf(session, request));
  }

  @Patch(':serverId/tools/:toolId')
  @ApiBody({ schema: openApiSchema(setExternalMcpToolAccessRequestSchema) })
  @ApiOkResponse({ schema: openApiResponseSchema(externalMcpServerResponseSchema) })
  async setToolAccess(
    @CurrentSession() session: VerifiedSession,
    @Req() request: AuthenticatedRequest,
    @Param() params: { workspaceId: string; serverId: string; toolId: string },
    @Body(zodPipe(setExternalMcpToolAccessRequestSchema)) body: SetExternalMcpToolAccessRequest,
  ): Promise<ExternalMcpServerResponse> {
    return this.servers.setToolAccess({
      ...params,
      caller: callerOf(session, request),
      request: body,
      correlationId: currentCorrelationId(),
    });
  }
}
