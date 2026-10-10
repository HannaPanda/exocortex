import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiBody, ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';

import { type VerifiedSession } from '@exocortex/auth';
import {
  type AgentProfileListResponse,
  agentProfileListResponseSchema,
  type AgentProfileResponse,
  agentProfileResponseSchema,
  type CreateAgentProfileRequest,
  createAgentProfileRequestSchema,
  type DeleteAgentProfileResponse,
  deleteAgentProfileResponseSchema,
  type DuplicateAgentProfileRequest,
  duplicateAgentProfileRequestSchema,
  type UpdateAgentProfileRequest,
  updateAgentProfileRequestSchema,
} from '@exocortex/contracts';

import { CurrentSession } from '../auth/session.guard';
import { currentCorrelationId } from '../common/correlation';
import { openApiResponseSchema, openApiSchema, zodPipe } from '../common/zod';

import { AgentProfilesService } from './agent-profiles.service';

/**
 * Agent profiles (issue #143, ADR-071).
 *
 * Every write here is of the `admin` request class (`requestClassFor`): a
 * profile decides what every run under it may use, write and spend, so a
 * token that may only write pages does not get to change one.
 */
@ApiTags('agent-profiles')
@Controller('api')
export class AgentProfilesController {
  constructor(private readonly profiles: AgentProfilesService) {}

  @Get('workspaces/:workspaceId/agent-profiles')
  @ApiOkResponse({ schema: openApiResponseSchema(agentProfileListResponseSchema) })
  async list(
    @CurrentSession() session: VerifiedSession,
    @Param('workspaceId') workspaceId: string,
  ): Promise<AgentProfileListResponse> {
    return this.profiles.list({ workspaceId, userId: session.userId });
  }

  @Post('workspaces/:workspaceId/agent-profiles')
  @ApiBody({ schema: openApiSchema(createAgentProfileRequestSchema) })
  @ApiCreatedResponse({ schema: openApiResponseSchema(agentProfileResponseSchema) })
  async create(
    @CurrentSession() session: VerifiedSession,
    @Param('workspaceId') workspaceId: string,
    @Body(zodPipe(createAgentProfileRequestSchema)) body: CreateAgentProfileRequest,
  ): Promise<AgentProfileResponse> {
    return this.profiles.create({
      workspaceId,
      userId: session.userId,
      request: body,
      correlationId: currentCorrelationId(),
    });
  }

  @Get('agent-profiles/:profileId')
  @ApiOkResponse({ schema: openApiResponseSchema(agentProfileResponseSchema) })
  async get(
    @CurrentSession() session: VerifiedSession,
    @Param('profileId') profileId: string,
  ): Promise<AgentProfileResponse> {
    return this.profiles.get({ profileId, userId: session.userId });
  }

  @Patch('agent-profiles/:profileId')
  @ApiBody({ schema: openApiSchema(updateAgentProfileRequestSchema) })
  @ApiOkResponse({ schema: openApiResponseSchema(agentProfileResponseSchema) })
  async update(
    @CurrentSession() session: VerifiedSession,
    @Param('profileId') profileId: string,
    @Body(zodPipe(updateAgentProfileRequestSchema)) body: UpdateAgentProfileRequest,
  ): Promise<AgentProfileResponse> {
    return this.profiles.update({
      profileId,
      userId: session.userId,
      request: body,
      correlationId: currentCorrelationId(),
    });
  }

  @Post('agent-profiles/:profileId/duplicate')
  @ApiBody({ schema: openApiSchema(duplicateAgentProfileRequestSchema) })
  @ApiCreatedResponse({ schema: openApiResponseSchema(agentProfileResponseSchema) })
  async duplicate(
    @CurrentSession() session: VerifiedSession,
    @Param('profileId') profileId: string,
    @Body(zodPipe(duplicateAgentProfileRequestSchema)) body: DuplicateAgentProfileRequest,
  ): Promise<AgentProfileResponse> {
    return this.profiles.duplicate({
      profileId,
      userId: session.userId,
      request: body,
      correlationId: currentCorrelationId(),
    });
  }

  @Delete('agent-profiles/:profileId')
  @ApiOkResponse({ schema: openApiResponseSchema(deleteAgentProfileResponseSchema) })
  async delete(
    @CurrentSession() session: VerifiedSession,
    @Param('profileId') profileId: string,
  ): Promise<DeleteAgentProfileResponse> {
    return this.profiles.delete({
      profileId,
      userId: session.userId,
      correlationId: currentCorrelationId(),
    });
  }
}
