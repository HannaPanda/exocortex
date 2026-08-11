import { Inject, Injectable } from '@nestjs/common';

import {
  assertPolicy,
  canCreateDocument,
  canReadDocument,
  WorkspaceAccessService,
} from '@exocortex/auth';
import {
  DOCUMENT_ICON_COLORS,
  type DocumentSummary,
  type MarkdownExportResponse,
  type MarkdownImportRequest,
  QUEUE_NAMES,
} from '@exocortex/contracts';
import {
  collectAncestors,
  generateOrderKey,
  type Prisma,
  type PrismaClient,
} from '@exocortex/database';
import {
  bindPageLinkIdentities,
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
import { PageLinkIdentityService } from './page-link-identity.service';

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
    private readonly pageLinks: PageLinkIdentityService,
  ) {}

  async export(documentId: string, userId: string): Promise<MarkdownExportResponse> {
    const context = await this.access.requireDocumentContext(documentId, userId);
    assertPolicy(canReadDocument(context.role, context.document, context.workspaceId));

    const [document, content, siblingRows] = await Promise.all([
      this.prisma.document.findUniqueOrThrow({
        where: { id: documentId },
        select: {
          title: true,
          icon: true,
          iconColor: true,
          type: true,
          coverAttachmentId: true,
          coverPosition: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
      this.prisma.documentContent.findUnique({
        where: { documentId },
        select: { yjsState: true, schemaVersion: true },
      }),
      // The page's place in the tree: its ancestors and its child pages. Both
      // are read from the same flat list, which is one query instead of a walk
      // up the chain plus a walk down it.
      this.prisma.document.findMany({
        where: { workspaceId: context.workspaceId },
        select: DOCUMENT_SELECT,
        orderBy: [{ orderKey: 'asc' }, { id: 'asc' }],
      }),
    ]);

    if (content === null) {
      throw AppError.notFound('Document content');
    }

    // `[[Titel]]` is written from the identity a reference stores, not from the
    // label frozen into it when it was made: a file exported after a rename
    // names the target the way it is called now (issue #14).
    const proseMirrorJson = await this.pageLinks.refreshTitles(
      context.workspaceId,
      yjsStateToProseMirrorJson(content.yjsState),
    );
    const markdown = serializeMarkdown(proseMirrorJson, {
      frontmatter: {
        title: document.title,
        icon: document.icon,
        // Only meaningful next to a drawn icon, so it travels with one or not
        // at all, the same way the cover crop travels with the cover.
        iconColor: document.icon === null ? undefined : document.iconColor,
        // The cover is page metadata, not a block, so it travels in the
        // frontmatter (ADR-007). The crop only means something with an image
        // to crop, so it is written alongside it or not at all.
        cover: document.coverAttachmentId,
        coverPosition: document.coverAttachmentId === null ? undefined : document.coverPosition,
        exocortexId: documentId,
        exocortexSchemaVersion: content.schemaVersion,
        type: document.type,
        createdAt: document.createdAt.toISOString(),
        updatedAt: document.updatedAt.toISOString(),
      },
    });

    return {
      documentId,
      filename: filenameFor(document.title),
      markdown,
      path: collectAncestors(siblingRows, documentId).map((row) => ({
        id: row.id,
        title: row.title,
      })),
      children: siblingRows
        .filter((row) => row.parentId === documentId && row.archivedAt === null)
        .map(toSummary),
    };
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

    // The counterpart of the export above: a file says `[[Titel]]`, and the
    // reference it becomes carries the identity of the page that title names,
    // so it survives that page being renamed afterwards.
    const identities = await this.pageLinks.loadIndex(input.workspaceId);

    let imported: ReturnType<typeof markdownToYjsState>;
    try {
      imported = markdownToYjsState(input.request.markdown, {
        transformDocument: (document) =>
          bindPageLinkIdentities(document, (title) => identities.identityFor(title)),
      });
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
    // An unknown colour is dropped rather than stored: the field is free text in
    // the database, and only the palette renders.
    const iconColor =
      typeof imported.frontmatter.iconColor === 'string' &&
      (DOCUMENT_ICON_COLORS as readonly string[]).includes(imported.frontmatter.iconColor)
        ? imported.frontmatter.iconColor
        : null;
    const cover = await this.resolveImportedCover(imported.frontmatter, input.workspaceId);

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
          iconColor,
          ...cover,
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

  /**
   * Turns the `cover` frontmatter key back into a cover, when it can.
   *
   * A file exported here and imported somewhere else names an attachment that
   * deployment never had. That is not an error worth failing an import over:
   * an id that does not resolve to an image of this workspace is dropped and
   * the page arrives without a cover.
   */
  private async resolveImportedCover(
    frontmatter: { cover?: string | null; coverPosition?: number },
    workspaceId: string,
  ): Promise<{ coverAttachmentId: string; coverPosition: number } | Record<string, never>> {
    const cover = frontmatter.cover;
    if (typeof cover !== 'string' || cover.length === 0) return {};

    const attachment = await this.prisma.attachment.findUnique({
      where: { id: cover },
      select: { workspaceId: true, mimeType: true, deletedAt: true },
    });
    if (
      attachment === null ||
      attachment.deletedAt !== null ||
      attachment.workspaceId !== workspaceId ||
      !attachment.mimeType.startsWith('image/')
    ) {
      return {};
    }

    return {
      coverAttachmentId: cover,
      coverPosition: frontmatter.coverPosition ?? 50,
    };
  }
}
