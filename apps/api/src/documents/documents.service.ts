import { Inject, Injectable } from '@nestjs/common';

import {
  assertPolicy,
  canArchiveDocument,
  canCreateDocument,
  canEditDocument,
  canMoveDocument,
  canMoveDocumentAcrossWorkspaces,
  canReadDocument,
  canReadWorkspace,
  canRestoreDocument,
  type DocumentAccessContext,
  WorkspaceAccessService,
} from '@exocortex/auth';
import {
  type AiRuleListResponse,
  type CreateDocumentRequest,
  DOCUMENT_ICON_COLORS,
  type DocumentDetail,
  type DocumentIconColor,
  type DocumentLinkMatch,
  type DocumentSummary,
  type DocumentTreeNode,
  type DocumentTreeResponse,
  type MoveDocumentRequest,
  QUEUE_NAMES,
  type ResolveDocumentLinkRequest,
  type ResolveDocumentLinkResponse,
  type UpdateDocumentRequest,
} from '@exocortex/contracts';
import {
  buildTree,
  collectAncestors,
  collectDescendantIds,
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
  /** Validated by the contract, so the column is a plain string here. */
  iconColor: string | null;
  layout: 'NARROW' | 'WIDE' | 'FULL';
  coverAttachmentId: string | null;
  coverPosition: number;
  orderKey: string;
  createdById: string;
  updatedById: string;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
}

/** Row shape of the raw `resolveLink` query; a strict subset of `DocumentRow`. */
interface ResolveLinkRow {
  id: string;
  workspaceId: string;
  type: 'PAGE' | 'COLLECTION';
  title: string;
  icon: string | null;
  iconColor: string | null;
  archivedAt: Date | null;
}

/** Exported so every service that hands a row to `toSummary` selects the same columns. */
export const DOCUMENT_SELECT = {
  id: true,
  workspaceId: true,
  parentId: true,
  type: true,
  title: true,
  icon: true,
  iconColor: true,
  layout: true,
  coverAttachmentId: true,
  coverPosition: true,
  orderKey: true,
  createdById: true,
  updatedById: true,
  createdAt: true,
  updatedAt: true,
  archivedAt: true,
} as const;

const AI_RULE_MODE_TO_CONTRACT = {
  OFF: 'off',
  ALWAYS: 'always',
  ON_DEMAND: 'on_demand',
} as const;

const AI_RULE_MODE_TO_DB = {
  off: 'OFF',
  always: 'ALWAYS',
  on_demand: 'ON_DEMAND',
} as const;

const LAYOUT_TO_CONTRACT = {
  NARROW: 'narrow',
  WIDE: 'wide',
  FULL: 'full',
} as const;

const LAYOUT_TO_DB = {
  narrow: 'NARROW',
  wide: 'WIDE',
  full: 'FULL',
} as const;

/**
 * Narrows the free-text colour column to the palette.
 *
 * The column is deliberately not an enum (adding a colour should not cost a
 * migration), so a value from an older palette can survive in a row. Reading it
 * back as "no colour" renders the icon exactly the way every icon rendered
 * before the field existed, which is the harmless outcome.
 */
export function toIconColor(value: string | null): DocumentIconColor | null {
  if (value === null) return null;
  return (DOCUMENT_ICON_COLORS as readonly string[]).includes(value)
    ? (value as DocumentIconColor)
    : null;
}

export function toSummary(row: DocumentRow): DocumentSummary {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    parentId: row.parentId,
    type: row.type,
    title: row.title,
    icon: row.icon,
    iconColor: toIconColor(row.iconColor),
    layout: LAYOUT_TO_CONTRACT[row.layout],
    coverAttachmentId: row.coverAttachmentId,
    coverPosition: row.coverPosition,
    orderKey: row.orderKey,
    createdById: row.createdById,
    updatedById: row.updatedById,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    archivedAt: row.archivedAt === null ? null : row.archivedAt.toISOString(),
  };
}

function toLinkMatch(
  row: ResolveLinkRow,
  path: { id: string; title: string }[],
): DocumentLinkMatch {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    type: row.type,
    title: row.title,
    icon: row.icon,
    iconColor: toIconColor(row.iconColor),
    archivedAt: row.archivedAt === null ? null : row.archivedAt.toISOString(),
    path,
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

  /**
   * Resolves a reference to another page to the document(s) it means,
   * workspace-scoped.
   *
   * Identity first: a `pageLink` block stores the target's `documentId`, and
   * honouring that is what keeps every reference intact when the target is
   * renamed (issue #14). The title is the fallback — for the notations that
   * carry nothing else (`[[Titel]]`, a page mention, a link made before
   * identities existed) and for a target that was deleted and written again
   * under the same name. A reference must not silently vanish, so `resolvedBy`
   * reports which of the two answered.
   *
   * Raw SQL for the title lookup, not `findMany({ title: { equals, mode:
   * 'insensitive' } })`: Prisma translates `insensitive` to `ILIKE` without
   * escaping `%`/`_` in the value, so a page titled e.g. "100%_Plan" would
   * match unrelated titles. `lower` + `regexp_replace` on both sides keeps the
   * comparison exact and predictable.
   */
  async resolveLink(
    workspaceId: string,
    userId: string,
    request: ResolveDocumentLinkRequest,
  ): Promise<ResolveDocumentLinkResponse> {
    await this.access.requireRole(workspaceId, userId);

    const title = (request.title ?? '').trim().replace(/\s+/g, ' ');

    if (request.documentId !== undefined) {
      const byId = await this.prisma.document.findFirst({
        where: {
          id: request.documentId,
          workspaceId,
          ...(request.includeArchived ? {} : { archivedAt: null }),
        },
        select: {
          id: true,
          workspaceId: true,
          type: true,
          title: true,
          icon: true,
          iconColor: true,
          archivedAt: true,
        },
      });
      // The identity is unambiguous by definition, so no path is needed and no
      // second query runs. Only when it no longer names a document does the
      // title get its turn below.
      if (byId !== null) {
        return { title: byId.title, matches: [toLinkMatch(byId, [])], resolvedBy: 'id' };
      }
    }

    if (title.length === 0) return { title, matches: [], resolvedBy: 'none' };

    const rows = await this.prisma.$queryRaw<ResolveLinkRow[]>`
      SELECT "id", "workspaceId", "type", "title", "icon", "iconColor", "archivedAt"
      FROM "document"
      WHERE "workspaceId" = ${workspaceId}
        AND lower(btrim(regexp_replace("title", '\\s+', ' ', 'g'))) = lower(${title})
        AND (${request.includeArchived}::boolean OR "archivedAt" IS NULL)
      ORDER BY ("archivedAt" IS NOT NULL) ASC, "updatedAt" DESC, "id" ASC
      LIMIT ${request.limit}
    `;

    if (rows.length <= 1) {
      return {
        title,
        matches: rows.map((row) => toLinkMatch(row, [])),
        resolvedBy: rows.length === 0 ? 'none' : 'title',
      };
    }

    // Only worth the extra query when the caller actually has to disambiguate.
    const siblings = await this.prisma.document.findMany({
      where: { workspaceId },
      select: { id: true, parentId: true, orderKey: true, title: true },
    });

    return {
      title,
      matches: rows.map((row) =>
        toLinkMatch(
          row,
          collectAncestors(siblings, row.id).map((ancestor) => ({
            id: ancestor.id,
            title: ancestor.title,
          })),
        ),
      ),
      resolvedBy: 'title',
    };
  }

  async getDetail(documentId: string, userId: string): Promise<DocumentDetail> {
    const context = await this.access.requireDocumentContext(documentId, userId);
    assertPolicy(canReadDocument(context.role, context.document, context.workspaceId));

    const [row, content, siblings] = await Promise.all([
      this.prisma.document.findUniqueOrThrow({
        where: { id: documentId },
        select: { ...DOCUMENT_SELECT, aiRuleMode: true, aiRuleTrigger: true, aiRulePriority: true },
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
        },
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
        iconColor: toIconColor(entry.iconColor),
      })),
      materializedAt: content?.materializedAt?.toISOString() ?? null,
      schemaVersion: content?.schemaVersion ?? EXOCORTEX_SCHEMA_VERSION,
      aiRuleMode: AI_RULE_MODE_TO_CONTRACT[row.aiRuleMode],
      aiRuleTrigger: row.aiRuleTrigger,
      aiRulePriority: row.aiRulePriority,
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
          : (
              await this.prisma.document.findUnique({
                where: { id: input.documentId },
                select: { aiRuleTrigger: true },
              })
            )?.aiRuleTrigger ?? null;
      if (effectiveTrigger === null || effectiveTrigger.trim().length === 0) {
        throw AppError.validation(
          'An ON_DEMAND rule page requires a non-empty aiRuleTrigger',
        );
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
      updatedById: userId,
    };
  }

  /**
   * Moves a document. Transactional, cycle-safe and audited.
   *
   * A `workspaceId` in the request that differs from the document's current
   * workspace switches to the cross-workspace path (`moveAcrossWorkspaces`),
   * which carries the whole subtree along instead of re-parenting a single row.
   */
  async move(input: {
    documentId: string;
    userId: string;
    request: MoveDocumentRequest;
    correlationId: string;
  }): Promise<DocumentSummary> {
    const context = await this.access.requireDocumentContext(input.documentId, input.userId);

    const targetWorkspaceId = input.request.workspaceId ?? context.workspaceId;
    if (targetWorkspaceId !== context.workspaceId) {
      return this.moveAcrossWorkspaces({
        documentId: input.documentId,
        userId: input.userId,
        request: input.request,
        correlationId: input.correlationId,
        context,
        targetWorkspaceId,
      });
    }

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

  /**
   * Moves a document's whole subtree into a different workspace.
   *
   * Runs as one transaction, same as the ordinary move. What has to travel
   * along with the documents is deliberate, not "everything with a
   * `workspaceId`" (issue #13):
   *  - `Document` rows of the moved subtree: their `workspaceId` changes.
   *  - `DocumentSearchIndex`: it denormalizes `workspaceId` for its own
   *    `@@index([workspaceId])`, so it has to move even though its `tsvector`
   *    and `plainText` do not change.
   *  - `Attachment`: `workspaceId` is what `canDownloadAttachment` checks, so
   *    leaving it behind would make every file on the moved pages either
   *    inaccessible or governed by the workspace they left.
   *  - `DatabaseProperty`/`DatabaseView`/`DocumentPropertyValue`/
   *    `DocumentEmbedding` carry no `workspaceId` of their own (ADR-011: a
   *    collection and its rows are ordinary `Document`s); they follow through
   *    their `documentId` foreign key alone and need no update here.
   *  - `AiRun`/`AiConversation` deliberately keep their original
   *    `workspaceId`: a run is a record of the workspace the conversation
   *    happened in, not a property of the page it was about. Their
   *    `documentId` reference stays valid (the document still exists), it
   *    just now points across a workspace boundary, which is accepted rather
   *    than "fixed".
   *  - `OutboxEvent`/`AuditLog` history is never rewritten; only the new
   *    audit entries and outbox events this move itself produces are written,
   *    once into each of the two workspaces so both audit trails show it.
   */
  private async moveAcrossWorkspaces(input: {
    documentId: string;
    userId: string;
    request: MoveDocumentRequest;
    correlationId: string;
    context: DocumentAccessContext;
    targetWorkspaceId: string;
  }): Promise<DocumentSummary> {
    const { context, targetWorkspaceId } = input;
    const previousWorkspaceId = context.workspaceId;
    const previousParentId = context.document.parentId;

    const targetRole = await this.access.findRole(targetWorkspaceId, input.userId);
    const targetParent =
      input.request.parentId === null ? null : await this.loadDocumentOrThrow(input.request.parentId);

    assertPolicy(
      canMoveDocumentAcrossWorkspaces(
        context.role,
        context.document,
        targetRole,
        targetParent,
        targetWorkspaceId,
      ),
    );

    const updated = await this.prisma.$transaction(async (tx) => {
      const sourceRows = await tx.document.findMany({
        where: { workspaceId: previousWorkspaceId },
        select: { id: true, parentId: true, orderKey: true },
      });
      const subtreeIds = [...collectDescendantIds(sourceRows, input.documentId)];
      const allIds = [input.documentId, ...subtreeIds];

      const orderKey = await this.resolveOrderKey({
        workspaceId: targetWorkspaceId,
        parentId: input.request.parentId,
        afterSiblingId: input.request.afterSiblingId ?? null,
        beforeSiblingId: input.request.beforeSiblingId ?? null,
        tx,
      });

      // The root of the moved subtree: new workspace, new parent, new order key.
      const document = await tx.document.update({
        where: { id: input.documentId },
        data: {
          workspaceId: targetWorkspaceId,
          parentId: input.request.parentId,
          orderKey,
          updatedById: input.userId,
        },
        select: DOCUMENT_SELECT,
      });

      // The rest of the subtree keeps its internal shape (parentId/orderKey
      // relative to each other never change); only the workspace it belongs
      // to does.
      if (subtreeIds.length > 0) {
        await tx.document.updateMany({
          where: { id: { in: subtreeIds } },
          data: { workspaceId: targetWorkspaceId },
        });
      }

      await tx.documentSearchIndex.updateMany({
        where: { documentId: { in: allIds } },
        data: { workspaceId: targetWorkspaceId },
      });

      await tx.attachment.updateMany({
        where: { documentId: { in: allIds } },
        data: { workspaceId: targetWorkspaceId },
      });

      const auditMetadata = {
        previousParentId,
        nextParentId: input.request.parentId,
        previousWorkspaceId,
        nextWorkspaceId: targetWorkspaceId,
        descendantCount: subtreeIds.length,
      };
      // Written once per affected workspace, so the move shows up in both
      // audit trails -- the source workspace lost the page, the target
      // workspace gained it, and each is entitled to know why.
      await this.outbox.writeAudit(tx, {
        workspaceId: previousWorkspaceId,
        actorId: input.userId,
        action: 'document.moved_workspace',
        targetType: 'document',
        targetId: input.documentId,
        correlationId: input.correlationId,
        metadata: auditMetadata,
      });
      await this.outbox.writeAudit(tx, {
        workspaceId: targetWorkspaceId,
        actorId: input.userId,
        action: 'document.moved_workspace',
        targetType: 'document',
        targetId: input.documentId,
        correlationId: input.correlationId,
        metadata: auditMetadata,
      });
      await this.outbox.writeEvent(tx, {
        workspaceId: previousWorkspaceId,
        type: 'document.moved',
        payload: { documentId: input.documentId },
        correlationId: input.correlationId,
      });
      await this.outbox.writeEvent(tx, {
        workspaceId: targetWorkspaceId,
        type: 'document.moved',
        payload: { documentId: input.documentId },
        correlationId: input.correlationId,
      });

      return document;
    });

    const summary = toSummary(updated);
    // Both workspace rooms get told: the source tree has to drop the page,
    // the target tree has to pick up the whole subtree.
    await this.realtime.emit('document.moved', previousWorkspaceId, input.correlationId, {
      document: summary,
      previousParentId,
    });
    await this.realtime.emit('document.moved', targetWorkspaceId, input.correlationId, {
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
    if (attachment === null || attachment.deletedAt !== null || attachment.workspaceId !== workspaceId) {
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

  /**
   * Active AI rule pages of a workspace (D5), ordered so the system prompt
   * concatenation is deterministic across runs.
   */
  async listAiRules(workspaceId: string, userId: string): Promise<AiRuleListResponse> {
    const role = await this.access.findRole(workspaceId, userId);
    assertPolicy(canReadWorkspace(role));

    const rows = await this.prisma.document.findMany({
      where: { workspaceId, archivedAt: null, aiRuleMode: { not: 'OFF' } },
      select: { id: true, title: true, aiRuleMode: true, aiRuleTrigger: true, aiRulePriority: true },
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
