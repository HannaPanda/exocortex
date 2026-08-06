import { Inject, Injectable } from '@nestjs/common';

import {
  assertPolicy,
  canCreateDocument,
  canReadDocument,
  WorkspaceAccessService,
} from '@exocortex/auth';
import {
  type DocumentSummary,
  type MarkdownExportResponse,
  type MarkdownImportRequest,
  QUEUE_NAMES,
} from '@exocortex/contracts';
import { generateOrderKey, type Prisma, type PrismaClient } from '@exocortex/database';
import {
  EXOCORTEX_SCHEMA_VERSION,
  markdownToYjsState,
  serializeMarkdown,
  yjsStateToProseMirrorJson,
} from '@exocortex/editor';
import { type Logger } from '@exocortex/logger';
import { QueueRegistry } from '@exocortex/queue';

import { AppError } from '../common/app-error';
import { LOGGER } from '../common/logger.provider';
import { OutboxService } from '../common/outbox.service';
import { PRISMA, QUEUES } from '../platform/platform.module';
import { RealtimeService } from '../realtime/realtime.service';

import { DOCUMENT_SELECT, toSummary } from './documents.service';

function filenameFor(title: string): string {
  const base = title
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return `${base.length > 0 ? base : 'seite'}.md`;
}

/**
 * Markdown import and export.
 *
 * Markdown is an interchange format only: an import creates a *new* Yjs-backed
 * document and an export derives Markdown from the canonical Yjs state. There is
 * never a second editable representation (ADR-007).
 */
@Injectable()
export class DocumentMarkdownService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(QUEUES) private readonly queues: QueueRegistry,
    @Inject(LOGGER) private readonly logger: Logger,
    private readonly access: WorkspaceAccessService,
    private readonly outbox: OutboxService,
    private readonly realtime: RealtimeService,
  ) {}

  async export(documentId: string, userId: string): Promise<MarkdownExportResponse> {
    const context = await this.access.requireDocumentContext(documentId, userId);
    assertPolicy(canReadDocument(context.role, context.document, context.workspaceId));

    const [document, content] = await Promise.all([
      this.prisma.document.findUniqueOrThrow({
        where: { id: documentId },
        select: { title: true, icon: true, type: true, createdAt: true, updatedAt: true },
      }),
      this.prisma.documentContent.findUnique({
        where: { documentId },
        select: { yjsState: true, schemaVersion: true },
      }),
    ]);

    if (content === null) {
      throw AppError.notFound('Document content');
    }

    const proseMirrorJson = yjsStateToProseMirrorJson(content.yjsState);
    const markdown = serializeMarkdown(proseMirrorJson, {
      frontmatter: {
        title: document.title,
        icon: document.icon,
        exocortexId: documentId,
        exocortexSchemaVersion: content.schemaVersion,
        type: document.type,
        createdAt: document.createdAt.toISOString(),
        updatedAt: document.updatedAt.toISOString(),
      },
    });

    return { documentId, filename: filenameFor(document.title), markdown };
  }

  /**
   * Imports Markdown as a new document. The parsed content becomes the canonical
   * Yjs state immediately, so the page is collaborative from the first open.
   */
  async import(input: {
    workspaceId: string;
    userId: string;
    request: MarkdownImportRequest;
    correlationId: string;
  }): Promise<DocumentSummary> {
    const role = await this.access.findRole(input.workspaceId, input.userId);
    assertPolicy(canCreateDocument(role));

    const parentId = input.request.parentId ?? null;
    if (parentId !== null) {
      const parent = await this.prisma.document.findUnique({
        where: { id: parentId },
        select: { workspaceId: true, archivedAt: true },
      });
      if (parent === null) throw AppError.notFound('Parent document');
      if (parent.workspaceId !== input.workspaceId) {
        throw new AppError(
          'document_cross_workspace',
          'The parent document belongs to a different workspace',
        );
      }
      if (parent.archivedAt !== null) {
        throw new AppError('document_archived', 'Cannot import into an archived parent');
      }
    }

    let imported: ReturnType<typeof markdownToYjsState>;
    try {
      imported = markdownToYjsState(input.request.markdown);
    } catch (error) {
      this.logger.warn('Markdown import rejected', {
        workspaceId: input.workspaceId,
        correlationId: input.correlationId,
        reason: error instanceof Error ? error.message : String(error),
      });
      throw AppError.validation('The Markdown document could not be parsed');
    }

    const title = input.request.title ?? imported.title ?? 'Importierte Seite';
    const icon = typeof imported.frontmatter.icon === 'string' ? imported.frontmatter.icon : null;

    const lastSibling = await this.prisma.document.findFirst({
      where: { workspaceId: input.workspaceId, parentId },
      orderBy: [{ orderKey: 'desc' }],
      select: { orderKey: true },
    });

    const created = await this.prisma.$transaction(async (tx) => {
      const document = await tx.document.create({
        data: {
          workspaceId: input.workspaceId,
          parentId,
          type: 'PAGE',
          title,
          icon,
          orderKey: generateOrderKey(lastSibling?.orderKey ?? null, null),
          createdById: input.userId,
          updatedById: input.userId,
        },
        select: DOCUMENT_SELECT,
      });

      await tx.documentContent.create({
        data: {
          documentId: document.id,
          yjsState: Buffer.from(imported.yjsState),
          schemaVersion: EXOCORTEX_SCHEMA_VERSION,
          proseMirrorJson: imported.proseMirrorJson as unknown as Prisma.InputJsonObject,
          plainText: imported.plainText,
          markdown: input.request.markdown,
          materializedAt: new Date(),
        },
      });

      // A snapshot of the imported state makes the import undoable.
      await tx.documentSnapshot.create({
        data: {
          documentId: document.id,
          yjsState: Buffer.from(imported.yjsState),
          schemaVersion: EXOCORTEX_SCHEMA_VERSION,
          createdById: input.userId,
          reason: 'IMPORT',
        },
      });

      await this.outbox.writeEvent(tx, {
        workspaceId: input.workspaceId,
        type: 'document.created',
        payload: { documentId: document.id },
        correlationId: input.correlationId,
      });

      return document;
    });

    const summary = toSummary(created);
    await this.realtime.emit('document.created', input.workspaceId, input.correlationId, {
      document: summary,
    });

    // Re-materialize so every derived field is produced by exactly one code path.
    await this.queues.enqueue(QUEUE_NAMES.documentMaterialization, {
      correlationId: input.correlationId,
      documentId: created.id,
      workspaceId: input.workspaceId,
      yjsUpdatedAt: Date.now(),
      reason: 'import',
    });

    this.logger.info('Markdown imported', {
      documentId: created.id,
      workspaceId: input.workspaceId,
      correlationId: input.correlationId,
      byteSize: input.request.markdown.length,
    });

    return summary;
  }
}
