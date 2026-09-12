import { type CalendarLinkPropertyMap, parseCalendarLinkPropertyMap } from '@exocortex/contracts';
import { type PrismaClient } from '@exocortex/database';
import { type Logger } from '@exocortex/logger';
import { type ExocortexApiClient } from '@exocortex/mcp-tools';

import { type ReminderNotifier } from './notifier';
import { REMINDER_WINDOW_MS } from './reminder-constants';
import { buildReminderMessage } from './reminder-message';
import { isDue, type ReminderSchedule, reminderWindowFor } from './reminder-time';
import { readAllRows, readSpan, readText, valueOf } from './rows';

export interface SendRemindersInput {
  prisma: PrismaClient;
  /** An API client acting as the given user; the sweep reads rows as their owner. */
  apiClientFor: (userId: string) => ExocortexApiClient;
  notifier: ReminderNotifier;
  logger: Logger;
  /**
   * The schedule in force for one workspace (issue #52, ADR-023).
   *
   * A resolver rather than a value: lead time, all-day hour and time zone are
   * workspace-scoped keys now, and this sweep spans every account on the
   * deployment. Two people in two time zones would otherwise be reminded on
   * whichever one the administrator happened to type in.
   */
  scheduleFor: (workspaceId: string) => Promise<ReminderSchedule | null>;
  /** Public base URL, so a reminder can link back to the page. */
  appUrl: string;
  now: Date;
}

export interface SendRemindersResult {
  sent: number;
  /** Appointments in the window whose moment has not come, or has passed. */
  pending: number;
  /** Reminders that could not be delivered; they stay due and are retried. */
  failed: number;
}

/**
 * Sends every reminder that is due, once.
 *
 * Deliberately a sweep and not a delayed job per appointment. A delayed job has to
 * be found and cancelled whenever an appointment moves, and a mirrored series
 * moves *by itself* as the clock passes each occurrence -- so the queue would fill
 * with jobs for times that no longer exist, and the one job that mattered would be
 * the one that got lost in a restart. A sweep holds no state that can rot: it asks
 * "what is due now" and the answer is derived from the mirror every time.
 *
 * Idempotence comes from comparing `remindedFor` against `occurrenceStart` rather
 * than from a flag. Equal means announced; an appointment that moves gets a fresh
 * reminder because its start no longer matches, which is exactly right -- a new
 * time is news.
 */
export async function sendDueReminders(input: SendRemindersInput): Promise<SendRemindersResult> {
  const result: SendRemindersResult = { sent: 0, pending: 0, failed: 0 };

  const candidates = await input.prisma.calendarObjectState.findMany({
    where: {
      deletedAt: null,
      rowDocumentId: { not: null },
      occurrenceStart: {
        gte: new Date(input.now.getTime() - REMINDER_WINDOW_MS),
        lte: new Date(input.now.getTime() + REMINDER_WINDOW_MS),
      },
      // A VTODO's due date is a deadline, not an appointment. Announcing it as
      // "in 30 minutes" would be a different feature wearing this one's clothes.
      link: { enabled: true, component: 'VEVENT', account: { enabled: true } },
    },
    include: { link: { include: { account: { select: { userId: true, workspaceId: true } } } } },
  });

  const fresh = candidates.filter(
    (state) =>
      state.occurrenceStart !== null &&
      state.remindedFor?.getTime() !== state.occurrenceStart.getTime(),
  );
  if (fresh.length === 0) return result;

  // The rows are read once per link, not once per appointment: the span, the title
  // and the location all come from the row, because the row is what a human last
  // edited and therefore what they expect to be reminded of.
  const rowsByLink = new Map<string, Awaited<ReturnType<typeof readAllRows>>>();
  for (const state of fresh) {
    if (rowsByLink.has(state.linkId)) continue;
    try {
      const client = input.apiClientFor(state.link.account.userId);
      rowsByLink.set(state.linkId, await readAllRows(client, state.link.documentId));
    } catch (error) {
      input.logger.warn('Could not read a mirror database for reminders', {
        linkId: state.linkId,
        reason: error instanceof Error ? error.message : String(error),
      });
      rowsByLink.set(state.linkId, []);
    }
  }

  for (const state of fresh) {
    const occurrenceStart = state.occurrenceStart;
    if (occurrenceStart === null || state.rowDocumentId === null) continue;

    const row = rowsByLink
      .get(state.linkId)
      ?.find((entry) => entry.document.id === state.rowDocumentId);
    // No row means archived, deleted, or not readable. Not an error and not
    // marked as reminded: if it comes back, it deserves its reminder.
    if (row === undefined) continue;

    const map: CalendarLinkPropertyMap = parseCalendarLinkPropertyMap(
      state.link.propertyMap as Record<string, unknown> | null,
    );
    const cell = readSpan(valueOf(row, map.date));
    if (cell === null) continue;

    const span = {
      start: new Date(cell.start),
      end: cell.end === null ? null : new Date(cell.end),
      allDay: cell.allDay,
    };
    // Null means this workspace has reminders switched off. Skipped silently
    // and not counted as pending: nothing is waiting to happen here.
    const schedule = await input.scheduleFor(state.link.account.workspaceId);
    if (schedule === null) continue;
    if (!isDue(reminderWindowFor(span, schedule), input.now)) {
      result.pending += 1;
      continue;
    }

    const message = buildReminderMessage(span, {
      title: row.document.title,
      location: readText(valueOf(row, map.location)),
      url: `${input.appUrl.replace(/\/$/, '')}/arbeitsbereich/${state.link.account.workspaceId}/seite/${state.rowDocumentId}`,
      timeZone: schedule.timeZone,
      now: input.now,
    });

    try {
      await input.notifier.send(message);
    } catch (error) {
      // Left unmarked on purpose, so the next sweep tries again while the
      // appointment is still ahead. A reminder that failed silently is worse than
      // no reminder at all, so it is also logged.
      input.logger.warn('Could not deliver a calendar reminder', {
        stateId: state.id,
        reason: error instanceof Error ? error.message : String(error),
      });
      result.failed += 1;
      continue;
    }

    await input.prisma.calendarObjectState.update({
      where: { id: state.id },
      data: { remindedFor: occurrenceStart },
    });
    result.sent += 1;
  }

  return result;
}
