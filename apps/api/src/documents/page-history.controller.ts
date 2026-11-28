import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';

import { type VerifiedSession } from '@exocortex/auth';
import {
  type PageHistoryQuery,
  pageHistoryQuerySchema,
  type PageHistoryResponse,
  pageHistoryResponseSchema,
  snapshotContentQuerySchema,
  type SnapshotContentResponse,
  snapshotContentResponseSchema,
} from '@exocortex/contracts';

import { CurrentSession } from '../auth/session.guard';
import { openApiResponseSchema, zodPipe } from '../common/zod';

import { PageHistoryService } from './page-history.service';

/**
 * The page history (issue #235): the versions of one page with their authors,
 * grouped, and any one of them read back. Restoring and comparing keep their
 * routes on `DocumentsController` and `DocumentDiffController`.
 */
@ApiTags('documents')
@Controller('api/documents')
export class PageHistoryController {
  constructor(private readonly history: PageHistoryService) {}

  @Get(':documentId/history')
  @ApiOkResponse({ schema: openApiResponseSchema(pageHistoryResponseSchema) })
  async list(
    @CurrentSession() session: VerifiedSession,
    @Param('documentId') documentId: string,
    @Query(zodPipe(pageHistoryQuerySchema)) query: PageHistoryQuery,
  ): Promise<PageHistoryResponse> {
    return this.history.history({
      documentId,
      userId: session.userId,
      before: query.before,
      limit: query.limit,
    });
  }

  @Get(':documentId/snapshots/:snapshotId')
  @ApiOkResponse({ schema: openApiResponseSchema(snapshotContentResponseSchema) })
  async read(
    @CurrentSession() session: VerifiedSession,
    @Param('documentId') documentId: string,
    @Param('snapshotId') snapshotId: string,
    @Query(zodPipe(snapshotContentQuerySchema))
    query: { maxChars?: number; content: boolean },
  ): Promise<SnapshotContentResponse> {
    return this.history.read({
      documentId,
      snapshotId,
      userId: session.userId,
      maxChars: query.maxChars,
      withContent: query.content,
    });
  }
}
