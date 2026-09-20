import { lastLocalHourSlot, type MailMessage, QUEUE_NAMES } from '@exocortex/contracts';
import { type PrismaClient, resolveNotificationMode } from '@exocortex/database';
import { type QueueRegistry } from '@exocortex/queue';

import { commentPreview, filterUsersWithPageAccess } from './comment-recipients';
import { type MaintenanceTask } from './context';

/**
 * Turns the comments somebody is owed a mail about into one mail (issue #106,
 * ADR-053).
 *
 * The sweep runs every minute and does nothing at all unless somebody has
 * switched comment mail on, which nobody has by default. What it does when
 * they have is the same in both modes the pair offers: collect the pointers
 * `comment-notifications.ts` wrote, read the comments fresh, drop what the
 * reader may no longer see, group the rest by page, and hand one mail to the
 * queue. `IMMEDIATE` and `DAILY_DIGEST` differ in one thing only -- when an
 * entry counts as due.
 *
 * That is why there is one template and not two. A single comment is a digest
 * of one, and a second "here is one comment" mail would be the same words with
 * the plural removed, kept in step by hand for ever.
 *
 * Three promises hold here, and each costs a line:
 *
 *   - **nothing is sent twice.** `sentAt` is the only bookkeeping, and the
 *     job id is derived from the person and the oldest entry, so a sweep that dies
 *     between the enqueue and the marking re-enqueues an id BullMQ already has.
 *   - **nothing is lost.** The order is enqueue, then mark. A relay having a
 *     bad five minutes is the mail queue's problem and does not touch these
 *     rows; an enqueue that throws leaves every entry owed.
 *   - **nothing leaks.** Access is re-checked here, at send time, per page.
 *     A share withdrawn since yesterday removes the page from tonight's mail,
 *     and a deleted comment took its pointer with it (the row cascades).
 */

/** People served per run. A bound, not a target: the sweep runs every minute. */
const RECIPIENTS_PER_RUN = 50;
/** Entries one mail is built from. Beyond this the mail counts rather than lists. */
const ENTRIES_PER_MAIL = 500;
/** Pages one mail lists, as `mailMessageSchema` allows. */
const MAX_PAGES = 10;
/** Comments one page lists, as `mailMessageSchema` allows. */
const MAX_COMMENTS_PER_PAGE = 5;
/** `mailTitleSchema`'s limit; the producer shortens rather than being refused. */
const MAX_TITLE_LENGTH = 200;
/** A page with no title still has to be nameable in a mail. */
const UNTITLED = 'Unbenannte Seite';

export const sendCommentDigests: MaintenanceTask = async (context) => {
  const { prisma, queues, logger } = context;
  const settings = await context.settings();
  const now = new Date();

  // Who is owed something. One grouped query rather than a scan of every
  // entry: a busy deployment has many pointers and few people.
  const owed = await prisma.commentDigestEntry.groupBy({
    by: ['userId'],
    where: { sentAt: null },
    _min: { createdAt: true },
    // Whoever has been waiting longest first, so a deployment with more
    // recipients than one run serves never starves the same person twice.
    orderBy: { _min: { createdAt: 'asc' } },
    take: RECIPIENTS_PER_RUN,
  });
  if (owed.length === 0) return;

  const dailySlot = lastLocalHourSlot(
    now,
    settings['notifications.digestHour'],
    settings['notifications.digestTimeZone'],
  );
  const debounceMs = settings['notifications.commentMailDebounceMinutes'] * 60_000;

  let sent = 0;
  let dropped = 0;
  for (const row of owed) {
    const oldest = row._min.createdAt;
    if (oldest === null) continue;

    const mode = await resolveNotificationMode(prisma, row.userId, 'COMMENT', 'EMAIL');
    if (mode === 'OFF') {
      // Switched off since the pointers were written. Delivering them later
      // would make "off" mean "collect quietly and post it all when I change
      // my mind", which is the opposite of what the switch says.
      const { count } = await prisma.commentDigestEntry.deleteMany({
        where: { userId: row.userId, sentAt: null },
      });
      dropped += count;
      continue;
    }

    const due =
      mode === 'DAILY_DIGEST'
        ? oldest.getTime() < dailySlot.getTime()
        : now.getTime() - oldest.getTime() >= debounceMs;
    if (!due) continue;

    // The oldest owed entry names this mail, in both modes. It is stable
    // across a retry -- the run that failed to mark its entries finds the same
    // oldest one a minute later -- and it moves on as soon as a mail has gone
    // out, because that entry is then history.
    const dispatched = await sendOneDigest(
      { prisma, queues, appUrl: context.appUrl },
      row.userId,
      oldest.toISOString(),
      context.payload.correlationId,
    );
    if (dispatched) sent += 1;
  }

  if (sent > 0 || dropped > 0) {
    logger.info('Comment digests dispatched', { sent, droppedEntries: dropped, owed: owed.length });
  }
};

/**
 * One person's mail, or nothing when there is nothing left to tell them.
 *
 * Returns whether a mail was enqueued. "Nothing left" is an ordinary outcome
 * rather than a failure: every entry may belong to a page the reader lost
 * access to, in which case the entries are marked sent and no mail goes out --
 * marked rather than deleted, because they are answered, and an entry that
 * stays owed would be reconsidered every minute for ever.
 */
async function sendOneDigest(
  dependencies: { prisma: PrismaClient; queues: QueueRegistry; appUrl: string },
  userId: string,
  slotKey: string,
  correlationId: string,
): Promise<boolean> {
  const { prisma, queues } = dependencies;
  const base = dependencies.appUrl.replace(/\/$/, '');

  const recipient = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true, disabledAt: true },
  });
  // A switched-off account is not written to. Disabling it withdrew its
  // credentials (issue #3); posting it a link would be the one thing that
  // still worked.
  if (recipient === null || recipient.disabledAt !== null) {
    await prisma.commentDigestEntry.deleteMany({ where: { userId, sentAt: null } });
    return false;
  }

  const entries = await prisma.commentDigestEntry.findMany({
    where: { userId, sentAt: null },
    orderBy: { createdAt: 'asc' },
    take: ENTRIES_PER_MAIL,
    select: {
      id: true,
      documentId: true,
      workspaceId: true,
      // Read now, not when the pointer was written: a comment edited since
      // then should read as it does now, and one deleted since then took this
      // row with it.
      comment: {
        select: { body: true, createdBy: { select: { name: true } } },
      },
      document: { select: { title: true } },
    },
  });
  if (entries.length === 0) return false;

  // The access re-check, one question per page rather than per comment: a
  // thread of twenty replies is one page and one answer.
  const byDocument = new Map<string, typeof entries>();
  for (const entry of entries) {
    const list = byDocument.get(entry.documentId) ?? [];
    list.push(entry);
    byDocument.set(entry.documentId, list);
  }

  const readable = new Set<string>();
  for (const [documentId, group] of byDocument) {
    const first = group[0];
    if (first === undefined) continue;
    const allowed = await filterUsersWithPageAccess(prisma, {
      documentId,
      workspaceId: first.workspaceId,
      userIds: [userId],
    });
    if (allowed.has(userId)) readable.add(documentId);
  }

  const pages = [...byDocument]
    .filter(([documentId]) => readable.has(documentId))
    .map(([documentId, group]) => ({ documentId, group }));

  const entryIds = entries.map((entry) => entry.id);
  if (pages.length === 0) {
    // Everything this person was owed is on a page they can no longer open.
    // Answered, and answered with silence.
    await prisma.commentDigestEntry.updateMany({
      where: { id: { in: entryIds } },
      data: { sentAt: new Date() },
    });
    return false;
  }

  const mail = buildDigest(pages, base);

  await queues.enqueue(
    QUEUE_NAMES.mail,
    { correlationId, recipient: recipient.email, mail },
    // Derived from the person and the slot, so the retry after a sweep that
    // died before it could mark its entries is a no-op rather than a second
    // letter.
    { jobId: `comment-digest-${userId}-${slotKey}` },
  );

  await prisma.commentDigestEntry.updateMany({
    where: { id: { in: entryIds } },
    data: { sentAt: new Date() },
  });
  return true;
}

interface DigestEntry {
  workspaceId: string;
  comment: { body: string; createdBy: { name: string } };
  document: { title: string };
}

/**
 * The mail, with everything that does not fit turned into a count.
 *
 * A digest that lists four hundred comments is a digest nobody reads, so the
 * lists are capped and the remainder is stated rather than dropped silently:
 * "und 12 weitere" is information, an absence is not.
 */
function buildDigest(
  pages: readonly { documentId: string; group: readonly DigestEntry[] }[],
  base: string,
): MailMessage {
  const commentCount = pages.reduce((total, page) => total + page.group.length, 0);
  const listed = pages.slice(0, MAX_PAGES);

  return {
    template: 'COMMENT_DIGEST',
    commentCount,
    morePages: pages.length - listed.length,
    pages: listed.map((page) => {
      const first = page.group[0];
      const comments = page.group.slice(0, MAX_COMMENTS_PER_PAGE);
      return {
        title: titleOf(first?.document.title ?? ''),
        url: `${base}/arbeitsbereich/${first?.workspaceId ?? ''}/seite/${page.documentId}`,
        moreComments: page.group.length - comments.length,
        comments: comments.map((entry) => ({
          authorName: nameOf(entry.comment.createdBy.name),
          preview: commentPreview(entry.comment.body),
        })),
      };
    }),
  };
}

/** The page's name, bounded and never empty. */
function titleOf(title: string): string {
  const flat = title.replace(/\s+/g, ' ').trim();
  if (flat.length === 0) return UNTITLED;
  return flat.length <= MAX_TITLE_LENGTH ? flat : `${flat.slice(0, MAX_TITLE_LENGTH - 1)}…`;
}

/** A name the schema will accept. An account with an empty name still wrote it. */
function nameOf(name: string): string {
  const flat = name.replace(/\s+/g, ' ').trim();
  return flat.length === 0 ? 'Jemand' : flat.slice(0, 200);
}
