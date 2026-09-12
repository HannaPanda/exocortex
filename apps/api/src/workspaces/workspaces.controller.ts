import { Body, Controller, Delete, Get, Param, Patch, Post, Put } from '@nestjs/common';
import { ApiBody, ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';

import { type VerifiedSession } from '@exocortex/auth';
import {
  type CreateWorkspaceRequest,
  createWorkspaceRequestSchema,
  type SetWorkspaceCredentialRequest,
  setWorkspaceCredentialRequestSchema,
  type UpdateWorkspaceMemberRequest,
  updateWorkspaceMemberRequestSchema,
  type UpdateWorkspaceRequest,
  updateWorkspaceRequestSchema,
  type UpdateWorkspaceSettingsRequest,
  updateWorkspaceSettingsRequestSchema,
  type Workspace,
  type WorkspaceCredentialListResponse,
  workspaceCredentialListResponseSchema,
  type WorkspaceCredentialPurpose,
  workspaceCredentialPurposeSchema,
  type WorkspaceDetail,
  workspaceDetailSchema,
  type WorkspaceListResponse,
  workspaceListResponseSchema,
  type WorkspaceMember,
  workspaceMemberSchema,
  type WorkspaceOverviewResponse,
  workspaceOverviewResponseSchema,
  workspaceSchema,
  type WorkspaceSettingsResponse,
  workspaceSettingsResponseSchema,
} from '@exocortex/contracts';

import { CurrentSession } from '../auth/session.guard';
import { AppError } from '../common/app-error';
import { currentCorrelationId } from '../common/correlation';
import { openApiResponseSchema, openApiSchema, zodPipe } from '../common/zod';

import { WorkspaceCredentialsService } from './workspace-credentials.service';
import { WorkspaceOverviewService } from './workspace-overview.service';
import { WorkspacesService } from './workspaces.service';

/** Thin controller: validation and delegation only. */
@ApiTags('workspaces')
@Controller('api/workspaces')
export class WorkspacesController {
  constructor(
    private readonly workspaces: WorkspacesService,
    private readonly overview: WorkspaceOverviewService,
    private readonly credentials: WorkspaceCredentialsService,
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

  /**
   * The configuration in force in this workspace, plus what it would fall back
   * to. Declared before `:workspaceId` so the literal segment is not eaten by
   * the parameter route above it.
   */
  @Get(':workspaceId/settings')
  @ApiOkResponse({ schema: openApiResponseSchema(workspaceSettingsResponseSchema) })
  async settings(
    @CurrentSession() session: VerifiedSession,
    @Param('workspaceId') workspaceId: string,
  ): Promise<WorkspaceSettingsResponse> {
    return this.workspaces.getSettings(workspaceId, session.userId);
  }

  @Patch(':workspaceId/settings')
  @ApiBody({ schema: openApiSchema(updateWorkspaceSettingsRequestSchema) })
  @ApiOkResponse({ schema: openApiResponseSchema(workspaceSettingsResponseSchema) })
  async updateSettings(
    @CurrentSession() session: VerifiedSession,
    @Param('workspaceId') workspaceId: string,
    @Body(zodPipe(updateWorkspaceSettingsRequestSchema)) body: UpdateWorkspaceSettingsRequest,
  ): Promise<WorkspaceSettingsResponse> {
    return this.workspaces.updateSettings({
      workspaceId,
      actorUserId: session.userId,
      request: body,
    });
  }

  /**
   * This workspace's own provider keys (issue #52, AP7, ADR-023).
   *
   * Never the value: a stored secret leaves the server only as a provider
   * call, made by the worker. Declared above `:workspaceId` for the same
   * reason the settings routes are.
   */
  @Get(':workspaceId/credentials')
  @ApiOkResponse({ schema: openApiResponseSchema(workspaceCredentialListResponseSchema) })
  async credentialList(
    @CurrentSession() session: VerifiedSession,
    @Param('workspaceId') workspaceId: string,
  ): Promise<WorkspaceCredentialListResponse> {
    return this.credentials.list(workspaceId, session.userId);
  }

  /** PUT, not PATCH: a key is replaced whole or not at all. */
  @Put(':workspaceId/credentials/:purpose')
  @ApiBody({ schema: openApiSchema(setWorkspaceCredentialRequestSchema) })
  @ApiOkResponse({ schema: openApiResponseSchema(workspaceCredentialListResponseSchema) })
  async setCredential(
    @CurrentSession() session: VerifiedSession,
    @Param('workspaceId') workspaceId: string,
    @Param('purpose') purpose: string,
    @Body(zodPipe(setWorkspaceCredentialRequestSchema)) body: SetWorkspaceCredentialRequest,
  ): Promise<WorkspaceCredentialListResponse> {
    return this.credentials.set({
      workspaceId,
      actorUserId: session.userId,
      purpose: this.parsePurpose(purpose),
      request: body,
    });
  }

  @Delete(':workspaceId/credentials/:purpose')
  @ApiOkResponse({ schema: openApiResponseSchema(workspaceCredentialListResponseSchema) })
  async removeCredential(
    @CurrentSession() session: VerifiedSession,
    @Param('workspaceId') workspaceId: string,
    @Param('purpose') purpose: string,
  ): Promise<WorkspaceCredentialListResponse> {
    return this.credentials.remove({
      workspaceId,
      actorUserId: session.userId,
      purpose: this.parsePurpose(purpose),
    });
  }

  /** A path segment is a string until something says which one it is. */
  private parsePurpose(raw: string): WorkspaceCredentialPurpose {
    const result = workspaceCredentialPurposeSchema.safeParse(raw);
    if (!result.success) throw AppError.notFound(`Credential purpose "${raw}"`);
    return result.data;
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
