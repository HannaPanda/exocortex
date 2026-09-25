import { type Locale } from '@exocortex/contracts';
import { serverTranslator } from '@exocortex/i18n/catalog';

import { MS_PER_DAY } from './reminder-constants';

/**
 * The text of a reminder, in the language of the person it is for (issue #98,
 * ADR-062): the calendar owner's, with the dates and times formatted the way
 * that language writes them.
 *
 * Two lines and an optional third: what and when, then the details, then the page
 * it came from. Short on purpose -- this arrives on a phone, next to everything
 * else that wants attention, and a reminder that has to be read twice has already
 * failed.
 */

export interface ReminderSpan {
  start: Date;
  /** Exclusive end, or null for a point in time. */
  end: Date | null;
  allDay: boolean;
}

export interface ReminderContext {
  title: string;
  location: string | null;
  /** Link to the mirrored row, or null when no public URL is configured. */
  url: string | null;
  timeZone: string;
  /** The reader's language: the calendar owner's `User.locale`, resolved. */
  locale: Locale;
  now: Date;
}

type PushTranslator = ReturnType<typeof serverTranslator<'push'>>;

export function buildReminderMessage(span: ReminderSpan, context: ReminderContext): string {
  const t = serverTranslator(context.locale, 'push');
  const lines = [`🔔 ${headline(t, span, context)}`];

  const detail = describeDetail(t, span, context);
  if (detail.length > 0) lines.push(detail);

  if (context.url !== null) lines.push(context.url);
  return lines.join('\n');
}

/**
 * The same reminder as a push notification (issue #30, ADR-048).
 *
 * Two fields rather than three lines, because that is the shape a lock screen
 * has: one line that is read at a glance and one that is read if the first one
 * earned it. The link is not in the text at all -- tapping the notification is
 * what opens the page.
 */
export function buildReminderNotification(
  span: ReminderSpan,
  context: ReminderContext,
): { title: string; body: string } {
  const t = serverTranslator(context.locale, 'push');
  const detail = describeDetail(t, span, context);
  return {
    title: headline(t, span, context),
    // Never empty: `describeSpan` always says something, and a notification
    // with an empty body is rendered differently by every platform.
    body: detail.length > 0 ? detail : t('calendar.emptyBody'),
  };
}

function headline(t: PushTranslator, span: ReminderSpan, context: ReminderContext): string {
  return t('calendar.title', { lead: lead(t, span, context), title: context.title.trim() });
}

function describeDetail(t: PushTranslator, span: ReminderSpan, context: ReminderContext): string {
  return [describeSpan(t, span, context), context.location?.trim()]
    .filter((part): part is string => part !== undefined && part.length > 0)
    .join(' · ');
}

/** The part before the title: how far away the appointment is. */
function lead(t: PushTranslator, span: ReminderSpan, context: ReminderContext): string {
  if (span.allDay) return t('calendar.lead.today');

  const minutes = Math.round((span.start.getTime() - context.now.getTime()) / 60_000);
  if (minutes <= 0) return t('calendar.lead.now');
  if (minutes < 60) return t('calendar.lead.minutes', { minutes });

  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0
    ? t('calendar.lead.hours', { hours })
    : t('calendar.lead.hoursAndMinutes', { hours, minutes: rest });
}

/**
 * The when, spelled out. An all-day appointment says so instead of naming a time,
 * and a multi-day one names the days it actually covers: its stored end is
 * exclusive, so the last day is the day before it.
 */
function describeSpan(t: PushTranslator, span: ReminderSpan, context: ReminderContext): string {
  const { timeZone, locale } = context;
  if (span.allDay) {
    const lastDay = span.end === null ? null : new Date(span.end.getTime() - MS_PER_DAY);
    if (lastDay === null || lastDay.getTime() <= span.start.getTime()) {
      return t('calendar.span.allDay');
    }
    return t('calendar.span.allDayRange', {
      from: formatDate(span.start, timeZone, locale),
      to: formatDate(lastDay, timeZone, locale),
    });
  }

  const from = formatTime(span.start, timeZone, locale);
  if (span.end === null) return t('calendar.span.time', { time: from });
  const to = formatTime(span.end, timeZone, locale);
  // A time on another day would be ambiguous as a bare clock reading.
  if (!sameDay(span.start, span.end, timeZone)) {
    return t('calendar.span.timeRangeAcrossDays', {
      from,
      toDate: formatDate(span.end, timeZone, locale),
      to,
    });
  }
  return t('calendar.span.timeRange', { from, to });
}

function formatTime(instant: Date, timeZone: string, locale: Locale): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
  }).format(instant);
}

/**
 * An all-day date is a floating date pinned to UTC midnight, so it is rendered in
 * UTC: reading it in a zone behind UTC would move a birthday to the day before.
 */
function formatDate(instant: Date, timeZone: string, locale: Locale): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone: isFloating(instant) ? 'UTC' : timeZone,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(instant);
}

function isFloating(instant: Date): boolean {
  return (
    instant.getUTCHours() === 0 &&
    instant.getUTCMinutes() === 0 &&
    instant.getUTCSeconds() === 0 &&
    instant.getUTCMilliseconds() === 0
  );
}

/** Compares calendar days in the zone; the digits, not the words, so any locale would do. */
function sameDay(a: Date, b: Date, timeZone: string): boolean {
  const format = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return format.format(a) === format.format(b);
}
