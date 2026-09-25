import {
  automationFailurePayloadSchema,
  type MailMessage,
  QUEUE_NAMES,
  type Settings,
} from '@exocortex/contracts';
import { type PrismaClient, resolveNotificationMode } from '@exocortex/database';
import { resolveLocale } from '@exocortex/i18n';
import { serverTranslator } from '@exocortex/i18n/catalog';
import { type QueueRegistry } from '@exocortex/queue';

/**
 * Turns an automation's final failure into the mail that tells its owner
 * (issue #107).
 *
 * The worker decided *that* something is worth telling when it wrote the
 * outbox row: a rule switching itself off, or the first failure of a
 * scheduled streak (`noteFailure` in `automation.ts`). This decides *whether it
 * still is*, from the state that holds now, and who hears it.
 *
 * Only the rule's owner, and only while they could act on it: the account
 * exists, is switched on, is still a member of the workspace the rule lives in,
 * and has not switched the `FAILURE`/`EMAIL` pair off. A rule somebody switched
 * back on between the failure and the dispatch is not announced as off.
 *
 * Nothing else goes this way. A queue job that failed, an index that could not
 * be rebuilt, a maintenance task that threw: those belong to the logs and the
 * alerts, because the person who could read such a mail is not the person who
 * could fix what it describes.
 */

export interface FailureNotificationDependencies {
  prisma: PrismaClient;
  queues: QueueRegistry;
  appUrl: string;
  /**
   * The deployment's settings: `notifications.digestTimeZone` for the time the
   * mail shows, `automations.maxConsecutiveFailures` for how far off the
   * switch-off still is. Both are deployment-wide (ADR-023).
   */
  settings: () => Promise<Settings>;
}

export interface FailureNotificationEvent {
  /** The outbox row, and with it the one mail this event may ever produce. */
  eventId: string;
  workspaceId: string;
  type: string;
  payload: unknown;
  correlationId: string;
  createdAt: Date;
}

/** `mailNameSchema`'s limit; the producer shortens rather than being refused. */
const MAX_NAME_LENGTH = 200;

export async function scheduleFailureNotifications(
  dependencies: FailureNotificationDependencies,
  event: FailureNotificationEvent,
): Promise<void> {
  if (event.type !== 'automation.disabled' && event.type !== 'automation.run.failed') return;
  const parsed = automationFailurePayloadSchema.safeParse(event.payload);
  if (!parsed.success) return;
  const { ruleId, reason, failures } = parsed.data;
  const { prisma } = dependencies;

  const rule = await prisma.automationRule.findUnique({
    where: { id: ruleId },
    select: {
      name: true,
      enabled: true,
      workspaceId: true,
      createdBy: { select: { id: true, email: true, disabledAt: true, locale: true } },
    },
  });
  // Deleted in between. A rule nobody has any more is nothing to repair.
  if (rule === null) return;
  // Switched back on before the sweep came round: the mail would describe a
  // state its owner has already undone.
  if (event.type === 'automation.disabled' && rule.enabled) return;
  const owner = rule.createdBy;
  if (owner === null || owner.disabledAt !== null) return;

  // Somebody who left the workspace cannot open the link, and the rule's name
  // is not theirs to be told about any more.
  const membership = await prisma.workspaceMember.findFirst({
    where: { workspaceId: rule.workspaceId, userId: owner.id },
    select: { id: true },
  });
  if (membership === null) return;

  // Before the enqueue, and compared against `IMMEDIATE` (docs/notifications.md).
  const mode = await resolveNotificationMode(prisma, owner.id, 'FAILURE', 'EMAIL');
  if (mode !== 'IMMEDIATE') return;

  const settings = await dependencies.settings();
  const base = dependencies.appUrl.replace(/\/$/, '');
  // The owner's language (ADR-062), which is also the language of the name a
  // rule without one is given.
  const locale = resolveLocale({ preference: owner.locale });
  const common = {
    ruleName: nameOf(rule.name, serverTranslator(locale, 'mail')('common.unnamedRule')),
    reason,
    occurredAt: event.createdAt.toISOString(),
    timeZone: settings['notifications.digestTimeZone'],
    url: `${base}/arbeitsbereich/${rule.workspaceId}/automationen`,
  };
  const mail: MailMessage =
    event.type === 'automation.disabled'
      ? { template: 'AUTOMATION_DISABLED', failures, ...common }
      : {
          template: 'AUTOMATION_RUN_FAILED',
          // Read now rather than carried in the event: the setting is what
          // decides when the rule stops, and the mail should agree with it.
          failuresUntilDisabled: Math.max(
            1,
            settings['automations.maxConsecutiveFailures'] - failures,
          ),
          ...common,
        };

  await dependencies.queues.enqueue(
    QUEUE_NAMES.mail,
    { correlationId: event.correlationId, recipient: owner.email, mail, locale },
    // One event, one letter: a dispatch that failed after this line is
    // retried with the same row, and BullMQ ignores the second job.
    { jobId: `failure-mail-${event.eventId}` },
  );
}

/** The rule's name, bounded and never empty. */
function nameOf(name: string, unnamed: string): string {
  const flat = name.replace(/\s+/g, ' ').trim();
  if (flat.length === 0) return unnamed;
  return flat.length <= MAX_NAME_LENGTH ? flat : `${flat.slice(0, MAX_NAME_LENGTH - 1)}…`;
}
