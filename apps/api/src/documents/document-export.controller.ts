import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOkResponse, ApiQuery, ApiTags } from '@nestjs/swagger';

import { type VerifiedSession } from '@exocortex/auth';
import {
  type MarkdownExportRequest,
  markdownExportRequestSchema,
  type MarkdownExportResponse,
  markdownExportResponseSchema,
} from '@exocortex/contracts';

import { CurrentSession } from '../auth/session.guard';
import { openApiResponseSchema, zodPipe } from '../common/zod';

import { AgentReadNoticeService } from './agent-read-notice.service';
import { DocumentMarkdownService } from './document-markdown.service';

/**
 * A whole page as Markdown, which is what `exo_page_read` asks for.
 *
 * Its own controller because `DocumentsController` had reached its limit of
 * collaborators, and this route is the one that needed another: an external
 * agent's read is announced to the knowledge map (issue #189).
 */
@ApiTags('documents')
@Controller('api/documents')
export class DocumentExportController {
  constructor(
    private readonly markdown: DocumentMarkdownService,
    private readonly agentReads: AgentReadNoticeService,
  ) {}

  @Get(':documentId/export/markdown')
  @ApiQuery({ name: 'transclusions', required: false })
  @ApiQuery({ name: 'blockIds', required: false })
  @ApiQuery({ name: 'maxChars', required: false })
  @ApiQuery({ name: 'maxEntries', required: false })
  @ApiOkResponse({ schema: openApiResponseSchema(markdownExportResponseSchema) })
  async exportMarkdown(
    @CurrentSession() session: VerifiedSession,
    @Param('documentId') documentId: string,
    @Query(zodPipe(markdownExportRequestSchema)) query: MarkdownExportRequest,
  ): Promise<MarkdownExportResponse> {
    const exported = await this.markdown.export(documentId, session.userId, query);
    this.agentReads.announce(documentId);
    return exported;
  }
}
