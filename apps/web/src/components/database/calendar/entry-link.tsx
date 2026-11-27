'use client';

import { useLocale } from 'next-intl';

import { type HourCycle, useHourCycle } from '@exocortex/ui';

import { RowPeekLink } from '../row-peek';

import { type CalendarEntry } from './entries';
import { calendarFormatter } from './range';

export function entryTime(
  entry: CalendarEntry,
  locale: string,
  cycle: HourCycle | undefined,
): string | null {
  if (entry.allDay) return null;
  const date = new Date(entry.start);
  return Number.isNaN(date.getTime())
    ? null
    : calendarFormatter(locale, 'time', cycle).format(date);
}

/**
 * One row as a link to its own page. A calendar entry *is* a page (ADR-011), so
 * opening it shows that page, never a dialog with a copy of it: beside the
 * calendar in the side panel (issue #239), or in a new tab with Strg.
 */
export function CalendarEntryLink({
  workspaceId,
  entry,
  className,
  showTime = true,
}: {
  workspaceId: string;
  entry: CalendarEntry;
  className?: string;
  showTime?: boolean;
}) {
  const locale = useLocale();
  const cycle = useHourCycle();
  const time = showTime ? entryTime(entry, locale, cycle) : null;
  return (
    <RowPeekLink
      workspaceId={workspaceId}
      rowId={entry.row.document.id}
      className={className}
      title={entry.row.document.title}
    >
      {time === null ? null : <span className="mr-1 text-muted-foreground">{time}</span>}
      {entry.row.document.title}
    </RowPeekLink>
  );
}
