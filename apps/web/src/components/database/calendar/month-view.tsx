'use client';

import * as React from 'react';

import { type CalendarEntry, dayKey } from './entries';
import { CalendarEntryLink } from './entry-link';
import { addDays, MONTH_GRID_DAYS, monthGridStart } from './range';

const WEEKDAY_LABELS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];

/** How many entries a cell shows before it collapses the rest into one line. */
const VISIBLE_PER_CELL = 3;

interface MonthViewProps {
  workspaceId: string;
  anchor: Date;
  entriesByDay: Map<string, CalendarEntry[]>;
  onOpenDay: (day: Date) => void;
}

export function MonthView({ workspaceId, anchor, entriesByDay, onOpenDay }: MonthViewProps) {
  const month = anchor.getMonth();
  const start = monthGridStart(anchor.getFullYear(), month);
  const days = React.useMemo(
    () => Array.from({ length: MONTH_GRID_DAYS }, (_, index) => addDays(start, index)),
    [start],
  );
  const todayKey = dayKey(new Date());

  return (
    <div
      className="grid grid-cols-7 border-t border-l border-border text-xs"
      data-testid="calendar-month"
    >
      {WEEKDAY_LABELS.map((label) => (
        <div
          key={label}
          className="border-r border-b border-border bg-surface px-2 py-1 text-muted-foreground"
        >
          {label}
        </div>
      ))}
      {days.map((day) => {
        const key = dayKey(day);
        const inMonth = day.getMonth() === month;
        const entries = entriesByDay.get(key) ?? [];
        const hidden = entries.length - VISIBLE_PER_CELL;
        return (
          <div
            key={key}
            className={`flex min-h-24 flex-col gap-1 border-r border-b border-border p-1 ${inMonth ? '' : 'bg-surface/50'}`}
          >
            <button
              type="button"
              aria-label={`Tag öffnen: ${day.toLocaleDateString('de-DE')}`}
              onClick={() => onOpenDay(day)}
              className={`self-start rounded px-1 text-micro hover:bg-accent ${key === todayKey ? 'font-semibold text-primary-text' : 'text-muted-foreground'} ${inMonth ? '' : 'opacity-50'}`}
            >
              {day.getDate()}
            </button>
            {entries.slice(0, VISIBLE_PER_CELL).map((entry) => (
              <CalendarEntryLink
                key={entry.row.document.id}
                workspaceId={workspaceId}
                entry={entry}
                className="truncate rounded bg-accent px-1 py-0.5 text-micro hover:underline"
              />
            ))}
            {hidden > 0 ? (
              <button
                type="button"
                onClick={() => onOpenDay(day)}
                className="self-start px-1 text-left text-micro text-muted-foreground hover:underline"
              >
                +{hidden} weitere
              </button>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
