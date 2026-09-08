import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiBody, ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';

import { type VerifiedSession } from '@exocortex/auth';
import {
  type CreateWorkspaceRequest,
  createWorkspaceRequestSchema,
  type UpdateWorkspaceMemberRequest,
  updateWorkspaceMemberRequestSchema,
  type UpdateWorkspaceRequest,
  updateWorkspaceRequestSchema,
  type Workspace,
  type WorkspaceDetail,
  workspaceDetailSchema,
  type WorkspaceListResponse,
  workspaceListResponseSchema,
  type WorkspaceMember,
  workspaceMemberSchema,
  type WorkspaceOverviewResponse,
  workspaceOverviewResponseSchema,
  workspaceSchema,
} from '@exocortex/contracts';

import { CurrentSession } from '../auth/session.guard';
import { currentCorrelationId } from '../common/correlation';
import { openApiResponseSchema, openApiSchema, zodPipe } from '../common/zod';

import { WorkspaceOverviewService } from './workspace-overview.service';
import { WorkspacesService } from './workspaces.service';

/** Thin controller: validation and delegation only. */
@ApiTags('workspaces')
@Controller('api/workspaces')
export class WorkspacesController {
  constructor(
    private readonly workspaces: WorkspacesService,
    private readonly overview: WorkspaceOverviewService,
  ) {}

  @Get()
  @ApiOkResponse({ schema: openApiResponseSchema(workspaceListResponseSchema) })
  async list(@CurrentSession() session: VerifiedSession): Promise<WorkspaceListResponse> {
    return { workspaces: await this.workspaces.listForUser(session.userId) };
  }

  @Post()
  @ApiBody({ schema: openApiSchema(createWorkspaceRequestSchema) })
  @ApiCreatedResponse({ schema: openApiResponseSchema(workspaceSchema) })
  async create(
    @CurrentSession() session: VerifiedSession,
    @Body(zodPipe(createWorkspaceRequestSchema)) body: CreateWorkspaceRequest,
  ): Promise<Workspace> {
    return this.workspaces.create(session.userId, body);
  }

  /** Everything the landing view draws, in one answer. */
  @Get(':workspaceId/overview')
  @ApiOkResponse({ schema: openApiResponseSchema(workspaceOverviewResponseSchema) })
  async overviewFor(
    @CurrentSession() session: VerifiedSession,
    @Param('workspaceId') workspaceId: string,
  ): Promise<WorkspaceOverviewResponse> {
    return this.overview.get(workspaceId, session.userId);
  }

  @Get(':workspaceId')
  @ApiOkResponse({ schema: openApiResponseSchema(workspaceDetailSchema) })
  async detail(
    @CurrentSession() session: VerifiedSession,
    @Param('workspaceId') workspaceId: string,
  ): Promise<WorkspaceDetail> {
    return this.workspaces.getDetail(workspaceId, session.userId);
  }

  @Patch(':workspaceId')
  @ApiBody({ schema: openApiSchema(updateWorkspaceRequestSchema) })
  @ApiOkResponse({ schema: openApiResponseSchema(workspaceSchema) })
  async update(
    @CurrentSession() session: VerifiedSession,
    @Param('workspaceId') workspaceId: string,
    @Body(zodPipe(updateWorkspaceRequestSchema)) body: UpdateWorkspaceRequest,
  ): Promise<Workspace> {
    return this.workspaces.update({
      workspaceId,
      actorUserId: session.userId,
      request: body,
      correlationId: currentCorrelationId(),
    });
  }

  @Patch(':workspaceId/members/:userId')
  @ApiBody({ schema: openApiSchema(updateWorkspaceMemberRequestSchema) })
  @ApiOkResponse({ schema: openApiResponseSchema(workspaceMemberSchema) })
  async updateMember(
    @CurrentSession() session: VerifiedSession,
    @Param('workspaceId') workspaceId: string,
    @Param('userId') userId: string,
    @Body(zodPipe(updateWorkspaceMemberRequestSchema)) body: UpdateWorkspaceMemberRequest,
  ): Promise<WorkspaceMember> {
    return this.workspaces.changeMemberRole({
      workspaceId,
      actorUserId: session.userId,
      targetUserId: userId,
      nextRole: body.role,
      correlationId: currentCorrelationId(),
    });
  }
}
