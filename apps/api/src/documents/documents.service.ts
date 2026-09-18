import { Inject, Injectable } from '@nestjs/common';

import {
  assertPolicy,
  canCreateDocument,
  canEditDocument,
  canReadDocument,
  canReadWorkspace,
  WorkspaceAccessService,
} from '@exocortex/auth';
import {
  type AiRuleListResponse,
  type ArchiveDocumentResponse,
  type CreateDocumentRequest,
  type DeleteDocumentsResponse,
  type DocumentDeletionPreview,
  type DocumentDetail,
  type DocumentSummary,
  type MoveDocumentRequest,
  QUEUE_NAMES,
  type UpdateDocumentRequest,
} from '@exocortex/contracts';
import { collectAncestors, type PrismaClient } from '@exocortex/database';
import { createEmptyYjsState, EXOCORTEX_SCHEMA_VERSION } from '@exocortex/editor';
import { type Logger } from '@exocortex/logger';
import { QueueRegistry } from '@exocortex/queue';
import { type ObjectStorage } from '@exocortex/storage';

import { AppError } from '../common/app-error';
import { LOGGER } from '../common/logger.provider';
import { OutboxService } from '../common/outbox.service';
import { OBJECT_STORAGE, PRISMA, QUEUES } from '../platform/platform.module';
import { RealtimeService } from '../realtime/realtime.service';

import { DocumentMoveService } from './document-move.service';
import { resolveOrderKey } from './document-order';
import {
  AI_RULE_MODE_TO_CONTRACT,
  AI_RULE_MODE_TO_DB,
  DOCUMENT_SELECT,
  type DocumentRow,
  LAYOUT_TO_DB,
  OVERVIEW_MODE_TO_DB,
  toIconColor,
  toSummary,
} from './document-shape';
import { DocumentTrashService } from './document-trash.service';

/** Re-exported so the many callers that import them from here keep working. */
export { DOCUMENT_SELECT, toIconColor, toSummary } from './document-shape';

/**
 * Document domain service.
 *
 * All hierarchy rules live here, not in the controller:
 *  * arbitrary nesting with fractional `orderKey` ordering
 *  * cross-workspace parents are rejected
 *  * circular moves are rejected
 *  * archived documents are read-only
 *  * moves run in a single transaction
 *  * destructive operations write an audit entry
 */
@Injectable()
export class DocumentsService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(QUEUES) private readonly queues: QueueRegistry,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    private readonly access: WorkspaceAccessService,
    private readonly outbox: OutboxService,
    private readonly realtime: RealtimeService,
    private readonly trash: DocumentTrashService,
    private readonly moves: DocumentMoveService,
  ) {}

  // Delegated rather than moved outright: `DocumentsService` is what the
  // document controller already holds, and splitting the work is not a reason
  // to make it learn three more names.

  /**
   * Moves a document. Transactional, cycle-safe and audited.
   *
   * A `workspaceId` in the request that differs from the document's current
   * workspace carries the whole subtree into the other workspace instead of
   * re-parenting a single row.
   */
  async move(input: {
    documentId: string;
    userId: string;
    request: MoveDocumentRequest;
    correlationId: string;
  }): Promise<DocumentSummary> {
    return this.moves.move(input);
  }

  async archive(input: {
    documentId: string;
    userId: string;
    correlationId: string;
  }): Promise<ArchiveDocumentResponse> {
    return this.trash.archive(input);
  }

  async restore(input: {
    documentId: string;
    userId: string;
    correlationId: string;
  }): Promise<DocumentSummary> {
    return this.trash.restore(input);
  }

  async previewDeletion(input: {
    documentIds: string[];
    userId: string;
  }): Promise<DocumentDeletionPreview[]> {
    return this.trash.previewDeletion(input);
  }

  async deletePermanently(input: {
    documentIds: string[];
    userId: string;
    correlationId: string;
    /** When given, every document must belong to this workspace. */
    workspaceId?: string;
  }): Promise<DeleteDocumentsResponse> {
    return this.trash.deletePermanently(input);
  }

  async getDetail(documentId: string, userId: string): Promise<DocumentDetail> {
    const context = await this.access.requireDocumentContext(documentId, userId);
    assertPolicy(canReadDocument(context.role, context.document, context.workspaceId));

    const [row, content, siblings] = await Promise.all([
      this.prisma.document.findUniqueOrThrow({
        where: { id: documentId },
        select: {
          ...DOCUMENT_SELECT,
          aiRuleMode: true,
          aiRuleTrigger: true,
          aiRulePriority: true,
          createdBy: { select: { name: true } },
          updatedBy: { select: { name: true } },
        },
      }),
      this.prisma.documentContent.findUnique({
        where: { documentId },
        select: { materializedAt: true, schemaVersion: true },
      }),
      this.prisma.document.findMany({
        where: { workspaceId: context.workspaceId },
        select: {
          id: true,
          parentId: true,
          orderKey: true,
          title: true,
          icon: true,
          iconColor: true,
          type: true,
        },
      }),
    ]);

    const ancestors = collectAncestors(siblings, documentId);
    // The immediate parent's type, read from the workspace-wide list already
    // fetched above rather than a second query: it is what tells the context
    // panel apart a database row (`PAGE` under a `COLLECTION`, ADR-011) from an
    // ordinary sub-page.
    const parentType =
      row.parentId === null
        ? null
        : (siblings.find((entry) => entry.id === row.parentId)?.type ?? null);
    // Only a database itself has rows; the count is one extra query, run only
    // when the question actually applies.
    const rowCount =
      row.type === 'COLLECTION'
        ? await this.prisma.document.count({ where: { parentId: documentId, archivedAt: null } })
        : null;

    return {
      ...toSummary(row),
      access: row.archivedAt !== null || context.role === 'GUEST' ? 'read' : 'write',
      breadcrumb: ancestors.map((entry) => ({
        id: entry.id,
        title: entry.title,
        icon: entry.icon,
        iconColor: toIconColor(entry.iconColor),
      })),
      materializedAt: content?.materializedAt?.toISOString() ?? null,
      schemaVersion: content?.schemaVersion ?? EXOCORTEX_SCHEMA_VERSION,
      aiRuleMode: AI_RULE_MODE_TO_CONTRACT[row.aiRuleMode],
      aiRuleTrigger: row.aiRuleTrigger,
      aiRulePriority: row.aiRulePriority,
      createdByName: row.createdBy.name,
      updatedByName: row.updatedBy.name,
      parentType,
      rowCount,
    };
  }

  async create(input: {
    workspaceId: string;
    userId: string;
    request: CreateDocumentRequest;
    correlationId: string;
    /**
     * Marks the new page as the workspace's inbox (issue #71, ADR-036). A
     * service option rather than a field on the request: the flag is not
     * something a caller of `POST /documents` gets to set, and the inbox is
     * created by exactly one code path, `InboxService`. A second inbox is
     * refused by the partial unique index, which surfaces here as a failed
     * transaction rather than a silent duplicate.
     */
    isInbox?: boolean;
  }): Promise<DocumentSummary> {
    const role = await this.access.findRole(input.workspaceId, input.userId);
    assertPolicy(canCreateDocument(role));

    const parentId = input.request.parentId ?? null;
    if (parentId !== null) {
      const parent = await this.loadDocumentOrThrow(parentId);
      if (parent.workspaceId !== input.workspaceId) {
        throw new AppError(
          'document_cross_workspace',
          'The parent document belongs to a different workspace',
        );
      }
      if (parent.archivedAt !== null) {
        throw new AppError('document_archived', 'Cannot create a page under an archived parent');
      }
    }

    const orderKey = await resolveOrderKey(this.prisma, {
      workspaceId: input.workspaceId,
      parentId,
      afterSiblingId: input.request.afterSiblingId ?? null,
      beforeSiblingId: input.request.beforeSiblingId ?? null,
    });

    const created = await this.prisma.$transaction(async (tx) => {
      const document = await tx.document.create({
        data: {
          workspaceId: input.workspaceId,
          parentId,
          type: input.request.type,
          title: input.request.title,
          icon: input.request.icon ?? null,
          iconColor: input.request.iconColor ?? null,
          // A database is unusable in the reading measure, so it defaults to
          // the full width while a page defaults to the measure.
          layout:
            input.request.layout !== undefined
              ? LAYOUT_TO_DB[input.request.layout]
              : input.request.type === 'COLLECTION'
                ? 'FULL'
                : 'NARROW',
          orderKey,
          isInbox: input.isInbox ?? false,
          createdById: input.userId,
          updatedById: input.userId,
        },
        select: DOCUMENT_SELECT,
      });

      // Every document owns a content row from the start, so the collaboration
      // server always finds canonical Yjs state to load.
      await tx.documentContent.create({
        data: {
          documentId: document.id,
          yjsState: Buffer.from(createEmptyYjsState()),
          schemaVersion: EXOCORTEX_SCHEMA_VERSION,
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
    await this.enqueueIndexing(created.id, input.workspaceId, 'title_changed', input.correlationId);

    this.logger.info('Document created', {
      documentId: created.id,
      workspaceId: input.workspaceId,
      correlationId: input.correlationId,
    });
    return summary;
  }

  async update(input: {
    documentId: string;
    userId: string;
    request: UpdateDocumentRequest;
    correlationId: string;
  }): Promise<DocumentSummary> {
    const context = await this.access.requireDocumentContext(input.documentId, input.userId);
    assertPolicy(canEditDocument(context.role, context.document));

    if (input.request.aiRuleMode === 'on_demand') {
      const effectiveTrigger =
        input.request.aiRuleTrigger !== undefined
          ? input.request.aiRuleTrigger
          : ((
              await this.prisma.document.findUnique({
                where: { id: input.documentId },
                select: { aiRuleTrigger: true },
              })
            )?.aiRuleTrigger ?? null);
      if (effectiveTrigger === null || effectiveTrigger.trim().length === 0) {
        throw AppError.validation('An ON_DEMAND rule page requires a non-empty aiRuleTrigger');
      }
    }

    if (input.request.coverAttachmentId !== undefined && input.request.coverAttachmentId !== null) {
      await this.assertUsableCover(input.request.coverAttachmentId, context.workspaceId);
    }

    const renamed =
      input.request.title !== undefined && input.request.title !== context.document.title;

    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.document.update({
        where: { id: input.documentId },
        data: this.updateData(input.request, input.userId),
        select: DOCUMENT_SELECT,
      });

      // A rename moves a title from one page to another, and every reference
      // written as `[[Titel]]` addresses the title, not the page (issue #19).
      // The reference index therefore has to be re-resolved, and it has to
      // happen reliably, so it goes through the outbox rather than a
      // fire-and-forget call (ADR-010). Written only on an actual rename: an
      // event per icon change would be a storm for nothing.
      if (renamed) {
        await this.outbox.writeEvent(tx, {
          workspaceId: context.workspaceId,
          type: 'document.updated',
          payload: { documentId: input.documentId },
          correlationId: input.correlationId,
        });
        // The title itself has no other history (`Document` only stores the
        // current one), so a rename needs its own audit entry to be
        // reconstructable later (issue #20, the Aktivität tab). Titles are
        // structural metadata, not document content, so this stays within
        // what `AuditLog`'s doc comment allows.
        await this.outbox.writeAudit(tx, {
          workspaceId: context.workspaceId,
          actorId: input.userId,
          action: 'document.renamed',
          targetType: 'document',
          targetId: input.documentId,
          correlationId: input.correlationId,
          metadata: {
            previousTitle: context.document.title,
            nextTitle: input.request.title ?? context.document.title,
          },
        });
      }

      return row;
    });

    const summary = toSummary(updated);
    await this.realtime.emit('document.updated', context.workspaceId, input.correlationId, {
      document: summary,
    });
    if (input.request.title !== undefined) {
      await this.enqueueIndexing(
        input.documentId,
        context.workspaceId,
        'title_changed',
        input.correlationId,
      );
    }
    // Marking a page as an overview is what starts composing it (ADR-028).
    // Without this the page would stay blank until somebody happened to edit
    // one of its children, which is the wrong moment to find out whether the
    // feature works. A repeated request costs one job that finds its input
    // hash unchanged and returns.
    if (input.request.overviewMode === 'auto') {
      await this.queues.enqueue(QUEUE_NAMES.documentOverview, {
        correlationId: input.correlationId,
        documentId: input.documentId,
        workspaceId: context.workspaceId,
        reason: 'marked',
        force: false,
        depth: 0,
      });
    }
    return summary;
  }

  /** Field mapping of `PATCH /documents/:id`. Split out so `update` stays readable. */
  private updateData(request: UpdateDocumentRequest, userId: string) {
    return {
      ...(request.title === undefined ? {} : { title: request.title }),
      ...(request.icon === undefined ? {} : { icon: request.icon }),
      ...(request.iconColor === undefined ? {} : { iconColor: request.iconColor }),
      ...(request.layout === undefined ? {} : { layout: LAYOUT_TO_DB[request.layout] }),
      ...(request.coverAttachmentId === undefined
        ? {}
        : { coverAttachmentId: request.coverAttachmentId }),
      ...(request.coverPosition === undefined ? {} : { coverPosition: request.coverPosition }),
      ...(request.aiRuleMode === undefined
        ? {}
        : { aiRuleMode: AI_RULE_MODE_TO_DB[request.aiRuleMode] }),
      ...(request.aiRuleTrigger === undefined ? {} : { aiRuleTrigger: request.aiRuleTrigger }),
      ...(request.aiRulePriority === undefined ? {} : { aiRulePriority: request.aiRulePriority }),
      ...(request.overviewMode === undefined
        ? {}
        : { overviewMode: OVERVIEW_MODE_TO_DB[request.overviewMode] }),
      updatedById: userId,
    };
  }

  /**
   * A cover has to be an image the workspace actually owns. Without this check
   * the reference alone would leak the existence of another workspace's
   * attachment, and a PDF set as a cover would render as a broken image.
   */
  private async assertUsableCover(attachmentId: string, workspaceId: string): Promise<void> {
    const attachment = await this.prisma.attachment.findUnique({
      where: { id: attachmentId },
      select: { workspaceId: true, mimeType: true, deletedAt: true },
    });
    if (
      attachment === null ||
      attachment.deletedAt !== null ||
      attachment.workspaceId !== workspaceId
    ) {
      throw AppError.notFound('Attachment');
    }
    if (!attachment.mimeType.startsWith('image/')) {
      throw AppError.validation('The cover attachment must be an image');
    }
  }

  async loadDocumentOrThrow(documentId: string): Promise<DocumentRow> {
    const document = await this.prisma.document.findUnique({
      where: { id: documentId },
      select: DOCUMENT_SELECT,
    });
    if (document === null) throw AppError.notFound('Document');
    return document;
  }

  /**
   * Derives the fractional order key for a new position.
   *
   * Clients pass sibling anchors, never a key: the server owns ordering.
   */

  async enqueueIndexing(
    documentId: string,
    workspaceId: string,
    reason: 'materialized' | 'title_changed' | 'archived' | 'restored' | 'deleted' | 'manual',
    correlationId: string,
  ): Promise<void> {
    await this.queues.enqueue(QUEUE_NAMES.searchIndexing, {
      correlationId,
      documentId,
      workspaceId,
      reason,
    });
  }

  /**
   * Active AI rule pages of a workspace (D5), ordered so the system prompt
   * concatenation is deterministic across runs.
   */
  async listAiRules(workspaceId: string, userId: string): Promise<AiRuleListResponse> {
    const role = await this.access.findRole(workspaceId, userId);
    assertPolicy(canReadWorkspace(role));

    const rows = await this.prisma.document.findMany({
      where: { workspaceId, archivedAt: null, aiRuleMode: { not: 'OFF' } },
      select: {
        id: true,
        title: true,
        aiRuleMode: true,
        aiRuleTrigger: true,
        aiRulePriority: true,
      },
      orderBy: [{ aiRulePriority: 'asc' }, { title: 'asc' }],
    });

    return {
      rules: rows.map((row) => ({
        documentId: row.id,
        title: row.title,
        mode: AI_RULE_MODE_TO_CONTRACT[row.aiRuleMode],
        trigger: row.aiRuleTrigger,
        priority: row.aiRulePriority,
      })),
    };
  }
}
