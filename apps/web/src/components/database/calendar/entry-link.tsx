'use client';

import Link from 'next/link';

import { type CalendarEntry } from './entries';

const TIME_FORMATTER = new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit' });

export function entryTime(entry: CalendarEntry): string | null {
  if (entry.allDay) return null;
  const date = new Date(entry.start);
  return Number.isNaN(date.getTime()) ? null : TIME_FORMATTER.format(date);
}

/**
 * One row as a link to its own page. A calendar entry *is* a page (ADR-011), so
 * opening it is a navigation, never a dialog that shows a copy of it.
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
  const time = showTime ? entryTime(entry) : null;
  return (
    <Link
      href={`/arbeitsbereich/${workspaceId}/seite/${entry.row.document.id}`}
      className={className}
      title={entry.row.document.title}
    >
      {time === null ? null : <span className="mr-1 text-muted-foreground">{time}</span>}
      {entry.row.document.title}
    </Link>
  );
}
