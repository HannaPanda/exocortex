import { Body, Controller, Param, Post } from '@nestjs/common';
import { ApiBody, ApiOkResponse, ApiTags } from '@nestjs/swagger';

import { type VerifiedSession } from '@exocortex/auth';
import {
  type DocumentBlockWriteRequest,
  documentBlockWriteRequestSchema,
  type DocumentGranularWriteResponse,
  documentGranularWriteResponseSchema,
  type DocumentPatchRequest,
  documentPatchRequestSchema,
  type DocumentSectionWriteRequest,
  documentSectionWriteRequestSchema,
} from '@exocortex/contracts';

import { CurrentSession } from '../auth/session.guard';
import { currentCorrelationId } from '../common/correlation';
import { openApiResponseSchema, openApiSchema, zodPipe } from '../common/zod';

import { DocumentEditService } from './document-edit.service';

/**
 * Writing part of a page (issue #111, ADR-055).
 *
 * Its own controller for the reason `DocumentDiffController` is one:
 * `DocumentsController` already carries ten collaborators, and these three are
 * one capability rather than three more properties of a document.
 *
 * Three routes rather than one with a discriminator, because they are three
 * different questions asked of the same page and each answers with its own
 * refusals -- a block that is gone, a heading that occurs twice, a text that
 * occurs twice. One route carrying all three would answer them all the same
 * way.
 */
@ApiTags('documents')
@Controller('api/documents')
export class DocumentEditController {
  constructor(private readonly edits: DocumentEditService) {}

  @Post(':documentId/content/block')
  @ApiBody({ schema: openApiSchema(documentBlockWriteRequestSchema) })
  @ApiOkResponse({ schema: openApiResponseSchema(documentGranularWriteResponseSchema) })
  async writeBlock(
    @CurrentSession() session: VerifiedSession,
    @Param('documentId') documentId: string,
    @Body(zodPipe(documentBlockWriteRequestSchema)) body: DocumentBlockWriteRequest,
  ): Promise<DocumentGranularWriteResponse> {
    return this.edits.writeBlock({
      documentId,
      userId: session.userId,
      request: body,
      correlationId: currentCorrelationId(),
      source: 'api',
    });
  }

  @Post(':documentId/content/patch')
  @ApiBody({ schema: openApiSchema(documentPatchRequestSchema) })
  @ApiOkResponse({ schema: openApiResponseSchema(documentGranularWriteResponseSchema) })
  async patchContent(
    @CurrentSession() session: VerifiedSession,
    @Param('documentId') documentId: string,
    @Body(zodPipe(documentPatchRequestSchema)) body: DocumentPatchRequest,
  ): Promise<DocumentGranularWriteResponse> {
    return this.edits.patch({
      documentId,
      userId: session.userId,
      request: body,
      correlationId: currentCorrelationId(),
      source: 'api',
    });
  }

  @Post(':documentId/content/section')
  @ApiBody({ schema: openApiSchema(documentSectionWriteRequestSchema) })
  @ApiOkResponse({ schema: openApiResponseSchema(documentGranularWriteResponseSchema) })
  async writeSection(
    @CurrentSession() session: VerifiedSession,
    @Param('documentId') documentId: string,
    @Body(zodPipe(documentSectionWriteRequestSchema)) body: DocumentSectionWriteRequest,
  ): Promise<DocumentGranularWriteResponse> {
    return this.edits.writeSection({
      documentId,
      userId: session.userId,
      request: body,
      correlationId: currentCorrelationId(),
      source: 'api',
    });
  }
}
