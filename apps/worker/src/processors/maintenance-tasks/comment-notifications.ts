import { QUEUE_NAMES } from '@exocortex/contracts';
import { type PrismaClient, resolveNotificationMode } from '@exocortex/database';
import { type QueueRegistry } from '@exocortex/queue';

import { collectCommentRecipients, commentPreview } from './comment-recipients';

/**
 * Turns a new comment into the notifications it deserves: a push straight away
 * (issue #30, ADR-048) and, for anybody who asked for it by mail, a pointer
 * the digest sweep will collect (issue #106, ADR-053).
 *
 * It hangs off the outbox for the same reason automations and overview pages
 * do: this is the one place a domain event passes exactly once. A notification
 * written from the request instead would be lost whenever the transaction
 * rolled back after the message had gone -- and the one thing worse than a
 * missing notification is one about a comment that does not exist.
 *
 * Who it concerns is decided once here, by `collectCommentRecipients`, and
 * both channels use that one answer. The mail side deliberately stops at
 * writing a pointer: what the mail says, and whether the person may still read
 * the page when it goes out, are questions for the moment of sending.
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

  const recipients = await collectCommentRecipients(dependencies.prisma, comment);
  if (recipients.size === 0) return;

  const title = `${comment.createdBy.name} hat kommentiert`;
  const body = `${comment.document.title}: ${commentPreview(comment.body)}`;
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

  await recordDigestEntries(dependencies.prisma, comment, [...recipients]);
}

/**
 * Writes one pointer per recipient who wants comment mail at all.
 *
 * Asked before anything is written rather than before anything is sent: `OFF`
 * has to mean that no row exists, or switching the mail off would leave a
 * queue of entries behind that a later switch-on would deliver as a month of
 * history.
 *
 * `IMMEDIATE` and `DAILY_DIGEST` both write the same row. The difference
 * between them is when the sweep considers it due, and nothing else -- which
 * is what lets a burst of replies become one mail in either mode.
 */
async function recordDigestEntries(
  prisma: PrismaClient,
  comment: { id: string; documentId: string; document: { workspaceId: string } },
  recipients: readonly string[],
): Promise<void> {
  const wanted: string[] = [];
  for (const userId of recipients) {
    const mode = await resolveNotificationMode(prisma, userId, 'COMMENT', 'EMAIL');
    if (mode !== 'OFF') wanted.push(userId);
  }
  if (wanted.length === 0) return;

  await prisma.commentDigestEntry.createMany({
    // A redelivered outbox row writes the same rows again; the unique index on
    // (userId, commentId) is what makes that a no-op rather than a second line
    // in somebody's mail.
    skipDuplicates: true,
    data: wanted.map((userId) => ({
      userId,
      commentId: comment.id,
      documentId: comment.documentId,
      workspaceId: comment.document.workspaceId,
    })),
  });
}

function readId(payload: unknown, key: string): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : null;
}
