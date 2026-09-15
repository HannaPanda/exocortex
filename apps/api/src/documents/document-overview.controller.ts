import { Controller, Get, Param, Post } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';

import { type VerifiedSession } from '@exocortex/auth';
import {
  type DocumentOverviewResponse,
  documentOverviewResponseSchema,
  type RefreshDocumentOverviewResponse,
  refreshDocumentOverviewResponseSchema,
} from '@exocortex/contracts';

import { CurrentSession } from '../auth/session.guard';
import { currentCorrelationId } from '../common/correlation';
import { openApiResponseSchema } from '../common/zod';

import { DocumentOverviewService } from './document-overview.service';

/**
 * The overview of a page's sub-pages (issue #53, ADR-028).
 *
 * Its own controller rather than two more methods on `DocumentsController`:
 * that one already holds ten collaborators, and an overview is a derived view
 * beside a page rather than another of its properties.
 */
@ApiTags('documents')
@Controller('api/documents')
export class DocumentOverviewController {
  constructor(private readonly overview: DocumentOverviewService) {}

  /**
   * A read of a derived view, never of the page body. Answers for an ordinary
   * page too, with `mode: 'off'` and no entries, so a client can ask without
   * first knowing what kind of page it has.
   */
  @Get(':documentId/overview')
  @ApiOkResponse({ schema: openApiResponseSchema(documentOverviewResponseSchema) })
  async read(
    @CurrentSession() session: VerifiedSession,
    @Param('documentId') documentId: string,
  ): Promise<DocumentOverviewResponse> {
    return this.overview.read(documentId, session.userId);
  }

  /**
   * Recomposes now. Answers as soon as the job is queued; the text arrives
   * later as `document.overview.updated`.
   */
  @Post(':documentId/overview/refresh')
  @ApiCreatedResponse({ schema: openApiResponseSchema(refreshDocumentOverviewResponseSchema) })
  async refresh(
    @CurrentSession() session: VerifiedSession,
    @Param('documentId') documentId: string,
  ): Promise<RefreshDocumentOverviewResponse> {
    return this.overview.requestRefresh({
      documentId,
      userId: session.userId,
      correlationId: currentCorrelationId(),
    });
  }
}
