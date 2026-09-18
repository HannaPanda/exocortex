import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiBody, ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';

import { type VerifiedSession } from '@exocortex/auth';
import {
  type CreateTemplateRequest,
  createTemplateRequestSchema,
  type DeleteTemplateResponse,
  deleteTemplateResponseSchema,
  type InstantiateTemplateRequest,
  instantiateTemplateRequestSchema,
  type InstantiateTemplateResponse,
  instantiateTemplateResponseSchema,
  type TemplateListResponse,
  templateListResponseSchema,
  type TemplateResponse,
  templateResponseSchema,
  type UpdateTemplateRequest,
  updateTemplateRequestSchema,
} from '@exocortex/contracts';

import { CurrentSession } from '../auth/session.guard';
import { currentCorrelationId } from '../common/correlation';
import { openApiResponseSchema, openApiSchema, zodPipe } from '../common/zod';

import { TemplatesService } from './templates.service';

/**
 * Page templates (issue #79, ADR-039).
 *
 * The listing hangs under the workspace because "which templates are there" is
 * a question about a workspace; everything else addresses the template by the
 * id of the page it is, because that is the only id a template has.
 */
@ApiTags('templates')
@Controller('api')
export class TemplatesController {
  constructor(private readonly templates: TemplatesService) {}

  @Get('workspaces/:workspaceId/templates')
  @ApiOkResponse({ schema: openApiResponseSchema(templateListResponseSchema) })
  async list(
    @CurrentSession() session: VerifiedSession,
    @Param('workspaceId') workspaceId: string,
  ): Promise<TemplateListResponse> {
    return this.templates.list({ workspaceId, userId: session.userId });
  }

  @Post('workspaces/:workspaceId/templates')
  @ApiBody({ schema: openApiSchema(createTemplateRequestSchema) })
  @ApiCreatedResponse({ schema: openApiResponseSchema(templateResponseSchema) })
  async create(
    @CurrentSession() session: VerifiedSession,
    @Param('workspaceId') workspaceId: string,
    @Body(zodPipe(createTemplateRequestSchema)) body: CreateTemplateRequest,
  ): Promise<TemplateResponse> {
    return this.templates.create({ workspaceId, userId: session.userId, request: body });
  }

  @Patch('templates/:documentId')
  @ApiBody({ schema: openApiSchema(updateTemplateRequestSchema) })
  @ApiOkResponse({ schema: openApiResponseSchema(templateResponseSchema) })
  async update(
    @CurrentSession() session: VerifiedSession,
    @Param('documentId') documentId: string,
    @Body(zodPipe(updateTemplateRequestSchema)) body: UpdateTemplateRequest,
  ): Promise<TemplateResponse> {
    return this.templates.update({ documentId, userId: session.userId, request: body });
  }

  @Delete('templates/:documentId')
  @ApiOkResponse({ schema: openApiResponseSchema(deleteTemplateResponseSchema) })
  async remove(
    @CurrentSession() session: VerifiedSession,
    @Param('documentId') documentId: string,
  ): Promise<DeleteTemplateResponse> {
    return this.templates.remove({ documentId, userId: session.userId });
  }

  @Post('templates/:documentId/pages')
  @ApiBody({ schema: openApiSchema(instantiateTemplateRequestSchema) })
  @ApiCreatedResponse({ schema: openApiResponseSchema(instantiateTemplateResponseSchema) })
  async instantiate(
    @CurrentSession() session: VerifiedSession,
    @Param('documentId') documentId: string,
    @Body(zodPipe(instantiateTemplateRequestSchema)) body: InstantiateTemplateRequest,
  ): Promise<InstantiateTemplateResponse> {
    return this.templates.instantiate({
      documentId,
      userId: session.userId,
      request: body,
      correlationId: currentCorrelationId(),
    });
  }
}
