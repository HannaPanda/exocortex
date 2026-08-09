import { Inject, Injectable } from '@nestjs/common';

import {
  assertPolicy,
  canCreateComment,
  canDeleteComment,
  canEditComment,
  canReadComments,
  canResolveComment,
  type DocumentAccessContext,
  WorkspaceAccessService,
} from '@exocortex/auth';
import {
  type Comment,
  COMMENT_ANCHOR_TEXT_MAX_CHARS,
  type CommentListResponse,
  type CommentThread,
  type CreateCommentRequest,
  type DeleteCommentResponse,
  type UpdateCommentRequest,
} from '@exocortex/contracts';
import { type PrismaClient } from '@exocortex/database';
import { type Logger } from '@exocortex/logger';

import { AppError } from '../common/app-error';
import { LOGGER } from '../common/logger.provider';
import { OutboxService } from '../common/outbox.service';
import { PRISMA } from '../platform/platform-tokens';
import { RealtimeService } from '../realtime/realtime.service';

/** Columns every rendered comment is built from. */
const COMMENT_SELECT = {
  id: true,
  documentId: true,
  workspaceId: true,
  parentId: true,
  blockId: true,
  anchorText: true,
  orphanedAt: true,
  body: true,
  createdById: true,
  createdAt: true,
  updatedAt: true,
  editedAt: true,
  resolvedAt: true,
  resolvedById: true,
  createdBy: { select: { id: true, name: true } },
  resolvedBy: { select: { id: true, name: true } },
} as const;

interface CommentRow {
  id: string;
  documentId: string;
  workspaceId: string;
  parentId: string | null;
  blockId: string | null;
  anchorText: string | null;
  orphanedAt: Date | null;
  body: string;
  createdById: string;
  createdAt: Date;
  updatedAt: Date;
  editedAt: Date | null;
  resolvedAt: Date | null;
  resolvedById: string | null;
  createdBy: { id: string; name: string };
  resolvedBy: { id: string; name: string } | null;
}

function toComment(row: CommentRow): Comment {
  return {
    id: row.id,
    documentId: row.documentId,
    parentId: row.parentId,
    blockId: row.blockId,
    anchorText: row.anchorText,
    orphaned: row.orphanedAt !== null,
    body: row.body,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    editedAt: row.editedAt?.toISOString() ?? null,
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    resolvedBy: row.resolvedBy,
  };
}

/**
 * Comments on pages and on individual blocks (issue #18).
 *
 * Three things this service is careful about:
 *
 *  * **Comments are not content.** Nothing here touches the Yjs state or the
 *    collaboration server. A restored snapshot brings back the text of a page,
 *    never a different set of remarks about it.
 *  * **A thread is one level deep.** Replying to a reply attaches to the same
 *    root instead of nesting, which is what keeps the panel renderable and what
 *    makes "resolve the thread" a single, unambiguous action.
 *  * **An anchor is a claim, not a foreign key.** `blockId` names a block that
 *    may be rewritten or deleted at any moment. Deleting it orphans the thread
 *    (the worker sets `orphanedAt`); it never deletes it.
 */
@Injectable()
export class CommentsService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(LOGGER) private readonly logger: Logger,
    private readonly access: WorkspaceAccessService,
    private readonly outbox: OutboxService,
    private readonly realtime: RealtimeService,
  ) {}

  /**
   * Every thread of a page: open ones first, resolved ones after them.
   *
   * Sorting here rather than in the client because the same order has to hold
   * for the MCP tool, which has no client to sort in.
   */
  async list(input: {
    documentId: string;
    userId: string;
    includeResolved: boolean;
  }): Promise<CommentListResponse> {
    const context = await this.access.requireDocumentContext(input.documentId, input.userId);
    assertPolicy(canReadComments(context.role, context.document, context.workspaceId));

    const rows = await this.prisma.comment.findMany({
      where: { documentId: input.documentId },
      orderBy: { createdAt: 'asc' },
      select: COMMENT_SELECT,
    });

    const roots = rows.filter((row) => row.parentId === null);
    const repliesByRoot = new Map<string, CommentRow[]>();
    for (const row of rows) {
      if (row.parentId === null) continue;
      const bucket = repliesByRoot.get(row.parentId);
      if (bucket === undefined) repliesByRoot.set(row.parentId, [row]);
      else bucket.push(row);
    }

    const threads: CommentThread[] = roots.map((root) => ({
      root: toComment(root),
      replies: (repliesByRoot.get(root.id) ?? []).map(toComment),
    }));

    const openCount = threads.filter((thread) => thread.root.resolvedAt === null).length;
    const resolvedCount = threads.length - openCount;

    const visible = input.includeResolved
      ? [
          ...threads.filter((thread) => thread.root.resolvedAt === null),
          ...threads.filter((thread) => thread.root.resolvedAt !== null),
        ]
      : threads.filter((thread) => thread.root.resolvedAt === null);

    return { threads: visible, openCount, resolvedCount };
  }

  async create(input: {
    documentId: string;
    userId: string;
    request: CreateCommentRequest;
    correlationId: string;
  }): Promise<Comment> {
    const context = await this.access.requireDocumentContext(input.documentId, input.userId);
    assertPolicy(canCreateComment(context.role, context.document));

    const parent = await this.resolveParent(input.request.parentId ?? null, input.documentId);

    // A reply inherits the thread's anchor. Letting it carry its own would make
    // "where does this thread sit" a question with several answers.
    const blockId = parent === null ? (input.request.blockId ?? null) : parent.blockId;
    const anchorText =
      parent === null
        ? blockId === null
          ? null
          : (input.request.anchorText?.slice(0, COMMENT_ANCHOR_TEXT_MAX_CHARS) ?? null)
        : parent.anchorText;

    const created = await this.prisma.$transaction(async (tx) => {
      const comment = await tx.comment.create({
        data: {
          workspaceId: context.workspaceId,
          documentId: input.documentId,
          parentId: parent?.id ?? null,
          blockId,
          anchorText,
          body: input.request.body,
          createdById: input.userId,
        },
        select: COMMENT_SELECT,
      });

      // The outbox is what makes a mention notification possible later without
      // re-reading the table (ADR-010); the realtime emit below is the fast,
      // best-effort half.
      await this.outbox.writeEvent(tx, {
        workspaceId: context.workspaceId,
        type: 'comment.created',
        payload: { documentId: input.documentId, commentId: comment.id },
        correlationId: input.correlationId,
      });

      return comment;
    });

    const comment = toComment(created);
    await this.realtime.emit('comment.created', context.workspaceId, input.correlationId, {
      documentId: input.documentId,
      comment,
    });

    this.logger.info('Comment created', {
      commentId: comment.id,
      documentId: input.documentId,
      anchored: blockId !== null,
      reply: parent !== null,
      correlationId: input.correlationId,
    });
    return comment;
  }

  async update(input: {
    commentId: string;
    userId: string;
    request: UpdateCommentRequest;
    correlationId: string;
  }): Promise<Comment> {
    const { row, context } = await this.loadForWrite(input.commentId, input.userId);
    assertPolicy(canEditComment(context.role, context.document, row, input.userId));

    const updated = await this.prisma.comment.update({
      where: { id: input.commentId },
      data: { body: input.request.body, editedAt: new Date() },
      select: COMMENT_SELECT,
    });

    const comment = toComment(updated);
    await this.realtime.emit('comment.updated', context.workspaceId, input.correlationId, {
      documentId: comment.documentId,
      comment,
    });
    return comment;
  }

  /**
   * Resolves or reopens a thread.
   *
   * Only a root can be resolved: a thread is resolved as a whole, and a reply
   * that could be marked done on its own would leave "is this dealt with?" with
   * as many answers as the thread has entries.
   */
  async setResolved(input: {
    commentId: string;
    userId: string;
    resolved: boolean;
    correlationId: string;
  }): Promise<Comment> {
    const { row, context } = await this.loadForWrite(input.commentId, input.userId);
    assertPolicy(canResolveComment(context.role, context.document));

    if (row.parentId !== null) {
      throw AppError.conflict('Only the first comment of a thread can be resolved');
    }

    const updated = await this.prisma.comment.update({
      where: { id: input.commentId },
      data: input.resolved
        ? { resolvedAt: new Date(), resolvedById: input.userId }
        : { resolvedAt: null, resolvedById: null },
      select: COMMENT_SELECT,
    });

    const comment = toComment(updated);
    await this.realtime.emit('comment.resolved', context.workspaceId, input.correlationId, {
      documentId: comment.documentId,
      comment,
    });
    return comment;
  }

  async remove(input: {
    commentId: string;
    userId: string;
    correlationId: string;
  }): Promise<DeleteCommentResponse> {
    const { row, context } = await this.loadForWrite(input.commentId, input.userId);
    assertPolicy(canDeleteComment(context.role, context.document, row, input.userId));

    const removedReplies =
      row.parentId === null
        ? await this.prisma.comment.count({ where: { parentId: row.id } })
        : 0;

    // Replies cascade in the database; counting them first is what lets the
    // answer say how much went away with the root.
    await this.prisma.comment.delete({ where: { id: row.id } });

    await this.realtime.emit('comment.deleted', context.workspaceId, input.correlationId, {
      documentId: row.documentId,
      commentId: row.id,
      threadId: row.parentId ?? row.id,
    });

    this.logger.info('Comment deleted', {
      commentId: row.id,
      documentId: row.documentId,
      removedReplies,
      correlationId: input.correlationId,
    });
    return { deleted: true, removedReplies };
  }

  /**
   * Loads a comment together with the caller's access to the page it sits on.
   *
   * Authorization is the *page's*, never the comment's own: a comment that is
   * not reachable through a readable document must answer as if it did not
   * exist, which is what `requireDocumentContext` does.
   */
  private async loadForWrite(
    commentId: string,
    userId: string,
  ): Promise<{
    row: { id: string; documentId: string; createdById: string; parentId: string | null };
    context: DocumentAccessContext;
  }> {
    const row = await this.prisma.comment.findUnique({
      where: { id: commentId },
      select: { id: true, documentId: true, createdById: true, parentId: true },
    });
    if (row === null) throw AppError.notFound('Comment');
    const context = await this.access.requireDocumentContext(row.documentId, userId);
    return { row, context };
  }

  /** The thread a reply joins, or `null` when a new thread is being opened. */
  private async resolveParent(
    parentId: string | null,
    documentId: string,
  ): Promise<{ id: string; blockId: string | null; anchorText: string | null } | null> {
    if (parentId === null) return null;
    const parent = await this.prisma.comment.findUnique({
      where: { id: parentId },
      select: { id: true, documentId: true, parentId: true, blockId: true, anchorText: true },
    });
    if (parent === null || parent.documentId !== documentId) {
      throw AppError.notFound('Parent comment');
    }
    if (parent.parentId !== null) {
      throw AppError.conflict('Replies are one level deep; reply to the first comment instead');
    }
    return { id: parent.id, blockId: parent.blockId, anchorText: parent.anchorText };
  }
}
