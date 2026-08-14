import { Inject, Injectable } from '@nestjs/common';

import {
  assertPolicy,
  canArchiveDocument,
  canDeleteDocument,
  canReadWorkspace,
  canRestoreDocument,
  WorkspaceAccessService,
} from '@exocortex/auth';
import {
  type ArchiveDocumentResponse,
  type DeleteDocumentsResponse,
  type DocumentDeletionPreview,
  type DocumentSummary,
  QUEUE_NAMES,
  type TrashEntry,
  type TrashResponse,
} from '@exocortex/contracts';
import { type PrismaClient } from '@exocortex/database';
import { type Logger } from '@exocortex/logger';
import { QueueRegistry } from '@exocortex/queue';
import { type ObjectStorage } from '@exocortex/storage';

import { AppError } from '../common/app-error';
import { LOGGER } from '../common/logger.provider';
import { OutboxService } from '../common/outbox.service';
import { OBJECT_STORAGE, PRISMA, QUEUES } from '../platform/platform.module';
import { RealtimeService } from '../realtime/realtime.service';

import { collectSubtree, DOCUMENT_SELECT, type DocumentRow, toSummary } from './document-shape';

/**
 * Leaving the tree and coming back: archiving, the trash, and deletion.
 *
 * Split out of `DocumentsService` because it is the half that is about a page
 * ceasing to be part of the workspace, and because four of its five operations
 * touch a whole subtree rather than one row.
 */
@Injectable()
export class DocumentTrashService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(QUEUES) private readonly queues: QueueRegistry,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    private readonly access: WorkspaceAccessService,
    private readonly outbox: OutboxService,
    private readonly realtime: RealtimeService,
  ) {}

  /**
   * Moves a page and everything under it into the trash.
   *
   * The descendants are reported back, not just counted: the caller may be an
   * agent with no sidebar to watch, and an answer that names only the page the
   * caller asked about reads like one page was archived when it was eight. A
   * page that was already in the trash is not listed — it did not move.
   */
  async archive(input: {
    documentId: string;
    userId: string;
    correlationId: string;
  }): Promise<ArchiveDocumentResponse> {
    const context = await this.access.requireDocumentContext(input.documentId, input.userId);
    assertPolicy(canArchiveDocument(context.role, context.document));

    const now = new Date();
    const { updated, descendants } = await this.prisma.$transaction(async (tx) => {
      // Archiving a page archives its whole subtree, so no editable page can
      // remain under an archived parent.
      const all = await tx.document.findMany({
        where: { workspaceId: context.workspaceId },
        select: { id: true, parentId: true, orderKey: true },
      });
      const subtree = collectSubtree(all, input.documentId);

      // Read before the update: afterwards every one of them carries the same
      // `archivedAt` and the ones that were already in the trash are
      // indistinguishable from the ones this call put there.
      const moving = await tx.document.findMany({
        where: { id: { in: subtree }, archivedAt: null },
        select: DOCUMENT_SELECT,
        orderBy: [{ orderKey: 'asc' }, { id: 'asc' }],
      });

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

      return {
        updated: await tx.document.findUniqueOrThrow({
          where: { id: input.documentId },
          select: DOCUMENT_SELECT,
        }),
        descendants: moving,
      };
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
    // The descendants left the active tree too, so their index entries have to
    // follow; otherwise search keeps answering with pages that are in the trash.
    for (const descendant of descendants) {
      await this.enqueueIndexing(
        descendant.id,
        context.workspaceId,
        'archived',
        input.correlationId,
      );
    }
    return {
      ...summary,
      archivedDescendants: descendants.map((row) => toSummary({ ...row, archivedAt: now })),
    };
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
   * The trash, with its shape intact (issue #32).
   *
   * The tree endpoint hands archived pages back as one flat list, which is
   * enough to restore a page you can name and useless for deciding what may go
   * for good: it answers neither "did anything hang under this" nor "did I
   * throw this away or did it just come along". Both answers are already in the
   * data -- `parentId` survives archiving, and one archive operation stamps
   * every page it takes with the same `archivedAt` -- so this is a view, not a
   * new record.
   */
  async getTrash(workspaceId: string, userId: string): Promise<TrashResponse> {
    const role = await this.access.findRole(workspaceId, userId);
    assertPolicy(canReadWorkspace(role));

    const rows = await this.prisma.document.findMany({
      where: { workspaceId, archivedAt: { not: null } },
      select: DOCUMENT_SELECT,
      orderBy: [{ orderKey: 'asc' }, { id: 'asc' }],
    });

    const byId = new Map(rows.map((row) => [row.id, row]));
    const childrenByParent = new Map<string, DocumentRow[]>();
    const roots: DocumentRow[] = [];
    for (const row of rows) {
      // A parent that is *not* in the trash makes this row a root of the trash,
      // even though it has a parent in the tree. That is the page somebody
      // archived; everything under it came along.
      const parent = row.parentId === null ? undefined : byId.get(row.parentId);
      if (parent === undefined) {
        roots.push(row);
        continue;
      }
      const siblings = childrenByParent.get(parent.id);
      if (siblings === undefined) childrenByParent.set(parent.id, [row]);
      else siblings.push(row);
    }

    const toEntry = (row: DocumentRow): TrashEntry => {
      const children = (childrenByParent.get(row.id) ?? []).map(toEntry);
      const archivedAt = row.archivedAt as Date;
      const parent = row.parentId === null ? undefined : byId.get(row.parentId);
      return {
        ...toSummary(row),
        archivedAt: archivedAt.toISOString(),
        // Same instant as the page above it means the same operation took both.
        // A page archived on its own and only later joined by its parent keeps
        // `direct`, because it *was* chosen once.
        reason:
          parent !== undefined && parent.archivedAt?.getTime() === archivedAt.getTime()
            ? 'cascade'
            : 'direct',
        descendantCount: children.reduce(
          (total, child) => total + child.descendantCount + 1,
          0,
        ),
        children,
      };
    };

    const entries = roots
      .map(toEntry)
      .sort((a, b) =>
        a.archivedAt === b.archivedAt
          ? a.title.localeCompare(b.title, 'de')
          : b.archivedAt.localeCompare(a.archivedAt),
      );

    return { entries, totalCount: rows.length };
  }

  /**
   * What deleting these pages for good would take with it.
   *
   * Deliberately its own call rather than a number computed by whoever renders
   * the dialog: the same sentence has to reach a human reading a confirmation
   * and an agent reading back what it is about to do (`exo_page_delete`), and
   * only the server can count the subtree, the files and the references.
   */
  async previewDeletion(input: {
    documentIds: string[];
    userId: string;
  }): Promise<DocumentDeletionPreview[]> {
    const previews: DocumentDeletionPreview[] = [];
    for (const documentId of input.documentIds) {
      const context = await this.access.requireDocumentContext(documentId, input.userId);
      assertPolicy(canDeleteDocument(context.role, context.document));
      const scope = await this.collectDeletionScope(context.workspaceId, [documentId]);
      previews.push({
        documentId,
        title: context.document.title,
        documents: scope.documents.map(toSummary),
        descendantCount: scope.documents.length - 1,
        attachmentCount: scope.attachments.length,
        incomingLinkCount: scope.incomingLinkCount,
      });
    }
    return previews;
  }

  /**
   * Deletes archived pages for good (issue #31).
   *
   * The one irreversible operation in the application. Everything that hangs
   * off a deleted page goes with it through the foreign keys: content, the Yjs
   * state, snapshots, the search projection, embeddings, comments, property
   * values and the definitions of a database. Two things deliberately do not
   * cascade: references *to* the page become unresolved instead of vanishing
   * (the reader lands on "not found" rather than on a link that was silently
   * rewritten), and the stored files are removed by hand after the transaction
   * commits, because object storage has no transaction to join.
   */
  async deletePermanently(input: {
    documentIds: string[];
    userId: string;
    correlationId: string;
    /** When given, every document must belong to this workspace. */
    workspaceId?: string;
  }): Promise<DeleteDocumentsResponse> {
    if (input.documentIds.length === 0) {
      throw AppError.validation('No documents to delete');
    }

    let workspaceId: string | null = input.workspaceId ?? null;
    const titles = new Map<string, string>();
    for (const documentId of input.documentIds) {
      const context = await this.access.requireDocumentContext(documentId, input.userId);
      assertPolicy(canDeleteDocument(context.role, context.document));
      if (workspaceId === null) workspaceId = context.workspaceId;
      else if (context.workspaceId !== workspaceId) {
        throw new AppError(
          'document_cross_workspace',
          'One deletion cannot span two workspaces',
        );
      }
      titles.set(documentId, context.document.title);
    }
    const scopeWorkspaceId = workspaceId as string;

    const scope = await this.collectDeletionScope(scopeWorkspaceId, input.documentIds);
    const deletedIds = scope.documents.map((row) => row.id);

    await this.prisma.$transaction(async (tx) => {
      // Before the documents: the rows would otherwise survive with a dangling
      // `documentId` (the relation is SetNull), and nothing would ever collect
      // the objects they point at.
      if (scope.attachments.length > 0) {
        await tx.attachment.deleteMany({
          where: { id: { in: scope.attachments.map((attachment) => attachment.id) } },
        });
      }

      await tx.document.deleteMany({ where: { id: { in: deletedIds } } });

      for (const documentId of input.documentIds) {
        await this.outbox.writeAudit(tx, {
          workspaceId: scopeWorkspaceId,
          actorId: input.userId,
          action: 'document.deleted',
          targetType: 'document',
          targetId: documentId,
          correlationId: input.correlationId,
          metadata: {
            title: titles.get(documentId) ?? null,
            deletedCount: deletedIds.length,
            attachmentCount: scope.attachments.length,
          },
        });
      }
      await this.outbox.writeEvent(tx, {
        workspaceId: scopeWorkspaceId,
        type: 'document.deleted',
        payload: { documentId: input.documentIds[0] as string, documentIds: deletedIds },
        correlationId: input.correlationId,
      });
    });

    for (const attachment of scope.attachments) {
      const keys = [attachment.storageKey, attachment.previewKey].filter(
        (key): key is string => key !== null,
      );
      for (const key of keys) {
        try {
          await this.storage.deleteObject({ key });
        } catch (error) {
          // The rows are gone either way. A file left behind costs disk space,
          // which the orphan sweep in the maintenance job is there for; failing
          // the deletion here would leave the caller unable to finish something
          // that has already happened.
          this.logger.error('Failed to delete a stored object of a deleted page', error, {
            attachmentId: attachment.id,
            storageKey: key,
            correlationId: input.correlationId,
          });
        }
      }
    }

    await this.realtime.emit('document.deleted', scopeWorkspaceId, input.correlationId, {
      documentId: input.documentIds[0] as string,
      documentIds: deletedIds,
    });

    return {
      deletedIds,
      deletedCount: deletedIds.length,
      attachmentCount: scope.attachments.length,
      unresolvedLinkCount: scope.incomingLinkCount,
    };
  }

  /**
   * Everything a deletion of `documentIds` would touch: the pages themselves
   * with their subtrees, the files hanging off them, and the references from
   * pages that stay.
   */
  private async collectDeletionScope(
    workspaceId: string,
    documentIds: string[],
  ): Promise<{
    documents: DocumentRow[];
    attachments: { id: string; storageKey: string; previewKey: string | null }[];
    incomingLinkCount: number;
  }> {
    const all = await this.prisma.document.findMany({
      where: { workspaceId },
      select: { id: true, parentId: true },
    });

    const ids = new Set<string>();
    for (const documentId of documentIds) {
      ids.add(documentId);
      for (const descendant of collectSubtree(all, documentId)) ids.add(descendant);
    }

    const documents = await this.prisma.document.findMany({
      where: { id: { in: [...ids] } },
      select: DOCUMENT_SELECT,
      orderBy: [{ orderKey: 'asc' }, { id: 'asc' }],
    });
    // The page the caller named first, then everything that comes along -- the
    // order the confirmation is read in.
    const requested = new Set(documentIds);
    documents.sort((a, b) => Number(requested.has(b.id)) - Number(requested.has(a.id)));

    const attachments = await this.prisma.attachment.findMany({
      where: { documentId: { in: [...ids] } },
      select: { id: true, storageKey: true, previewKey: true },
    });

    const incomingLinkCount = await this.prisma.documentLink.count({
      where: { targetDocumentId: { in: [...ids] }, sourceDocumentId: { notIn: [...ids] } },
    });

    return { documents, attachments, incomingLinkCount };
  }
  private async enqueueIndexing(
    documentId: string,
    workspaceId: string,
    reason: 'archived' | 'restored' | 'deleted',
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
