import { Inject, Injectable } from '@nestjs/common';

import {
  assertPolicy,
  canArchiveDocument,
  canCreateDocument,
  canEditDocument,
  canMoveDocument,
  canReadDocument,
  canRestoreDocument,
  WorkspaceAccessService,
} from '@exocortex/auth';
import {
  type CreateDocumentRequest,
  type DocumentDetail,
  type DocumentSummary,
  type DocumentTreeNode,
  type DocumentTreeResponse,
  type MoveDocumentRequest,
  QUEUE_NAMES,
  type UpdateDocumentRequest,
} from '@exocortex/contracts';
import {
  buildTree,
  collectAncestors,
  generateOrderKey,
  initialOrderKey,
  type PrismaClient,
  type PrismaTransactionClient,
  wouldCreateCycle,
} from '@exocortex/database';
import { createEmptyYjsState, EXOCORTEX_SCHEMA_VERSION } from '@exocortex/editor';
import { type Logger } from '@exocortex/logger';
import { QueueRegistry } from '@exocortex/queue';

import { AppError } from '../common/app-error';
import { LOGGER } from '../common/logger.provider';
import { OutboxService } from '../common/outbox.service';
import { PRISMA, QUEUES } from '../platform/platform.module';
import { RealtimeService } from '../realtime/realtime.service';

interface DocumentRow {
  id: string;
  workspaceId: string;
  parentId: string | null;
  type: 'PAGE' | 'COLLECTION';
  title: string;
  icon: string | null;
  orderKey: string;
  createdById: string;
  updatedById: string;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
}

const DOCUMENT_SELECT = {
  id: true,
  workspaceId: true,
  parentId: true,
  type: true,
  title: true,
  icon: true,
  orderKey: true,
  createdById: true,
  updatedById: true,
  createdAt: true,
  updatedAt: true,
  archivedAt: true,
} as const;

export function toSummary(row: DocumentRow): DocumentSummary {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    parentId: row.parentId,
    type: row.type,
    title: row.title,
    icon: row.icon,
    orderKey: row.orderKey,
    createdById: row.createdById,
    updatedById: row.updatedById,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    archivedAt: row.archivedAt === null ? null : row.archivedAt.toISOString(),
  };
}

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
    private readonly access: WorkspaceAccessService,
    private readonly outbox: OutboxService,
    private readonly realtime: RealtimeService,
  ) {}

  async getTree(workspaceId: string, userId: string): Promise<DocumentTreeResponse> {
    await this.access.requireRole(workspaceId, userId);

    const rows = await this.prisma.document.findMany({
      where: { workspaceId },
      select: DOCUMENT_SELECT,
      orderBy: [{ orderKey: 'asc' }, { id: 'asc' }],
    });

    const active = rows.filter((row) => row.archivedAt === null);
    const archived = rows.filter((row) => row.archivedAt !== null);

    const toNode = (entry: {
      node: DocumentRow;
      children: { node: DocumentRow; children: unknown[] }[];
    }): DocumentTreeNode => ({
      ...toSummary(entry.node),
      children: entry.children.map((child) =>
        toNode(child as { node: DocumentRow; children: { node: DocumentRow; children: unknown[] }[] }),
      ),
    });

    return {
      nodes: buildTree(active).map((entry) =>
        toNode(entry as unknown as { node: DocumentRow; children: { node: DocumentRow; children: unknown[] }[] }),
      ),
      archived: archived.map(toSummary),
    };
  }

  async getDetail(documentId: string, userId: string): Promise<DocumentDetail> {
    const context = await this.access.requireDocumentContext(documentId, userId);
    assertPolicy(canReadDocument(context.role, context.document, context.workspaceId));

    const [row, content, siblings] = await Promise.all([
      this.prisma.document.findUniqueOrThrow({
        where: { id: documentId },
        select: DOCUMENT_SELECT,
      }),
      this.prisma.documentContent.findUnique({
        where: { documentId },
        select: { materializedAt: true, schemaVersion: true },
      }),
      this.prisma.document.findMany({
        where: { workspaceId: context.workspaceId },
        select: { id: true, parentId: true, orderKey: true, title: true, icon: true },
      }),
    ]);

    const ancestors = collectAncestors(siblings, documentId);

    return {
      ...toSummary(row),
      access: row.archivedAt !== null || context.role === 'GUEST' ? 'read' : 'write',
      breadcrumb: ancestors.map((entry) => ({
        id: entry.id,
        title: entry.title,
        icon: entry.icon,
      })),
      materializedAt: content?.materializedAt?.toISOString() ?? null,
      schemaVersion: content?.schemaVersion ?? EXOCORTEX_SCHEMA_VERSION,
    };
  }

  async create(input: {
    workspaceId: string;
    userId: string;
    request: CreateDocumentRequest;
    correlationId: string;
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

    const orderKey = await this.resolveOrderKey({
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
          orderKey,
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

    const updated = await this.prisma.document.update({
      where: { id: input.documentId },
      data: {
        ...(input.request.title === undefined ? {} : { title: input.request.title }),
        ...(input.request.icon === undefined ? {} : { icon: input.request.icon }),
        updatedById: input.userId,
      },
      select: DOCUMENT_SELECT,
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
    return summary;
  }

  /** Moves a document. Transactional, cycle-safe and audited. */
  async move(input: {
    documentId: string;
    userId: string;
    request: MoveDocumentRequest;
    correlationId: string;
  }): Promise<DocumentSummary> {
    const context = await this.access.requireDocumentContext(input.documentId, input.userId);
    const targetParent =
      input.request.parentId === null ? null : await this.loadDocumentOrThrow(input.request.parentId);

    assertPolicy(canMoveDocument(context.role, context.document, targetParent));

    const previousParentId = context.document.parentId;

    const updated = await this.prisma.$transaction(async (tx) => {
      const siblings = await tx.document.findMany({
        where: { workspaceId: context.workspaceId },
        select: { id: true, parentId: true, orderKey: true },
      });

      if (wouldCreateCycle(siblings, input.documentId, input.request.parentId)) {
        throw new AppError(
          'document_move_cycle',
          'Moving the document there would create a circular hierarchy',
        );
      }

      const orderKey = await this.resolveOrderKey({
        workspaceId: context.workspaceId,
        parentId: input.request.parentId,
        afterSiblingId: input.request.afterSiblingId ?? null,
        beforeSiblingId: input.request.beforeSiblingId ?? null,
        excludeDocumentId: input.documentId,
        tx,
      });

      const document = await tx.document.update({
        where: { id: input.documentId },
        data: { parentId: input.request.parentId, orderKey, updatedById: input.userId },
        select: DOCUMENT_SELECT,
      });

      await this.outbox.writeAudit(tx, {
        workspaceId: context.workspaceId,
        actorId: input.userId,
        action: 'document.moved',
        targetType: 'document',
        targetId: input.documentId,
        correlationId: input.correlationId,
        metadata: {
          previousParentId,
          nextParentId: input.request.parentId,
        },
      });
      await this.outbox.writeEvent(tx, {
        workspaceId: context.workspaceId,
        type: 'document.moved',
        payload: { documentId: input.documentId },
        correlationId: input.correlationId,
      });

      return document;
    });

    const summary = toSummary(updated);
    await this.realtime.emit('document.moved', context.workspaceId, input.correlationId, {
      document: summary,
      previousParentId,
    });
    return summary;
  }

  async archive(input: {
    documentId: string;
    userId: string;
    correlationId: string;
  }): Promise<DocumentSummary> {
    const context = await this.access.requireDocumentContext(input.documentId, input.userId);
    assertPolicy(canArchiveDocument(context.role, context.document));

    const now = new Date();
    const updated = await this.prisma.$transaction(async (tx) => {
      // Archiving a page archives its whole subtree, so no editable page can
      // remain under an archived parent.
      const all = await tx.document.findMany({
        where: { workspaceId: context.workspaceId },
        select: { id: true, parentId: true, orderKey: true },
      });
      const subtree = collectSubtree(all, input.documentId);

      await tx.document.updateMany({
        where: { id: { in: [input.documentId, ...subtree] }, archivedAt: null },
        data: { archivedAt: now, updatedById: input.userId },
      });

      await this.outbox.writeAudit(tx, {
        workspaceId: context.workspaceId,
        actorId: input.userId,
        action: 'document.archived',
        targetType: 'document',
        targetId: input.documentId,
        correlationId: input.correlationId,
        metadata: { descendantCount: subtree.length },
      });
      await this.outbox.writeEvent(tx, {
        workspaceId: context.workspaceId,
        type: 'document.archived',
        payload: { documentId: input.documentId },
        correlationId: input.correlationId,
      });

      return tx.document.findUniqueOrThrow({
        where: { id: input.documentId },
        select: DOCUMENT_SELECT,
      });
    });

    const summary = toSummary(updated);
    await this.realtime.emit('document.archived', context.workspaceId, input.correlationId, {
      document: summary,
    });
    await this.enqueueIndexing(
      input.documentId,
      context.workspaceId,
      'archived',
      input.correlationId,
    );
    return summary;
  }

  async restore(input: {
    documentId: string;
    userId: string;
    correlationId: string;
  }): Promise<DocumentSummary> {
    const context = await this.access.requireDocumentContext(input.documentId, input.userId);
    assertPolicy(canRestoreDocument(context.role, context.document));

    const updated = await this.prisma.$transaction(async (tx) => {
      // A restored page must not end up under an archived parent.
      const parentId = context.document.parentId;
      if (parentId !== null) {
        const parent = await tx.document.findUnique({
          where: { id: parentId },
          select: { archivedAt: true },
        });
        if (parent !== null && parent.archivedAt !== null) {
          await tx.document.update({
            where: { id: input.documentId },
            data: { parentId: null },
          });
        }
      }

      const document = await tx.document.update({
        where: { id: input.documentId },
        data: { archivedAt: null, updatedById: input.userId },
        select: DOCUMENT_SELECT,
      });

      await this.outbox.writeAudit(tx, {
        workspaceId: context.workspaceId,
        actorId: input.userId,
        action: 'document.restored',
        targetType: 'document',
        targetId: input.documentId,
        correlationId: input.correlationId,
      });
      await this.outbox.writeEvent(tx, {
        workspaceId: context.workspaceId,
        type: 'document.restored',
        payload: { documentId: input.documentId },
        correlationId: input.correlationId,
      });

      return document;
    });

    const summary = toSummary(updated);
    await this.realtime.emit('document.restored', context.workspaceId, input.correlationId, {
      document: summary,
    });
    await this.enqueueIndexing(
      input.documentId,
      context.workspaceId,
      'restored',
      input.correlationId,
    );
    return summary;
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
  private async resolveOrderKey(input: {
    workspaceId: string;
    parentId: string | null;
    afterSiblingId: string | null;
    beforeSiblingId: string | null;
    excludeDocumentId?: string;
    tx?: PrismaTransactionClient;
  }): Promise<string> {
    const client = input.tx ?? this.prisma;
    const siblings = await client.document.findMany({
      where: {
        workspaceId: input.workspaceId,
        parentId: input.parentId,
        ...(input.excludeDocumentId === undefined ? {} : { id: { not: input.excludeDocumentId } }),
      },
      select: { id: true, orderKey: true },
      orderBy: [{ orderKey: 'asc' }, { id: 'asc' }],
    });

    if (siblings.length === 0) return initialOrderKey();

    const indexOf = (id: string | null): number =>
      id === null ? -1 : siblings.findIndex((sibling) => sibling.id === id);

    const afterIndex = indexOf(input.afterSiblingId);
    const beforeIndex = indexOf(input.beforeSiblingId);

    if (afterIndex >= 0) {
      const lower = siblings[afterIndex]?.orderKey ?? null;
      const upper = siblings[afterIndex + 1]?.orderKey ?? null;
      return generateOrderKey(lower, upper);
    }
    if (beforeIndex >= 0) {
      const upper = siblings[beforeIndex]?.orderKey ?? null;
      const lower = beforeIndex > 0 ? (siblings[beforeIndex - 1]?.orderKey ?? null) : null;
      return generateOrderKey(lower, upper);
    }

    // Default: append at the end.
    return generateOrderKey(siblings[siblings.length - 1]?.orderKey ?? null, null);
  }

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
}

/** Collects all descendants of a document from a flat list. */
function collectSubtree(
  rows: readonly { id: string; parentId: string | null }[],
  documentId: string,
): string[] {
  const childrenByParent = new Map<string, string[]>();
  for (const row of rows) {
    if (row.parentId === null) continue;
    const list = childrenByParent.get(row.parentId);
    if (list === undefined) childrenByParent.set(row.parentId, [row.id]);
    else list.push(row.id);
  }
  const result: string[] = [];
  const stack = [...(childrenByParent.get(documentId) ?? [])];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    result.push(current);
    stack.push(...(childrenByParent.get(current) ?? []));
  }
  return result;
}
