'use client';

import * as React from 'react';

import { type CalendarEntry, dayKey } from './entries';
import { CalendarEntryLink } from './entry-link';
import { layoutDay, MINUTES_PER_DAY } from './layout';

/** CSS pixels per hour. Below this two half-hour appointments have no room for a title. */
const HOUR_HEIGHT = 48;
const HOURS = Array.from({ length: 24 }, (_, hour) => hour);
const DAY_HEIGHT = 24 * HOUR_HEIGHT;

/** Where the axis is scrolled on a day that is not today: the working morning, not midnight. */
const DEFAULT_SCROLL_HOUR = 8;

const COLUMN_HEADER = new Intl.DateTimeFormat('de-DE', { weekday: 'short', day: 'numeric' });

interface TimeGridViewProps {
  workspaceId: string;
  /** One column per day. A day view passes one, a week view seven. */
  days: Date[];
  entriesByDay: Map<string, CalendarEntry[]>;
}

/**
 * The day and week views: one column per day over a shared 24-hour axis.
 *
 * All-day entries sit in a band above the axis rather than on it. They have no
 * position on a time axis, and putting them on one would either stretch them
 * over the whole column or squeeze the appointments that do have a time.
 */
export function TimeGridView({ workspaceId, days, entriesByDay }: TimeGridViewProps) {
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const now = useNow();
  const todayKey = dayKey(now ?? new Date());
  const todayIndex = days.findIndex((day) => dayKey(day) === todayKey);

  // Once, on the first render that knows the time: an appointment at 09:00 is
  // not worth finding by scrolling past eight empty hours.
  const scrolled = React.useRef(false);
  React.useEffect(() => {
    const container = scrollRef.current;
    if (container === null || now === null || scrolled.current) return;
    scrolled.current = true;
    const hour = todayIndex === -1 ? DEFAULT_SCROLL_HOUR : now.getHours();
    container.scrollTop = Math.max(0, (hour - 1) * HOUR_HEIGHT);
  }, [now, todayIndex]);

  const allDayByColumn = days.map((day) => ({
    day,
    entries: (entriesByDay.get(dayKey(day)) ?? []).filter((entry) => entry.allDay),
  }));
  const hasAllDay = allDayByColumn.some((column) => column.entries.length > 0);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-x-auto" data-testid="calendar-time-grid">
      <div className={days.length > 1 ? 'flex min-w-3xl flex-1 flex-col' : 'flex flex-1 flex-col'}>
        <div className="flex border-b border-border">
          <div className="w-14 shrink-0" />
          {days.map((day) => (
            <div
              key={dayKey(day)}
              className={`flex-1 border-l border-border px-2 py-1 text-xs capitalize ${dayKey(day) === todayKey ? 'font-semibold text-primary-text' : 'text-muted-foreground'}`}
            >
              {COLUMN_HEADER.format(day)}
            </div>
          ))}
        </div>

        {hasAllDay ? (
          <div className="flex border-b border-border">
            <div className="w-14 shrink-0 px-2 py-1 text-micro text-muted-foreground">Ganztags</div>
            {allDayByColumn.map((column) => (
              <div
                key={dayKey(column.day)}
                className="flex flex-1 flex-col gap-0.5 border-l border-border p-1"
              >
                {column.entries.map((entry) => (
                  <CalendarEntryLink
                    key={entry.row.document.id}
                    workspaceId={workspaceId}
                    entry={entry}
                    className="truncate rounded bg-accent px-1 py-0.5 text-micro hover:underline"
                  />
                ))}
              </div>
            ))}
          </div>
        ) : null}

        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
          <div className="relative" style={{ height: DAY_HEIGHT }}>
            {HOURS.map((hour) => (
              <div
                key={hour}
                className="pointer-events-none absolute inset-x-0 border-t border-border"
                style={{ top: hour * HOUR_HEIGHT }}
              />
            ))}
            <div className="flex h-full">
              <div className="relative w-14 shrink-0">
                {HOURS.map((hour) => (
                  <span
                    key={hour}
                    className="absolute right-2 -translate-y-1/2 text-micro text-muted-foreground"
                    style={{ top: hour * HOUR_HEIGHT }}
                  >
                    {hour === 0 ? '' : `${String(hour).padStart(2, '0')}:00`}
                  </span>
                ))}
              </div>
              {days.map((day) => (
                <DayColumn
                  key={dayKey(day)}
                  workspaceId={workspaceId}
                  day={day}
                  entries={entriesByDay.get(dayKey(day)) ?? []}
                  now={dayKey(day) === todayKey ? now : null}
                />
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function DayColumn({
  workspaceId,
  day,
  entries,
  now,
}: {
  workspaceId: string;
  day: Date;
  entries: CalendarEntry[];
  now: Date | null;
}) {
  const placed = layoutDay(entries, day);

  return (
    <div className="relative flex-1 border-l border-border">
      {placed.map((item) => {
        const height = ((item.endMinute - item.startMinute) / 60) * HOUR_HEIGHT;
        return (
          <div
            key={item.entry.row.document.id}
            className="absolute px-px"
            style={{
              top: (item.startMinute / 60) * HOUR_HEIGHT,
              height,
              left: `${(item.column / item.columns) * 100}%`,
              width: `${100 / item.columns}%`,
            }}
          >
            <CalendarEntryLink
              workspaceId={workspaceId}
              entry={item.entry}
              className={`block h-full overflow-hidden rounded bg-accent px-1 py-0.5 text-micro leading-tight hover:underline ${item.continuesBefore ? 'rounded-t-none' : ''} ${item.continuesAfter ? 'rounded-b-none' : ''}`}
            />
          </div>
        );
      })}
      {now === null ? null : (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 border-t-2 border-primary"
          style={{
            top: ((now.getHours() * 60 + now.getMinutes()) / MINUTES_PER_DAY) * DAY_HEIGHT,
          }}
        >
          <span className="absolute -top-1 -left-1 size-2 rounded-full bg-primary" />
        </div>
      )}
    </div>
  );
}

/** The current minute as a timestamp, cached so repeated reads within it are identical. */
let currentMinute = 0;

function minuteSnapshot(): number {
  const floored = Date.now() - (Date.now() % 60_000);
  if (floored !== currentMinute) currentMinute = floored;
  return currentMinute;
}

/** Twice a minute, so the line is never more than half a minute behind the clock. */
function subscribeToMinute(onChange: () => void): () => void {
  const timer = setInterval(onChange, 30_000);
  return () => clearInterval(timer);
}

/**
 * The current minute, or `null` on the server.
 *
 * An external store rather than state in an effect: the time is not this
 * component's state, and the server snapshot is what keeps the rendered markup
 * and the first client render identical. A clock read during render would
 * differ between the two and count as a hydration mismatch.
 */
function useNow(): Date | null {
  const minute = React.useSyncExternalStore<number | null>(
    subscribeToMinute,
    minuteSnapshot,
    () => null,
  );
  return minute === null ? null : new Date(minute);
}
