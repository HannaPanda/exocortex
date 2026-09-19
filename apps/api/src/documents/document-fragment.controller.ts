import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOkResponse, ApiQuery, ApiTags } from '@nestjs/swagger';

import { type VerifiedSession } from '@exocortex/auth';
import {
  type DocumentFragmentRequest,
  documentFragmentRequestSchema,
  type DocumentFragmentResponse,
  documentFragmentResponseSchema,
} from '@exocortex/contracts';

import { CurrentSession } from '../auth/session.guard';
import { openApiResponseSchema, zodPipe } from '../common/zod';

import { DocumentFragmentService } from './document-fragment.service';

/**
 * A piece of a page (issue #78, ADR-045).
 *
 * Its own controller for the reason `DocumentDiffController` is one:
 * `DocumentsController` already carries ten collaborators, and this is a
 * derived view over a page rather than another property of it.
 *
 * Also not a mode of the Markdown export, although it answers with Markdown
 * too: an export is a whole page for a human to keep, this is a fragment cut at
 * a block boundary, and it has an answer the export does not -- "that block is
 * gone".
 */
@ApiTags('documents')
@Controller('api/documents')
export class DocumentFragmentController {
  constructor(private readonly fragments: DocumentFragmentService) {}

  @Get(':documentId/fragment')
  @ApiQuery({ name: 'blockId', required: false })
  @ApiQuery({ name: 'outline', required: false })
  @ApiOkResponse({ schema: openApiResponseSchema(documentFragmentResponseSchema) })
  async fragment(
    @CurrentSession() session: VerifiedSession,
    @Param('documentId') documentId: string,
    @Query(zodPipe(documentFragmentRequestSchema)) query: DocumentFragmentRequest,
  ): Promise<DocumentFragmentResponse> {
    return this.fragments.read(documentId, session.userId, query);
  }
}
