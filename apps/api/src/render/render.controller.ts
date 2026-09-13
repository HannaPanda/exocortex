import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBody, ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';

import { type VerifiedSession } from '@exocortex/auth';
import {
  type CreateRenderTemplateRequest,
  createRenderTemplateRequestSchema,
  type DeleteRenderTemplateResponse,
  deleteRenderTemplateResponseSchema,
  type RenderArtifactResponse,
  renderArtifactResponseSchema,
  type RenderJobListResponse,
  renderJobListResponseSchema,
  type RenderJobLogResponse,
  renderJobLogResponseSchema,
  type RenderJobResponse,
  renderJobResponseSchema,
  type RenderTemplateListResponse,
  renderTemplateListResponseSchema,
  type RenderTemplateResponse,
  renderTemplateResponseSchema,
  type StartRenderRequest,
  startRenderRequestSchema,
  type StartRenderResponse,
  startRenderResponseSchema,
  type UpdateRenderTemplateRequest,
  updateRenderTemplateRequestSchema,
} from '@exocortex/contracts';

import { CurrentSession } from '../auth/session.guard';
import { openApiResponseSchema, openApiSchema, zodPipe } from '../common/zod';

import { RenderJobsService } from './render-jobs.service';
import { RenderTemplatesService } from './render-templates.service';

/**
 * The templates and the build log of one workspace (issue #44, ADR-026).
 */
@ApiTags('workspaces')
@Controller('api/workspaces/:workspaceId/render')
export class WorkspaceRenderController {
  constructor(
    private readonly templates: RenderTemplatesService,
    private readonly jobs: RenderJobsService,
  ) {}

  @Get('templates')
  @ApiOkResponse({ schema: openApiResponseSchema(renderTemplateListResponseSchema) })
  async listTemplates(
    @CurrentSession() session: VerifiedSession,
    @Param('workspaceId') workspaceId: string,
  ): Promise<RenderTemplateListResponse> {
    return this.templates.list(workspaceId, session.userId);
  }

  @Post('templates')
  @ApiBody({ schema: openApiSchema(createRenderTemplateRequestSchema) })
  @ApiCreatedResponse({ schema: openApiResponseSchema(renderTemplateResponseSchema) })
  async createTemplate(
    @CurrentSession() session: VerifiedSession,
    @Param('workspaceId') workspaceId: string,
    @Body(zodPipe(createRenderTemplateRequestSchema)) body: CreateRenderTemplateRequest,
  ): Promise<RenderTemplateResponse> {
    return {
      template: await this.templates.create({ workspaceId, userId: session.userId, request: body }),
    };
  }

  @Get('jobs')
  @ApiOkResponse({ schema: openApiResponseSchema(renderJobListResponseSchema) })
  async listJobs(
    @CurrentSession() session: VerifiedSession,
    @Param('workspaceId') workspaceId: string,
    @Query('documentId') documentId?: string,
  ): Promise<RenderJobListResponse> {
    return this.jobs.list({ workspaceId, userId: session.userId, documentId });
  }
}

/**
 * One template and one build, addressed by their own ids.
 *
 * The log and the artifact are separate routes rather than fields on the job:
 * a LaTeX log runs to tens of kilobytes and a list view has no use for it, and
 * the artifact route answers the question "where are the bytes" without the
 * caller having to know that a render artifact is an ordinary attachment.
 */
@ApiTags('workspaces')
@Controller('api/render')
export class RenderController {
  constructor(
    private readonly templates: RenderTemplatesService,
    private readonly jobs: RenderJobsService,
  ) {}

  @Get('templates/:templateId')
  @ApiOkResponse({ schema: openApiResponseSchema(renderTemplateResponseSchema) })
  async readTemplate(
    @CurrentSession() session: VerifiedSession,
    @Param('templateId') templateId: string,
  ): Promise<RenderTemplateResponse> {
    return { template: await this.templates.read(templateId, session.userId) };
  }

  @Patch('templates/:templateId')
  @ApiBody({ schema: openApiSchema(updateRenderTemplateRequestSchema) })
  @ApiOkResponse({ schema: openApiResponseSchema(renderTemplateResponseSchema) })
  async updateTemplate(
    @CurrentSession() session: VerifiedSession,
    @Param('templateId') templateId: string,
    @Body(zodPipe(updateRenderTemplateRequestSchema)) body: UpdateRenderTemplateRequest,
  ): Promise<RenderTemplateResponse> {
    return {
      template: await this.templates.update({ templateId, userId: session.userId, request: body }),
    };
  }

  @Delete('templates/:templateId')
  @ApiOkResponse({ schema: openApiResponseSchema(deleteRenderTemplateResponseSchema) })
  async deleteTemplate(
    @CurrentSession() session: VerifiedSession,
    @Param('templateId') templateId: string,
  ): Promise<DeleteRenderTemplateResponse> {
    await this.templates.remove(templateId, session.userId);
    return { deleted: true };
  }

  @Get('jobs/:jobId')
  @ApiOkResponse({ schema: openApiResponseSchema(renderJobResponseSchema) })
  async readJob(
    @CurrentSession() session: VerifiedSession,
    @Param('jobId') jobId: string,
  ): Promise<RenderJobResponse> {
    return { job: await this.jobs.read(jobId, session.userId) };
  }

  @Get('jobs/:jobId/log')
  @ApiOkResponse({ schema: openApiResponseSchema(renderJobLogResponseSchema) })
  async readLog(
    @CurrentSession() session: VerifiedSession,
    @Param('jobId') jobId: string,
  ): Promise<RenderJobLogResponse> {
    return this.jobs.readLog(jobId, session.userId);
  }

  @Get('jobs/:jobId/artifact')
  @ApiOkResponse({ schema: openApiResponseSchema(renderArtifactResponseSchema) })
  async readArtifact(
    @CurrentSession() session: VerifiedSession,
    @Param('jobId') jobId: string,
  ): Promise<RenderArtifactResponse> {
    return this.jobs.artifact(jobId, session.userId);
  }

  @Post('jobs/:jobId/cancel')
  @ApiOkResponse({ schema: openApiResponseSchema(renderJobResponseSchema) })
  async cancelJob(
    @CurrentSession() session: VerifiedSession,
    @Param('jobId') jobId: string,
  ): Promise<RenderJobResponse> {
    return { job: await this.jobs.cancel(jobId, session.userId) };
  }
}

/**
 * Starting a build, which hangs off the page rather than off the render area:
 * "render this page" is a thing done to a document, and the document is what
 * the permission check is about.
 */
@ApiTags('documents')
@Controller('api/documents')
export class DocumentRenderController {
  constructor(private readonly jobs: RenderJobsService) {}

  @Post(':documentId/render')
  @ApiBody({ schema: openApiSchema(startRenderRequestSchema) })
  @ApiCreatedResponse({ schema: openApiResponseSchema(startRenderResponseSchema) })
  async start(
    @CurrentSession() session: VerifiedSession,
    @Param('documentId') documentId: string,
    @Body(zodPipe(startRenderRequestSchema)) body: StartRenderRequest,
  ): Promise<StartRenderResponse> {
    return this.jobs.start({ documentId, userId: session.userId, request: body });
  }
}
