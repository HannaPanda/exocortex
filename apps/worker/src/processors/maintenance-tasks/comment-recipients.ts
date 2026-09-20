import { loadAncestorChain, type PrismaClient } from '@exocortex/database';

/**
 * Who a comment concerns, and who of them may still read the page.
 *
 * One module because two senders ask (issue #106). The push notification asks
 * once, when the outbox passes the comment; the mail digest asks again, when
 * it is about to write to somebody, possibly a day later. A copy in each would
 * be two answers to the question "may this person see this", and the one that
 * forgot a case would be the one that leaked a page.
 *
 * The two halves are separate functions rather than one, because they are
 * asked at different moments and about different things. Who is in a thread is
 * a fact about the comment and does not change; who may read the page is a
 * fact about now, and is the reason the digest re-checks at all.
 */

/** Enough of a comment to say who it concerns. */
export interface CommentForRecipients {
  id: string;
  documentId: string;
  parentId: string | null;
  createdById: string;
  document: { createdById: string; workspaceId: string };
}

/**
 * The accounts this comment concerns, already filtered by whether they may
 * still read the page.
 *
 * Who it concerns is answered narrowly on purpose: the author of the page and
 * whoever is already in the thread, and nobody else. A workspace is not a
 * mailing list, and a notification for every comment in it would be switched
 * off within a week, taking the reminders with it.
 */
export async function collectCommentRecipients(
  prisma: PrismaClient,
  comment: CommentForRecipients,
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

  return filterUsersWithPageAccess(prisma, {
    documentId: comment.documentId,
    workspaceId: comment.document.workspaceId,
    userIds: [...candidates],
  });
}

/**
 * The subset of `userIds` that may read this page right now.
 *
 * The check is not belt and braces: a thread survives the withdrawal of the
 * access that created it (ADR-044 revokes a grant without touching history),
 * so the list of people who once wrote here is exactly the list that may
 * contain somebody who no longer belongs. It is asked again before a digest
 * goes out for the same reason, one day later.
 */
export async function filterUsersWithPageAccess(
  prisma: PrismaClient,
  input: { documentId: string; workspaceId: string; userIds: readonly string[] },
): Promise<Set<string>> {
  if (input.userIds.length === 0) return new Set();

  const members = await prisma.workspaceMember.findMany({
    where: { workspaceId: input.workspaceId, userId: { in: [...input.userIds] } },
    select: { userId: true },
  });
  const allowed = new Set(members.map((member) => member.userId));

  const outsiders = input.userIds.filter((userId) => !allowed.has(userId));
  if (outsiders.length === 0) return allowed;

  // Somebody who holds a grant on this page rather than on the workspace
  // (issue #83, ADR-044). `SUBTREE` is resolved against the hierarchy here
  // exactly as a request resolves it, because a stored list of ids is the
  // thing that ADR forbids.
  const chain = await loadAncestorChain(prisma, input.documentId);
  const shares = await prisma.documentShare.findMany({
    where: {
      kind: 'USER',
      granteeId: { in: outsiders },
      revokedAt: null,
      OR: [{ documentId: input.documentId }, { documentId: { in: chain }, scope: 'SUBTREE' }],
    },
    select: { granteeId: true, expiresAt: true },
  });
  const now = new Date();
  for (const share of shares) {
    if (share.granteeId === null) continue;
    if (share.expiresAt !== null && share.expiresAt <= now) continue;
    allowed.add(share.granteeId);
  }

  return allowed;
}

/** How much of a comment travels in a notification or a digest line. */
export const COMMENT_PREVIEW_LENGTH = 140;

/** A comment's first words, flattened to one line. Never the whole body. */
export function commentPreview(body: string, limit = COMMENT_PREVIEW_LENGTH): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`;
}
