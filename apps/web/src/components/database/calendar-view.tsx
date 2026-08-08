'use client';

import { ChevronLeftIcon, ChevronRightIcon } from 'lucide-react';
import Link from 'next/link';
import * as React from 'react';

import {
  type DatabaseProperty,
  type DatabaseRow,
  type DatabaseRowPropertyValue,
  type DatabaseView,
} from '@exocortex/contracts';
import {
  Button,
  EmptyState,
  LoadingState,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@exocortex/ui';

import { useDatabaseRows, useUpdateDatabaseView } from '@/lib/api/database-queries';

interface CalendarViewProps {
  workspaceId: string;
  documentId: string;
  view: DatabaseView;
  properties: DatabaseProperty[];
  readOnly: boolean;
}

const WEEKDAY_LABELS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
const MONTH_FORMATTER = new Intl.DateTimeFormat('de-DE', { month: 'long', year: 'numeric' });
const TIME_FORMATTER = new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit' });

/** One appearance of a row in one day cell. A span produces several. */
interface CalendarEntry {
  row: DatabaseRow;
  start: string;
  allDay: boolean;
}

/** Days of `month` (0-indexed) laid out into a Monday-first 6x7 grid, including the leading/trailing days of neighbouring months. */
function buildMonthGrid(year: number, month: number): Date[] {
  const first = new Date(Date.UTC(year, month, 1));
  const startWeekday = (first.getUTCDay() + 6) % 7; // 0 = Monday
  const start = new Date(first);
  start.setUTCDate(start.getUTCDate() - startWeekday);

  return Array.from({ length: 42 }, (_, index) => {
    const day = new Date(start);
    day.setUTCDate(day.getUTCDate() + index);
    return day;
  });
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function pad(part: number): string {
  return String(part).padStart(2, '0');
}

/**
 * Which grid cell an instant belongs in.
 *
 * The two cases are not interchangeable. An all-day value is a *floating*
 * calendar date stored as UTC midnight, so it is read straight off the ISO
 * string: converting it into the viewer's zone would push every birthday a day
 * back for anyone west of Greenwich. A timed value is a real instant, so it
 * belongs in the day the viewer sees it in, which for a 00:30 Berlin
 * appointment is *not* its UTC day.
 */
function dayKeyOf(iso: string, allDay: boolean): string {
  if (allDay) return iso.slice(0, 10);
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso.slice(0, 10);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Upper bound on how many cells one row may occupy. A span longer than a year
 * is a data error rather than an appointment, and without the cap a single bad
 * row would allocate an entry per day for as long as it lasts.
 */
const MAX_SPANNED_DAYS = 366;

/** Reads either DATE response shape; null for anything the calendar cannot plot. */
function readCalendarDate(
  value: DatabaseRowPropertyValue['value'] | undefined,
): { start: string; end: string | null; allDay: boolean } | null {
  if (typeof value === 'string') return { start: value, end: null, allDay: false };
  if (value !== null && typeof value === 'object' && !Array.isArray(value) && 'start' in value) {
    return { start: value.start, end: value.end, allDay: value.allDay };
  }
  return null;
}

/**
 * Every day key a value covers. `end` is exclusive, so a span ending at
 * midnight does not bleed into the next cell: the last covered day is the one
 * containing `end - 1ms`.
 */
function coveredDayKeys(start: string, end: string | null, allDay: boolean): string[] {
  const startKey = dayKeyOf(start, allDay);
  if (end === null) return [startKey];

  const startDate = new Date(start);
  const endDate = new Date(end);
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) return [startKey];
  if (endDate.getTime() <= startDate.getTime()) return [startKey];

  const lastKey = dayKeyOf(new Date(endDate.getTime() - 1).toISOString(), allDay);
  const keys: string[] = [];
  const cursor = new Date(startDate);
  while (keys.length < MAX_SPANNED_DAYS) {
    const key = dayKeyOf(cursor.toISOString(), allDay);
    // Stepping 24h can land on the same local date across a DST change, so a
    // repeat is skipped rather than producing the row twice in one cell.
    if (keys[keys.length - 1] !== key) keys.push(key);
    if (key === lastKey) break;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return keys;
}

// `readOnly` isn't needed yet: the calendar has no inline write affordance of
// its own (rows are edited on their own page), but the prop stays part of
// the shared per-view-type signature `database-shell.tsx` calls with.
export function CalendarView({ workspaceId, documentId, view, properties }: CalendarViewProps) {
  const dateProperties = properties.filter((property) => property.type === 'DATE');
  const updateView = useUpdateDatabaseView(documentId);
  const dateProperty = properties.find((property) => property.id === view.config.datePropertyId);

  if (dateProperty === undefined) {
    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <div className="flex max-w-sm flex-col items-center gap-3 text-center">
          <p className="text-sm text-muted-foreground">
            Wähle eine Datums-Eigenschaft, nach der die Zeilen einsortiert werden.
          </p>
          {dateProperties.length === 0 ? (
            <p className="text-xs text-muted-foreground">Diese Datenbank hat noch keine Eigenschaft vom Typ „Datum“.</p>
          ) : (
            <Select
              value={null}
              onValueChange={(propertyId: string | null) => {
                if (propertyId === null) return;
                updateView.mutate({ viewId: view.id, request: { config: { datePropertyId: propertyId } } });
              }}
            >
              <SelectTrigger className="w-56">
                <SelectValue>
                  {(value: string | null) =>
                    value === null ? 'Eigenschaft wählen' : dateProperties.find((p) => p.id === value)?.name
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {dateProperties.map((property) => (
                  <SelectItem key={property.id} value={property.id}>
                    {property.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
      </div>
    );
  }

  return (
    <CalendarMonth workspaceId={workspaceId} documentId={documentId} view={view} dateProperty={dateProperty} />
  );
}

function CalendarMonth({
  workspaceId,
  documentId,
  view,
  dateProperty,
}: {
  workspaceId: string;
  documentId: string;
  view: DatabaseView;
  dateProperty: DatabaseProperty;
}) {
  const today = new Date();
  // Local, not UTC: at 00:30 in Berlin the UTC date is still yesterday, which
  // would open the calendar on the wrong month on the first of the month and
  // highlight the wrong cell as today.
  const [cursor, setCursor] = React.useState(() => ({ year: today.getFullYear(), month: today.getMonth() }));

  // The API resolves `viewId` to the view's own saved filters/sorts and
  // ignores any inline `filters` alongside it, so rows with no date are
  // filtered out client-side below instead of via an extra server-side
  // condition here.
  const rowsQuery = useDatabaseRows(documentId, { viewId: view.id, limit: 100 });

  if (rowsQuery.isPending) return <LoadingState variant="skeleton" rows={4} label="Termine werden geladen" />;
  if (rowsQuery.isError) return <EmptyState title="Termine nicht geladen" description="Bitte versuche es erneut." />;

  // A span occupies every day it touches, not only the day it starts on: a
  // three-day trip that appears in one cell reads as a one-day trip.
  const rowsByDay = new Map<string, CalendarEntry[]>();
  for (const row of rowsQuery.data.rows) {
    const value = row.values.find((entry) => entry.propertyId === dateProperty.id)?.value;
    const span = readCalendarDate(value);
    if (span === null) continue;
    const entry: CalendarEntry = { row, start: span.start, allDay: span.allDay };
    for (const key of coveredDayKeys(span.start, span.end, span.allDay)) {
      const list = rowsByDay.get(key);
      if (list === undefined) rowsByDay.set(key, [entry]);
      else list.push(entry);
    }
  }
  // Chronological within a day, with all-day entries first: that is the order a
  // day is read in, and the row order from the query has no meaning here.
  for (const list of rowsByDay.values()) {
    list.sort((left, right) => {
      if (left.allDay !== right.allDay) return left.allDay ? -1 : 1;
      return left.start.localeCompare(right.start);
    });
  }

  const days = buildMonthGrid(cursor.year, cursor.month);
  const todayKey = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;

  return (
    <div className="flex min-h-0 flex-1 flex-col p-3">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-sm font-medium capitalize">{MONTH_FORMATTER.format(new Date(cursor.year, cursor.month))}</p>
        <div className="flex gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Vorheriger Monat"
            onClick={() => setCursor((current) => normalizeMonth(current.year, current.month - 1))}
          >
            <ChevronLeftIcon />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Nächster Monat"
            onClick={() => setCursor((current) => normalizeMonth(current.year, current.month + 1))}
          >
            <ChevronRightIcon />
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-7 border-t border-l border-border text-xs">
        {WEEKDAY_LABELS.map((label) => (
          <div key={label} className="border-r border-b border-border bg-surface px-2 py-1 text-muted-foreground">
            {label}
          </div>
        ))}
        {days.map((day) => {
          const key = isoDay(day);
          const inMonth = day.getUTCMonth() === cursor.month;
          const rows = rowsByDay.get(key) ?? [];
          return (
            <div
              key={key}
              className={`flex min-h-24 flex-col gap-1 border-r border-b border-border p-1 ${inMonth ? '' : 'bg-surface/50'}`}
            >
              <span className={`text-[0.6875rem] ${key === todayKey ? 'font-semibold text-primary-text' : 'text-muted-foreground'} ${inMonth ? '' : 'opacity-50'}`}>
                {day.getUTCDate()}
              </span>
              {rows.slice(0, 3).map((entry) => (
                <Link
                  key={entry.row.document.id}
                  href={`/arbeitsbereich/${workspaceId}/seite/${entry.row.document.id}`}
                  className="truncate rounded bg-accent-solid px-1 py-0.5 text-[0.6875rem] hover:underline"
                >
                  {entry.allDay ? null : (
                    <span className="mr-1 text-muted-foreground">{TIME_FORMATTER.format(new Date(entry.start))}</span>
                  )}
                  {entry.row.document.title}
                </Link>
              ))}
              {rows.length > 3 ? (
                <span className="text-[0.6875rem] text-muted-foreground">+{rows.length - 3} weitere</span>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function normalizeMonth(year: number, month: number): { year: number; month: number } {
  if (month < 0) return { year: year - 1, month: 11 };
  if (month > 11) return { year: year + 1, month: 0 };
  return { year, month };
}
