import { Body, Controller, Get, Inject, Param, Patch, Post, Query, Req } from '@nestjs/common';
import {
  ApiBody,
  ApiConsumes,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { type FastifyRequest } from 'fastify';

import { type VerifiedSession } from '@exocortex/auth';
import { type ApiEnv } from '@exocortex/config';
import {
  type AiRuleListResponse,
  aiRuleListResponseSchema,
  type CollaborationTicketResponse,
  collaborationTicketResponseSchema,
  type CreateDocumentRequest,
  createDocumentRequestSchema,
  type CreateSnapshotRequest,
  createSnapshotRequestSchema,
  type DocumentContentWriteRequest,
  documentContentWriteRequestSchema,
  type DocumentContentWriteResponse,
  documentContentWriteResponseSchema,
  type DocumentDetail,
  documentDetailSchema,
  type DocumentLinksResponse,
  documentLinksResponseSchema,
  type DocumentSnapshot,
  type DocumentSnapshotListResponse,
  documentSnapshotListResponseSchema,
  documentSnapshotSchema,
  type DocumentSummary,
  documentSummarySchema,
  type DocumentTreeResponse,
  documentTreeResponseSchema,
  type GenerateDocumentCoverRequest,
  generateDocumentCoverRequestSchema,
  type GenerateDocumentCoverResponse,
  generateDocumentCoverResponseSchema,
  type MarkdownExportResponse,
  markdownExportResponseSchema,
  type MarkdownImportRequest,
  markdownImportRequestSchema,
  type MarkdownImportResponse,
  markdownImportResponseSchema,
  type MoveDocumentRequest,
  moveDocumentRequestSchema,
  type ResolveDocumentLinkRequest,
  resolveDocumentLinkRequestSchema,
  type ResolveDocumentLinkResponse,
  resolveDocumentLinkResponseSchema,
  type UpdateDocumentRequest,
  updateDocumentRequestSchema,
} from '@exocortex/contracts';

import { CurrentSession } from '../auth/session.guard';
import { currentCorrelationId } from '../common/correlation';
import { API_ENV } from '../common/logger.provider';
import { readUploadedFile } from '../common/multipart';
import { openApiResponseSchema, openApiSchema, zodPipe } from '../common/zod';

import { CollaborationTicketService } from './collaboration-ticket.service';
import { DocumentContentService } from './document-content.service';
import { DocumentCoverService } from './document-cover.service';
import { DocumentLinksService } from './document-links.service';
import { DocumentMarkdownService } from './document-markdown.service';
import { DocumentSnapshotService } from './document-snapshot.service';
import { DocumentsService } from './documents.service';

/** Workspace-scoped document routes. */
@ApiTags('documents')
@Controller('api/workspaces/:workspaceId')
export class WorkspaceDocumentsController {
  constructor(
    private readonly documents: DocumentsService,
    private readonly markdown: DocumentMarkdownService,
  ) {}

  @Get('documents/tree')
  @ApiOkResponse({ schema: openApiResponseSchema(documentTreeResponseSchema) })
  async tree(
    @CurrentSession() session: VerifiedSession,
    @Param('workspaceId') workspaceId: string,
  ): Promise<DocumentTreeResponse> {
    return this.documents.getTree(workspaceId, session.userId);
  }

  /**
   * Resolves a `[[Titel]]` / `wiki:Titel` link to the document(s) with exactly
   * that title. Deliberately its own endpoint rather than `/search`: this must
   * be a deterministic exact-title lookup, not a ranked full-text match, and
   * it must not depend on the asynchronous search index.
   *
   * Placed before `:documentId` routes of the sibling controller would be
   * wrong; this route lives here, under the workspace, because `resolve` is
   * not a document id.
   */
  @Get('documents/resolve')
  @ApiQuery({ name: 'title', required: true })
  @ApiQuery({ name: 'includeArchived', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiOkResponse({ schema: openApiResponseSchema(resolveDocumentLinkResponseSchema) })
  async resolveLink(
    @CurrentSession() session: VerifiedSession,
    @Param('workspaceId') workspaceId: string,
    @Query(zodPipe(resolveDocumentLinkRequestSchema)) query: ResolveDocumentLinkRequest,
  ): Promise<ResolveDocumentLinkResponse> {
    return this.documents.resolveLink(workspaceId, session.userId, query);
  }

  @Get('ai-rules')
  @ApiOkResponse({ schema: openApiResponseSchema(aiRuleListResponseSchema) })
  async aiRules(
    @CurrentSession() session: VerifiedSession,
    @Param('workspaceId') workspaceId: string,
  ): Promise<AiRuleListResponse> {
    return this.documents.listAiRules(workspaceId, session.userId);
  }

  @Post('documents')
  @ApiBody({ schema: openApiSchema(createDocumentRequestSchema) })
  @ApiCreatedResponse({ schema: openApiResponseSchema(documentSummarySchema) })
  async create(
    @CurrentSession() session: VerifiedSession,
    @Param('workspaceId') workspaceId: string,
    @Body(zodPipe(createDocumentRequestSchema)) body: CreateDocumentRequest,
  ): Promise<DocumentSummary> {
    return this.documents.create({
      workspaceId,
      userId: session.userId,
      request: body,
      correlationId: currentCorrelationId(),
    });
  }

  @Post('import/markdown')
  @ApiBody({ schema: openApiSchema(markdownImportRequestSchema) })
  @ApiCreatedResponse({ schema: openApiResponseSchema(markdownImportResponseSchema) })
  async importMarkdown(
    @CurrentSession() session: VerifiedSession,
    @Param('workspaceId') workspaceId: string,
    @Body(zodPipe(markdownImportRequestSchema)) body: MarkdownImportRequest,
  ): Promise<MarkdownImportResponse> {
    const document = await this.markdown.import({
      workspaceId,
      userId: session.userId,
      request: body,
      correlationId: currentCorrelationId(),
    });
    return { document };
  }
}

/** Document-scoped routes. The workspace is derived from the document. */
@ApiTags('documents')
@Controller('api/documents')
export class DocumentsController {
  constructor(
    private readonly documents: DocumentsService,
    private readonly markdown: DocumentMarkdownService,
    private readonly snapshots: DocumentSnapshotService,
    private readonly tickets: CollaborationTicketService,
    private readonly content: DocumentContentService,
    private readonly cover: DocumentCoverService,
    private readonly documentLinks: DocumentLinksService,
    @Inject(API_ENV) private readonly env: ApiEnv,
  ) {}

  /**
   * Uploads an image and makes it this page's cover in one call. Setting an
   * attachment that already exists is a `PATCH` on the page instead.
   */
  @Post(':documentId/cover')
  @ApiConsumes('multipart/form-data')
  @ApiCreatedResponse({ schema: openApiResponseSchema(documentSummarySchema) })
  async uploadCover(
    @CurrentSession() session: VerifiedSession,
    @Param('documentId') documentId: string,
    @Req() request: FastifyRequest,
  ): Promise<DocumentSummary> {
    const file = await readUploadedFile(request, this.env.MAX_UPLOAD_BYTES);
    return this.cover.uploadAndSet({
      documentId,
      userId: session.userId,
      filename: file.filename,
      declaredMimeType: file.declaredMimeType,
      body: file.body,
      correlationId: currentCorrelationId(),
    });
  }

  /**
   * Asks the AI to draw this page's cover. Answers as soon as the job is
   * queued; the picture arrives later as a `document.updated` event and the
   * outcome as `document.cover.generated`.
   */
  @Post(':documentId/cover/generate')
  @ApiBody({ schema: openApiSchema(generateDocumentCoverRequestSchema) })
  @ApiCreatedResponse({ schema: openApiResponseSchema(generateDocumentCoverResponseSchema) })
  async generateCover(
    @CurrentSession() session: VerifiedSession,
    @Param('documentId') documentId: string,
    @Body(zodPipe(generateDocumentCoverRequestSchema)) body: GenerateDocumentCoverRequest,
  ): Promise<GenerateDocumentCoverResponse> {
    return this.cover.requestGeneration({
      documentId,
      userId: session.userId,
      prompt: body.prompt,
      correlationId: currentCorrelationId(),
    });
  }

  @Post(':documentId/content')
  @ApiBody({ schema: openApiSchema(documentContentWriteRequestSchema) })
  @ApiOkResponse({ schema: openApiResponseSchema(documentContentWriteResponseSchema) })
  async writeContent(
    @CurrentSession() session: VerifiedSession,
    @Param('documentId') documentId: string,
    @Body(zodPipe(documentContentWriteRequestSchema)) body: DocumentContentWriteRequest,
  ): Promise<DocumentContentWriteResponse> {
    return this.content.write({
      documentId,
      userId: session.userId,
      request: body,
      correlationId: currentCorrelationId(),
      source: 'api',
    });
  }

  /**
   * The reference index for this page: who points at it, and what it points
   * at. Both directions in one answer because the Verweise panel shows both,
   * and a second round trip for the same page would only add latency.
   */
  @Get(':documentId/links')
  @ApiOkResponse({ schema: openApiResponseSchema(documentLinksResponseSchema) })
  async links(
    @CurrentSession() session: VerifiedSession,
    @Param('documentId') documentId: string,
  ): Promise<DocumentLinksResponse> {
    return this.documentLinks.list(documentId, session.userId);
  }

  @Get(':documentId')
  @ApiOkResponse({ schema: openApiResponseSchema(documentDetailSchema) })
  async detail(
    @CurrentSession() session: VerifiedSession,
    @Param('documentId') documentId: string,
  ): Promise<DocumentDetail> {
    return this.documents.getDetail(documentId, session.userId);
  }

  @Patch(':documentId')
  @ApiBody({ schema: openApiSchema(updateDocumentRequestSchema) })
  @ApiOkResponse({ schema: openApiResponseSchema(documentSummarySchema) })
  async update(
    @CurrentSession() session: VerifiedSession,
    @Param('documentId') documentId: string,
    @Body(zodPipe(updateDocumentRequestSchema)) body: UpdateDocumentRequest,
  ): Promise<DocumentSummary> {
    return this.documents.update({
      documentId,
      userId: session.userId,
      request: body,
      correlationId: currentCorrelationId(),
    });
  }

  @Post(':documentId/move')
  @ApiBody({ schema: openApiSchema(moveDocumentRequestSchema) })
  @ApiOkResponse({ schema: openApiResponseSchema(documentSummarySchema) })
  async move(
    @CurrentSession() session: VerifiedSession,
    @Param('documentId') documentId: string,
    @Body(zodPipe(moveDocumentRequestSchema)) body: MoveDocumentRequest,
  ): Promise<DocumentSummary> {
    return this.documents.move({
      documentId,
      userId: session.userId,
      request: body,
      correlationId: currentCorrelationId(),
    });
  }

  @Post(':documentId/archive')
  @ApiOkResponse({ schema: openApiResponseSchema(documentSummarySchema) })
  async archive(
    @CurrentSession() session: VerifiedSession,
    @Param('documentId') documentId: string,
  ): Promise<DocumentSummary> {
    return this.documents.archive({
      documentId,
      userId: session.userId,
      correlationId: currentCorrelationId(),
    });
  }

  @Post(':documentId/restore')
  @ApiOkResponse({ schema: openApiResponseSchema(documentSummarySchema) })
  async restore(
    @CurrentSession() session: VerifiedSession,
    @Param('documentId') documentId: string,
  ): Promise<DocumentSummary> {
    return this.documents.restore({
      documentId,
      userId: session.userId,
      correlationId: currentCorrelationId(),
    });
  }

  @Post(':documentId/collaboration-ticket')
  @ApiCreatedResponse({ schema: openApiResponseSchema(collaborationTicketResponseSchema) })
  async collaborationTicket(
    @CurrentSession() session: VerifiedSession,
    @Param('documentId') documentId: string,
  ): Promise<CollaborationTicketResponse> {
    return this.tickets.issue(documentId, session.userId);
  }

  @Get(':documentId/export/markdown')
  @ApiOkResponse({ schema: openApiResponseSchema(markdownExportResponseSchema) })
  async exportMarkdown(
    @CurrentSession() session: VerifiedSession,
    @Param('documentId') documentId: string,
  ): Promise<MarkdownExportResponse> {
    return this.markdown.export(documentId, session.userId);
  }

  @Get(':documentId/snapshots')
  @ApiOkResponse({ schema: openApiResponseSchema(documentSnapshotListResponseSchema) })
  async listSnapshots(
    @CurrentSession() session: VerifiedSession,
    @Param('documentId') documentId: string,
  ): Promise<DocumentSnapshotListResponse> {
    return { snapshots: await this.snapshots.list(documentId, session.userId) };
  }

  @Post(':documentId/snapshots')
  @ApiBody({ schema: openApiSchema(createSnapshotRequestSchema) })
  @ApiCreatedResponse({ schema: openApiResponseSchema(documentSnapshotSchema) })
  async createSnapshot(
    @CurrentSession() session: VerifiedSession,
    @Param('documentId') documentId: string,
    @Body(zodPipe(createSnapshotRequestSchema)) body: CreateSnapshotRequest,
  ): Promise<DocumentSnapshot> {
    return this.snapshots.create({
      documentId,
      userId: session.userId,
      reason: body.reason,
    });
  }

  @Post(':documentId/snapshots/:snapshotId/restore')
  @ApiOkResponse({ description: 'Snapshot restored' })
  async restoreSnapshot(
    @CurrentSession() session: VerifiedSession,
    @Param('snapshotId') snapshotId: string,
  ): Promise<{ documentId: string; restoredFrom: string }> {
    return this.snapshots.restore({
      snapshotId,
      userId: session.userId,
      correlationId: currentCorrelationId(),
    });
  }
}
