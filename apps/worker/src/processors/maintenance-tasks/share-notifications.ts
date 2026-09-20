import {
  documentShareChangedPayloadSchema,
  type MailMessage,
  QUEUE_NAMES,
} from '@exocortex/contracts';
import { type PrismaClient, resolveNotificationMode } from '@exocortex/database';
import { type QueueRegistry } from '@exocortex/queue';

/**
 * Turns a changed grant into the mail that tells its holder (issue #103).
 *
 * It hangs off the outbox like the comment notifications beside it, and for
 * one reason more than they have: the mail says "you can reach this page now",
 * and a request that rolled back after the message had gone would have said
 * something untrue about somebody's access. Inside the transaction, or not at
 * all.
 *
 * Mail rather than push, because a share is not a moment. It is still the case
 * tomorrow, the person it concerns is usually not in eXocortex when it
 * happens, and a notification they swipe away takes the address of the page
 * with it.
 *
 * Who gets it is decided here and nowhere else: the account named by the
 * grant, read now rather than when the request ran, and only while it exists
 * and is switched on. The job that follows carries an address and does not
 * resolve anybody.
 */

export interface ShareNotificationDependencies {
  prisma: PrismaClient;
  queues: QueueRegistry;
  appUrl: string;
}

export interface ShareNotificationEvent {
  /**
   * The outbox row. It is the deduplication key: a dispatch that failed after
   * the mail was enqueued re-enqueues under the same id, and BullMQ ignores the
   * second one.
   */
  eventId: string;
  workspaceId: string;
  type: string;
  payload: unknown;
  correlationId: string;
}

/** A page with no title still has to be nameable in a subject line. */
const UNTITLED = 'Unbenannte Seite';
/** `mailTitleSchema`'s limit; the producer shortens rather than being refused. */
const MAX_TITLE_LENGTH = 200;

export async function scheduleShareNotifications(
  dependencies: ShareNotificationDependencies,
  event: ShareNotificationEvent,
): Promise<void> {
  if (event.type !== 'document.share.changed') return;
  const parsed = documentShareChangedPayloadSchema.safeParse(event.payload);
  if (!parsed.success) return;
  const { shareId, documentId, change, actorId } = parsed.data;

  const share = await dependencies.prisma.documentShare.findUnique({
    where: { id: shareId },
    select: {
      kind: true,
      permission: true,
      scope: true,
      expiresAt: true,
      revokedAt: true,
      // The address comes from the account, never from what the sharing
      // request typed: the two agree only until somebody changes their mail.
      grantee: { select: { id: true, email: true, disabledAt: true } },
      document: { select: { title: true } },
    },
  });
  // Gone between the write and the dispatch -- the page was deleted, taking
  // its grants with it. There is nothing left to tell anybody about.
  if (share === null) return;
  if (share.kind !== 'USER' || share.grantee === null) return;
  // A switched-off account is not written to. Disabling it withdrew its
  // credentials (issue #3); posting it a link would be the one thing that
  // still worked.
  if (share.grantee.disabledAt !== null) return;
  // Handed out and withdrawn again before the sweep came round. The
  // withdrawal wrote its own event, and this one would announce access that
  // no longer exists.
  if (change !== 'revoked' && share.revokedAt !== null) return;

  // Asked here, at dispatch, and before anything is enqueued (issue #105):
  // `OFF` has to mean that no job exists, not that a job runs and throws the
  // mail away. One switch covers the arrival, the change and the withdrawal,
  // because they are one occasion -- somebody who does not want to hear about
  // their access changing does not want two thirds of it either.
  //
  // `IMMEDIATE` explicitly rather than "not OFF": a mode that collects for
  // later must never fall through to sending at once, which is the mistake
  // issue #106 would otherwise inherit.
  const mode = await resolveNotificationMode(
    dependencies.prisma,
    share.grantee.id,
    'SHARE',
    'EMAIL',
  );
  if (mode !== 'IMMEDIATE') return;

  const actor = await dependencies.prisma.user.findUnique({
    where: { id: actorId },
    select: { name: true },
  });
  // A deleted account still did the thing. "Jemand" is less informative than a
  // name and more honest than the workspace's, which did not share anything.
  const actorName = actor?.name.trim() ?? '';
  const byName = actorName.length === 0 ? 'Jemand' : actorName;
  const documentTitle = titleOf(share.document.title);
  const base = dependencies.appUrl.replace(/\/$/, '');

  const grant = {
    documentTitle,
    permission: share.permission,
    scope: share.scope,
    url: `${base}/geteilt/${documentId}`,
    expiresAt: share.expiresAt?.toISOString() ?? null,
  };
  const mail: MailMessage =
    change === 'granted'
      ? { template: 'SHARE_GRANTED', sharedByName: byName, ...grant }
      : change === 'changed'
        ? { template: 'SHARE_CHANGED', changedByName: byName, ...grant }
        : {
            template: 'SHARE_REVOKED',
            revokedByName: byName,
            documentTitle,
            // The list of what is still shared, not the page that is not: a
            // link into a page they can no longer open would be a 404 dressed
            // up as an invitation.
            url: `${base}/geteilt`,
          };

  await dependencies.queues.enqueue(
    QUEUE_NAMES.mail,
    { correlationId: event.correlationId, recipient: share.grantee.email, mail },
    { jobId: `share-mail-${event.eventId}` },
  );
}

/** The page's name, bounded and never empty. */
function titleOf(title: string): string {
  const flat = title.replace(/\s+/g, ' ').trim();
  if (flat.length === 0) return UNTITLED;
  return flat.length <= MAX_TITLE_LENGTH ? flat : `${flat.slice(0, MAX_TITLE_LENGTH - 1)}…`;
}
