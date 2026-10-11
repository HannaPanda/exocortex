import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiBody, ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';

import { type VerifiedSession } from '@exocortex/auth';
import {
  type CancelWorkflowRunRequest,
  cancelWorkflowRunRequestSchema,
  type CreateWorkflowRequest,
  createWorkflowRequestSchema,
  type DeleteWorkflowResponse,
  deleteWorkflowResponseSchema,
  type PublishWorkflowRequest,
  publishWorkflowRequestSchema,
  type PublishWorkflowResponse,
  publishWorkflowResponseSchema,
  type SetWorkflowActivationRequest,
  setWorkflowActivationRequestSchema,
  type StartWorkflowRunRequest,
  startWorkflowRunRequestSchema,
  type UpdateWorkflowRequest,
  updateWorkflowRequestSchema,
  type ValidateWorkflowRequest,
  validateWorkflowRequestSchema,
  type WorkflowListResponse,
  workflowListResponseSchema,
  type WorkflowResponse,
  workflowResponseSchema,
  type WorkflowRunListResponse,
  workflowRunListResponseSchema,
  type WorkflowRunResponse,
  workflowRunResponseSchema,
  type WorkflowRunStartResponse,
  workflowRunStartResponseSchema,
  type WorkflowValidationResponse,
  workflowValidationResponseSchema,
  type WorkflowVersionListResponse,
  workflowVersionListResponseSchema,
  type WorkflowVersionResponse,
  workflowVersionResponseSchema,
} from '@exocortex/contracts';

import { CurrentSession } from '../auth/session.guard';
import { currentCorrelationId } from '../common/correlation';
import { openApiResponseSchema, openApiSchema, zodPipe } from '../common/zod';

import { WorkflowRunsService } from './workflow-runs.service';
import { WorkflowsService } from './workflows.service';

/**
 * Agent workflows (issue #160, ADR-075).
 *
 * Every write except `validate` is of the `admin` request class
 * (`requestClassFor`): an enabled workflow is a standing instruction that
 * starts agents by itself, like an automation rule, and starting or
 * cancelling a run is spending decided by an admin (issue #161).
 */
@ApiTags('workflows')
@Controller('api')
export class WorkflowsController {
  constructor(
    private readonly workflows: WorkflowsService,
    private readonly runs: WorkflowRunsService,
  ) {}

  @Get('workspaces/:workspaceId/workflows')
  @ApiOkResponse({ schema: openApiResponseSchema(workflowListResponseSchema) })
  async list(
    @CurrentSession() session: VerifiedSession,
    @Param('workspaceId') workspaceId: string,
  ): Promise<WorkflowListResponse> {
    return this.workflows.list({ workspaceId, userId: session.userId });
  }

  @Post('workspaces/:workspaceId/workflows')
  @ApiBody({ schema: openApiSchema(createWorkflowRequestSchema) })
  @ApiCreatedResponse({ schema: openApiResponseSchema(workflowResponseSchema) })
  async create(
    @CurrentSession() session: VerifiedSession,
    @Param('workspaceId') workspaceId: string,
    @Body(zodPipe(createWorkflowRequestSchema)) body: CreateWorkflowRequest,
  ): Promise<WorkflowResponse> {
    return this.workflows.create({
      workspaceId,
      userId: session.userId,
      request: body,
      correlationId: currentCorrelationId(),
    });
  }

  @Get('workflows/:workflowId')
  @ApiOkResponse({ schema: openApiResponseSchema(workflowResponseSchema) })
  async get(
    @CurrentSession() session: VerifiedSession,
    @Param('workflowId') workflowId: string,
  ): Promise<WorkflowResponse> {
    return this.workflows.get({ workflowId, userId: session.userId });
  }

  @Patch('workflows/:workflowId')
  @ApiBody({ schema: openApiSchema(updateWorkflowRequestSchema) })
  @ApiOkResponse({ schema: openApiResponseSchema(workflowResponseSchema) })
  async update(
    @CurrentSession() session: VerifiedSession,
    @Param('workflowId') workflowId: string,
    @Body(zodPipe(updateWorkflowRequestSchema)) body: UpdateWorkflowRequest,
  ): Promise<WorkflowResponse> {
    return this.workflows.update({
      workflowId,
      userId: session.userId,
      request: body,
      correlationId: currentCorrelationId(),
    });
  }

  @Post('workflows/:workflowId/validate')
  @ApiBody({ schema: openApiSchema(validateWorkflowRequestSchema) })
  @ApiOkResponse({ schema: openApiResponseSchema(workflowValidationResponseSchema) })
  async validate(
    @CurrentSession() session: VerifiedSession,
    @Param('workflowId') workflowId: string,
    @Body(zodPipe(validateWorkflowRequestSchema)) body: ValidateWorkflowRequest,
  ): Promise<WorkflowValidationResponse> {
    return this.workflows.validate({ workflowId, userId: session.userId, graph: body.graph });
  }

  @Post('workflows/:workflowId/publish')
  @ApiBody({ schema: openApiSchema(publishWorkflowRequestSchema) })
  @ApiCreatedResponse({ schema: openApiResponseSchema(publishWorkflowResponseSchema) })
  async publish(
    @CurrentSession() session: VerifiedSession,
    @Param('workflowId') workflowId: string,
    @Body(zodPipe(publishWorkflowRequestSchema)) body: PublishWorkflowRequest,
  ): Promise<PublishWorkflowResponse> {
    return this.workflows.publish({
      workflowId,
      userId: session.userId,
      request: body,
      correlationId: currentCorrelationId(),
    });
  }

  @Post('workflows/:workflowId/activation')
  @ApiBody({ schema: openApiSchema(setWorkflowActivationRequestSchema) })
  @ApiOkResponse({ schema: openApiResponseSchema(workflowResponseSchema) })
  async setActivation(
    @CurrentSession() session: VerifiedSession,
    @Param('workflowId') workflowId: string,
    @Body(zodPipe(setWorkflowActivationRequestSchema)) body: SetWorkflowActivationRequest,
  ): Promise<WorkflowResponse> {
    return this.workflows.setActivation({
      workflowId,
      userId: session.userId,
      request: body,
      correlationId: currentCorrelationId(),
    });
  }

  @Delete('workflows/:workflowId')
  @ApiOkResponse({ schema: openApiResponseSchema(deleteWorkflowResponseSchema) })
  async delete(
    @CurrentSession() session: VerifiedSession,
    @Param('workflowId') workflowId: string,
  ): Promise<DeleteWorkflowResponse> {
    return this.workflows.delete({
      workflowId,
      userId: session.userId,
      correlationId: currentCorrelationId(),
    });
  }

  @Get('workflows/:workflowId/versions')
  @ApiOkResponse({ schema: openApiResponseSchema(workflowVersionListResponseSchema) })
  async listVersions(
    @CurrentSession() session: VerifiedSession,
    @Param('workflowId') workflowId: string,
  ): Promise<WorkflowVersionListResponse> {
    return this.workflows.listVersions({ workflowId, userId: session.userId });
  }

  @Get('workflow-versions/:versionId')
  @ApiOkResponse({ schema: openApiResponseSchema(workflowVersionResponseSchema) })
  async getVersion(
    @CurrentSession() session: VerifiedSession,
    @Param('versionId') versionId: string,
  ): Promise<WorkflowVersionResponse> {
    return this.workflows.getVersion({ versionId, userId: session.userId });
  }

  @Get('workflows/:workflowId/runs')
  @ApiOkResponse({ schema: openApiResponseSchema(workflowRunListResponseSchema) })
  async listRuns(
    @CurrentSession() session: VerifiedSession,
    @Param('workflowId') workflowId: string,
  ): Promise<WorkflowRunListResponse> {
    return this.runs.list({ workflowId, userId: session.userId });
  }

  @Post('workflows/:workflowId/runs')
  @ApiBody({ schema: openApiSchema(startWorkflowRunRequestSchema) })
  @ApiCreatedResponse({ schema: openApiResponseSchema(workflowRunStartResponseSchema) })
  async startRun(
    @CurrentSession() session: VerifiedSession,
    @Param('workflowId') workflowId: string,
    @Body(zodPipe(startWorkflowRunRequestSchema)) body: StartWorkflowRunRequest,
  ): Promise<WorkflowRunStartResponse> {
    return this.runs.start({
      workflowId,
      userId: session.userId,
      request: body,
      correlationId: currentCorrelationId(),
    });
  }

  @Post('workflow-runs/:runId/cancel')
  @ApiBody({ schema: openApiSchema(cancelWorkflowRunRequestSchema) })
  @ApiOkResponse({ schema: openApiResponseSchema(workflowRunResponseSchema) })
  async cancelRun(
    @CurrentSession() session: VerifiedSession,
    @Param('runId') runId: string,
    @Body(zodPipe(cancelWorkflowRunRequestSchema)) body: CancelWorkflowRunRequest,
  ): Promise<WorkflowRunResponse> {
    return this.runs.cancel({
      runId,
      userId: session.userId,
      request: body,
      correlationId: currentCorrelationId(),
    });
  }

  @Get('workflow-runs/:runId')
  @ApiOkResponse({ schema: openApiResponseSchema(workflowRunResponseSchema) })
  async getRun(
    @CurrentSession() session: VerifiedSession,
    @Param('runId') runId: string,
  ): Promise<WorkflowRunResponse> {
    return this.runs.get({ runId, userId: session.userId });
  }
}
