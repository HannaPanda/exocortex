import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBody, ApiOkResponse, ApiTags } from '@nestjs/swagger';

import { type VerifiedSession } from '@exocortex/auth';
import {
  type DocumentDiffRequest,
  documentDiffRequestSchema,
  type DocumentDiffResponse,
  documentDiffResponseSchema,
  type RestoreSnapshotBlocksRequest,
  restoreSnapshotBlocksRequestSchema,
  type RestoreSnapshotBlocksResponse,
  restoreSnapshotBlocksResponseSchema,
} from '@exocortex/contracts';

import { CurrentSession } from '../auth/session.guard';
import { currentCorrelationId } from '../common/correlation';
import { openApiResponseSchema, openApiSchema, zodPipe } from '../common/zod';

import { DocumentDiffService } from './document-diff.service';

/**
 * Comparing two states of a page, and taking single blocks back (issue #77).
 *
 * Its own controller for the reason `DocumentOverviewController` is one:
 * `DocumentsController` already carries ten collaborators, and a comparison is
 * a derived view over two states rather than another property of the page.
 */
@ApiTags('documents')
@Controller('api/documents')
export class DocumentDiffController {
  constructor(private readonly diffs: DocumentDiffService) {}

  /**
   * Compares this snapshot with another one, or with the page as it stands.
   * The two states are ordered by age server-side, so the answer does not
   * depend on which of them the caller put in the path.
   */
  @Get(':documentId/snapshots/:snapshotId/diff')
  @ApiOkResponse({ schema: openApiResponseSchema(documentDiffResponseSchema) })
  async diff(
    @CurrentSession() session: VerifiedSession,
    @Param('documentId') documentId: string,
    @Param('snapshotId') snapshotId: string,
    @Query(zodPipe(documentDiffRequestSchema)) query: DocumentDiffRequest,
  ): Promise<DocumentDiffResponse> {
    return this.diffs.diff({
      documentId,
      snapshotId,
      against: query.against,
      userId: session.userId,
    });
  }

  /**
   * Takes single blocks of a snapshot back into the current content, instead
   * of the whole page. The full restore on `DocumentsController` stays
   * available and unchanged.
   */
  @Post(':documentId/snapshots/:snapshotId/restore-blocks')
  @ApiBody({ schema: openApiSchema(restoreSnapshotBlocksRequestSchema) })
  @ApiOkResponse({ schema: openApiResponseSchema(restoreSnapshotBlocksResponseSchema) })
  async restoreBlocks(
    @CurrentSession() session: VerifiedSession,
    @Param('documentId') documentId: string,
    @Param('snapshotId') snapshotId: string,
    @Body(zodPipe(restoreSnapshotBlocksRequestSchema)) body: RestoreSnapshotBlocksRequest,
  ): Promise<RestoreSnapshotBlocksResponse> {
    return this.diffs.restoreBlocks({
      documentId,
      snapshotId,
      blockIds: body.blockIds,
      userId: session.userId,
      correlationId: currentCorrelationId(),
    });
  }
}
