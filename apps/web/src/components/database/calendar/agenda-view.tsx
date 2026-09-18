'use client';

import { EmptyState } from '@exocortex/ui';

import { type CalendarEntry, dayKey } from './entries';
import { CalendarEntryLink } from './entry-link';
import { addDays } from './range';

const DAY_HEADING = new Intl.DateTimeFormat('de-DE', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
});
const TIME_RANGE = new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit' });

interface AgendaViewProps {
  workspaceId: string;
  from: Date;
  to: Date;
  entriesByDay: Map<string, CalendarEntry[]>;
}

/**
 * The list: every day of the window that has something on it, in order.
 *
 * Days with nothing on them are left out rather than drawn empty. A month of
 * mostly empty headings is a worse answer to "what is coming up" than a short
 * list is, and the grids are there for anyone who wants to see the gaps.
 */
export function AgendaView({ workspaceId, from, to, entriesByDay }: AgendaViewProps) {
  const days: { day: Date; entries: CalendarEntry[] }[] = [];
  for (let cursor = from; cursor < to; cursor = addDays(cursor, 1)) {
    const entries = entriesByDay.get(dayKey(cursor)) ?? [];
    if (entries.length > 0) days.push({ day: cursor, entries });
  }

  if (days.length === 0) {
    return (
      <EmptyState
        title="Nichts in diesem Zeitraum"
        description="In diesem Monat liegt kein Eintrag. Blättere weiter oder wechsle die Ansicht."
      />
    );
  }

  const todayKey = dayKey(new Date());

  return (
    <div className="flex flex-col gap-4" data-testid="calendar-agenda">
      {days.map(({ day, entries }) => (
        <section key={dayKey(day)} className="flex flex-col gap-1">
          <h3
            className={`text-xs font-medium capitalize ${dayKey(day) === todayKey ? 'text-primary-text' : 'text-muted-foreground'}`}
          >
            {DAY_HEADING.format(day)}
          </h3>
          <ul className="flex flex-col divide-y divide-border border-t border-border">
            {entries.map((entry) => (
              <li key={entry.row.document.id} className="flex items-baseline gap-3 py-1.5">
                <span className="w-28 shrink-0 text-xs text-muted-foreground tabular-nums">
                  {timeRangeOf(entry)}
                </span>
                <CalendarEntryLink
                  workspaceId={workspaceId}
                  entry={entry}
                  showTime={false}
                  className="truncate text-sm hover:underline"
                />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function timeRangeOf(entry: CalendarEntry): string {
  if (entry.allDay) return 'Ganztags';
  const start = new Date(entry.start);
  if (Number.isNaN(start.getTime())) return '';
  if (entry.end === null) return TIME_RANGE.format(start);
  const end = new Date(entry.end);
  if (Number.isNaN(end.getTime())) return TIME_RANGE.format(start);
  return `${TIME_RANGE.format(start)} bis ${TIME_RANGE.format(end)}`;
}
