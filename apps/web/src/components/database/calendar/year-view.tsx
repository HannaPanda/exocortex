'use client';

import * as React from 'react';

import { type CalendarEntry, dayKey } from './entries';
import { addDays, MONTH_GRID_DAYS, monthGridStart, monthName } from './range';

const WEEKDAY_INITIALS = ['M', 'D', 'M', 'D', 'F', 'S', 'S'];

interface YearViewProps {
  anchor: Date;
  entriesByDay: Map<string, CalendarEntry[]>;
  onOpenDay: (day: Date) => void;
  onOpenMonth: (day: Date) => void;
}

/**
 * Twelve small month grids. The question a year answers is "when was anything
 * happening", so a day carries how busy it was rather than what was on it: at
 * this size a title is unreadable, and a dot per day is not.
 */
export function YearView({ anchor, entriesByDay, onOpenDay, onOpenMonth }: YearViewProps) {
  const year = anchor.getFullYear();
  const todayKey = dayKey(new Date());

  return (
    <div
      className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
      data-testid="calendar-year"
    >
      {Array.from({ length: 12 }, (_, month) => (
        <MiniMonth
          key={month}
          year={year}
          month={month}
          entriesByDay={entriesByDay}
          todayKey={todayKey}
          onOpenDay={onOpenDay}
          onOpenMonth={onOpenMonth}
        />
      ))}
    </div>
  );
}

function MiniMonth({
  year,
  month,
  entriesByDay,
  todayKey,
  onOpenDay,
  onOpenMonth,
}: {
  year: number;
  month: number;
  entriesByDay: Map<string, CalendarEntry[]>;
  todayKey: string;
  onOpenDay: (day: Date) => void;
  onOpenMonth: (day: Date) => void;
}) {
  const start = monthGridStart(year, month);
  const days = React.useMemo(
    () => Array.from({ length: MONTH_GRID_DAYS }, (_, index) => addDays(start, index)),
    [start],
  );

  return (
    <div className="rounded-lg border border-border p-2">
      <button
        type="button"
        onClick={() => onOpenMonth(new Date(year, month, 1))}
        className="mb-1 w-full text-left text-xs font-medium capitalize hover:underline"
      >
        {monthName(month)}
      </button>
      <div className="grid grid-cols-7 gap-px text-center">
        {WEEKDAY_INITIALS.map((label, index) => (
          <span key={index} className="text-nano text-muted-foreground">
            {label}
          </span>
        ))}
        {days.map((day) => {
          const key = dayKey(day);
          const count = entriesByDay.get(key)?.length ?? 0;
          if (day.getMonth() !== month) return <span key={key} />;
          return (
            <button
              key={key}
              type="button"
              onClick={() => onOpenDay(day)}
              title={count === 0 ? undefined : `${count} Einträge`}
              className={`rounded-sm text-nano leading-5 hover:bg-accent ${key === todayKey ? 'font-semibold text-primary-text' : ''} ${busyClass(count)}`}
            >
              {day.getDate()}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Three steps, not a scale. A year grid is read at a glance, and more shades
 * than "nothing / something / a lot" only look like noise at this size.
 */
function busyClass(count: number): string {
  if (count === 0) return 'text-muted-foreground';
  if (count < 3) return 'bg-accent/50';
  return 'bg-accent-strong';
}
