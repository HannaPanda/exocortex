import { QUEUE_NAMES } from '@exocortex/contracts';
import { loadAncestorChain, type PrismaClient } from '@exocortex/database';
import { type QueueRegistry } from '@exocortex/queue';

/**
 * Turns a new comment into a push notification for the people it concerns
 * (issue #30, ADR-048).
 *
 * It hangs off the outbox for the same reason automations and overview pages
 * do: this is the one place a domain event passes exactly once. A notification
 * written from the request instead would be lost whenever the transaction
 * rolled back after the message had gone -- and the one thing worse than a
 * missing notification is one about a comment that does not exist.
 *
 * Who it concerns is answered narrowly on purpose. The author of the page and
 * whoever is already in the thread, and nobody else: a workspace is not a
 * mailing list, and a notification for every comment in it would be switched
 * off within a week, taking the reminders with it.
 */

export interface CommentNotificationDependencies {
  prisma: PrismaClient;
  queues: QueueRegistry;
  appUrl: string;
}

export interface CommentNotificationEvent {
  workspaceId: string;
  type: string;
  payload: unknown;
  correlationId: string;
}

/** How much of the comment travels in the notification body. */
const BODY_PREVIEW_LENGTH = 140;

export async function scheduleCommentNotifications(
  dependencies: CommentNotificationDependencies,
  event: CommentNotificationEvent,
): Promise<void> {
  if (event.type !== 'comment.created') return;
  const commentId = readId(event.payload, 'commentId');
  if (commentId === null) return;

  const comment = await dependencies.prisma.comment.findUnique({
    where: { id: commentId },
    select: {
      id: true,
      body: true,
      documentId: true,
      parentId: true,
      createdById: true,
      createdBy: { select: { name: true } },
      document: { select: { title: true, createdById: true, workspaceId: true } },
    },
  });
  // Deleted between the write and the dispatch. Nothing to announce.
  if (comment === null) return;

  const recipients = await collectRecipients(dependencies.prisma, comment);
  if (recipients.size === 0) return;

  const title = `${comment.createdBy.name} hat kommentiert`;
  const body = `${comment.document.title}: ${preview(comment.body)}`;
  const url = `${dependencies.appUrl.replace(/\/$/, '')}/arbeitsbereich/${comment.document.workspaceId}/seite/${comment.documentId}`;

  for (const userId of recipients) {
    await dependencies.queues.enqueue(QUEUE_NAMES.push, {
      correlationId: event.correlationId,
      userId,
      kind: 'COMMENT',
      notification: {
        title,
        body,
        url,
        // One notification per page rather than per comment: three replies
        // while a phone is in a pocket should be one line on the lock screen,
        // and the newest is the one worth reading.
        tag: `comment:${comment.documentId}`,
      },
    });
  }
}

/**
 * The accounts that should hear about this comment, already filtered by
 * whether they may still read the page.
 *
 * The access check is not belt and braces: a thread survives the withdrawal of
 * the access that created it (ADR-044 revokes a grant without touching
 * history), so the list of people who once wrote here is exactly the list that
 * may contain somebody who no longer belongs.
 */
async function collectRecipients(
  prisma: PrismaClient,
  comment: {
    id: string;
    documentId: string;
    parentId: string | null;
    createdById: string;
    document: { createdById: string; workspaceId: string };
  },
): Promise<Set<string>> {
  const candidates = new Set<string>([comment.document.createdById]);

  // Everybody already in this thread. The root is `parentId` when this comment
  // is a reply and the comment itself when it opens a thread, and one query
  // over both covers the two cases without a branch.
  const threadId = comment.parentId ?? comment.id;
  const thread = await prisma.comment.findMany({
    where: { OR: [{ id: threadId }, { parentId: threadId }] },
    select: { createdById: true },
  });
  for (const entry of thread) candidates.add(entry.createdById);

  // Never oneself. A notification for one's own comment is the fastest way to
  // teach somebody to ignore notifications.
  candidates.delete(comment.createdById);
  if (candidates.size === 0) return candidates;

  const members = await prisma.workspaceMember.findMany({
    where: { workspaceId: comment.document.workspaceId, userId: { in: [...candidates] } },
    select: { userId: true },
  });
  const allowed = new Set(members.map((member) => member.userId));

  const outsiders = [...candidates].filter((userId) => !allowed.has(userId));
  if (outsiders.length > 0) {
    // Somebody who holds a grant on this page rather than on the workspace
    // (issue #83, ADR-044). `SUBTREE` is resolved against the hierarchy here
    // exactly as a request resolves it, because a stored list of ids is the
    // thing that ADR forbids.
    const chain = await loadAncestorChain(prisma, comment.documentId);
    const shares = await prisma.documentShare.findMany({
      where: {
        kind: 'USER',
        granteeId: { in: outsiders },
        revokedAt: null,
        OR: [{ documentId: comment.documentId }, { documentId: { in: chain }, scope: 'SUBTREE' }],
      },
      select: { granteeId: true, expiresAt: true },
    });
    const now = new Date();
    for (const share of shares) {
      if (share.granteeId === null) continue;
      if (share.expiresAt !== null && share.expiresAt <= now) continue;
      allowed.add(share.granteeId);
    }
  }

  return allowed;
}

function preview(body: string): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  return flat.length <= BODY_PREVIEW_LENGTH ? flat : `${flat.slice(0, BODY_PREVIEW_LENGTH - 1)}…`;
}

function readId(payload: unknown, key: string): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : null;
}
