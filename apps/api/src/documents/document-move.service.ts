import { Inject, Injectable } from '@nestjs/common';

import {
  assertPolicy,
  canMoveDocument,
  canMoveDocumentAcrossWorkspaces,
  type DocumentAccessContext,
  WorkspaceAccessService,
} from '@exocortex/auth';
import { type DocumentSummary, type MoveDocumentRequest, QUEUE_NAMES } from '@exocortex/contracts';
import {
  collectDescendantIds,
  loadAncestorChain,
  type PrismaClient,
  wouldCreateCycle,
} from '@exocortex/database';
import { type Logger } from '@exocortex/logger';
import { QueueRegistry } from '@exocortex/queue';

import { AppError } from '../common/app-error';
import { LOGGER } from '../common/logger.provider';
import { OutboxService } from '../common/outbox.service';
import { PRISMA, QUEUES } from '../platform/platform.module';
import { RealtimeService } from '../realtime/realtime.service';

import { resolveOrderKey } from './document-order';
import { DOCUMENT_SELECT, type DocumentRow, toSummary } from './document-shape';

/**
 * Moving a page, within a workspace and across one.
 *
 * The two are the same request and almost nothing else: re-parenting a row is
 * one update, while carrying a page into another workspace has to take its
 * whole subtree and every row that names the workspace with it. Keeping them
 * side by side is what makes it visible that the second is not a variant of
 * the first.
 */
@Injectable()
export class DocumentMoveService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(QUEUES) private readonly queues: QueueRegistry,
    @Inject(LOGGER) private readonly logger: Logger,
    private readonly access: WorkspaceAccessService,
    private readonly outbox: OutboxService,
    private readonly realtime: RealtimeService,
  ) {}

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
      input.request.parentId === null
        ? null
        : await this.loadDocumentOrThrow(input.request.parentId);

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

      const orderKey = await resolveOrderKey(this.prisma, {
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
    // A subtree share is resolved against the hierarchy at request time, so a
    // move silently changes who may reach this page (issue #83, ADR-044). HTTP
    // notices on the next call; an open collaboration socket makes no next
    // call, so everybody who held a grant anywhere along the old chain or the
    // new one is re-authorized from scratch (ADR-029).
    await this.announceShareChange(
      [previousParentId, input.request.parentId, input.documentId],
      context.workspaceId,
      input.correlationId,
    );
    return summary;
  }

  /**
   * Tells the holders of subtree grants above these pages that their access
   * may have changed.
   *
   * Deliberately generous: it re-authorizes a few connections that did not
   * have to be, and re-authorizing costs a handshake. The opposite mistake
   * costs somebody a socket into a page they were moved out of.
   */
  private async announceShareChange(
    anchors: readonly (string | null)[],
    workspaceId: string,
    correlationId: string,
  ): Promise<void> {
    const chains = await Promise.all(
      anchors
        .filter((id): id is string => id !== null)
        .map(async (id) => loadAncestorChain(this.prisma, id)),
    );
    const ids = [...new Set(chains.flat())];
    if (ids.length === 0) return;

    const grants = await this.prisma.documentShare.findMany({
      where: { documentId: { in: ids }, kind: 'USER', revokedAt: null, granteeId: { not: null } },
      select: { granteeId: true },
    });
    const grantees = [
      ...new Set(grants.map((grant) => grant.granteeId).filter((id): id is string => id !== null)),
    ];
    for (const granteeId of grantees) {
      await this.realtime.revoke({
        userId: granteeId,
        workspaceId,
        reason: 'document_share_changed',
        correlationId,
      });
    }
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
      input.request.parentId === null
        ? null
        : await this.loadDocumentOrThrow(input.request.parentId);

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

      const orderKey = await resolveOrderKey(this.prisma, {
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
  private async loadDocumentOrThrow(documentId: string): Promise<DocumentRow> {
    const document = await this.prisma.document.findUnique({
      where: { id: documentId },
      select: DOCUMENT_SELECT,
    });
    if (document === null) throw AppError.notFound('Document');
    return document;
  }

  private async enqueueIndexing(
    documentId: string,
    workspaceId: string,
    reason: 'title_changed',
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
