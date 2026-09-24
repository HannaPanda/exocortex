'use client';

import * as React from 'react';

import {
  type DatabaseCalendarMode,
  type DatabaseProperty,
  type DatabaseView,
} from '@exocortex/contracts';
import {
  Alert,
  AlertDescription,
  ErrorState,
  LoadingState,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@exocortex/ui';

import { useDatabaseCalendarRows, useUpdateDatabaseView } from '@/lib/api/database-queries';

import { AgendaView } from './calendar/agenda-view';
import { CalendarToolbar } from './calendar/calendar-toolbar';
import { groupEntriesByDay, toCalendarEntries } from './calendar/entries';
import { MonthView } from './calendar/month-view';
import { addDays, calendarWindow, queryWindow, startOfWeek } from './calendar/range';
import { TimeGridView } from './calendar/time-grid-view';
import { YearView } from './calendar/year-view';

interface CalendarViewProps {
  workspaceId: string;
  documentId: string;
  view: DatabaseView;
  properties: DatabaseProperty[];
  readOnly: boolean;
}

/**
 * The calendar view of a database: five projections of the same rows.
 *
 * A mode is a field on the view (`config.calendarMode`), not a second view and
 * not browser state, so the choice survives a reload on another device and an
 * agent can read and set it like any other view setting (ADR-025). Everything
 * else here is per-session: which day is in the middle is a question about
 * right now, not a property of the view.
 */
export function CalendarView({
  workspaceId,
  documentId,
  view,
  properties,
  readOnly,
}: CalendarViewProps) {
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
            <p className="text-xs text-muted-foreground">
              Diese Datenbank hat noch keine Eigenschaft vom Typ „Datum“.
            </p>
          ) : (
            <Select
              value={null}
              onValueChange={(propertyId: string | null) => {
                if (propertyId === null) return;
                updateView.mutate({
                  viewId: view.id,
                  request: { config: { datePropertyId: propertyId } },
                });
              }}
            >
              <SelectTrigger className="w-56" data-testid="calendar-date-property">
                <SelectValue>
                  {(value: string | null) =>
                    value === null
                      ? 'Eigenschaft wählen'
                      : dateProperties.find((p) => p.id === value)?.name
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
    <CalendarBody
      workspaceId={workspaceId}
      documentId={documentId}
      view={view}
      datePropertyId={dateProperty.id}
      readOnly={readOnly}
    />
  );
}

function CalendarBody({
  workspaceId,
  documentId,
  view,
  datePropertyId,
  readOnly,
}: {
  workspaceId: string;
  documentId: string;
  view: DatabaseView;
  datePropertyId: string;
  readOnly: boolean;
}) {
  const updateView = useUpdateDatabaseView(documentId);
  // The stored mode is the starting point, not a controlled value: the switch
  // has to answer immediately, and the view's own refetch arrives later.
  const [mode, setMode] = React.useState<DatabaseCalendarMode>(view.config.calendarMode);
  const [anchor, setAnchor] = React.useState(() => new Date());

  // Named `period`, not `window`: the global of that name is what a browser
  // file reaches for by reflex, and shadowing it reads as a bug later.
  const period = React.useMemo(() => calendarWindow(mode, anchor), [mode, anchor]);
  const range = React.useMemo(() => queryWindow(period), [period]);
  const rowsQuery = useDatabaseCalendarRows({
    documentId,
    viewId: view.id,
    datePropertyId,
    from: range.from,
    to: range.to,
  });

  const entriesByDay = React.useMemo(
    () => groupEntriesByDay(toCalendarEntries(rowsQuery.data?.rows ?? [], datePropertyId)),
    [rowsQuery.data, datePropertyId],
  );

  function changeMode(next: DatabaseCalendarMode) {
    setMode(next);
    // A view someone may not write to still switches; it simply opens in its
    // stored mode next time, which is the same thing the tabs do.
    if (!readOnly) {
      updateView.mutate({ viewId: view.id, request: { config: { calendarMode: next } } });
    }
  }

  function openDay(day: Date) {
    setAnchor(day);
    changeMode('DAY');
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col p-3" data-testid="calendar-view">
      <CalendarToolbar
        mode={mode}
        anchor={anchor}
        onModeChange={changeMode}
        onAnchorChange={setAnchor}
      />

      {rowsQuery.data?.complete === false ? (
        <Alert className="mb-2">
          <AlertDescription>
            Dieser Zeitraum enthält mehr Einträge, als hier gezeigt werden. Wähle einen kürzeren
            Zeitraum, um alle zu sehen.
          </AlertDescription>
        </Alert>
      ) : null}

      {renderBody()}
    </div>
  );

  function renderBody() {
    if (rowsQuery.isPending) {
      return <LoadingState variant="skeleton" rows={4} label="Termine werden geladen" />;
    }
    if (rowsQuery.isError) {
      return <ErrorState title="Termine nicht geladen" onRetry={() => void rowsQuery.refetch()} />;
    }
    if (mode === 'DAY' || mode === 'WEEK') {
      // The only mode that scrolls itself: its axis is taller than the box, and
      // the header row and the all-day band have to stay put while it moves.
      return (
        <TimeGridView
          workspaceId={workspaceId}
          days={columnDays(mode, anchor)}
          entriesByDay={entriesByDay}
        />
      );
    }
    return (
      <div className="min-h-0 flex-1 overflow-y-auto">
        {mode === 'MONTH' ? (
          <MonthView
            workspaceId={workspaceId}
            anchor={anchor}
            entriesByDay={entriesByDay}
            onOpenDay={openDay}
          />
        ) : null}
        {mode === 'YEAR' ? (
          <YearView
            anchor={anchor}
            entriesByDay={entriesByDay}
            onOpenDay={openDay}
            onOpenMonth={(day) => {
              setAnchor(day);
              changeMode('MONTH');
            }}
          />
        ) : null}
        {mode === 'LIST' ? (
          <AgendaView
            workspaceId={workspaceId}
            from={period.from}
            to={period.to}
            entriesByDay={entriesByDay}
          />
        ) : null}
      </div>
    );
  }
}

/** The columns of a time grid: one day, or the Monday-to-Sunday week around it. */
function columnDays(mode: 'DAY' | 'WEEK', anchor: Date): Date[] {
  if (mode === 'DAY') return [new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate())];
  const monday = startOfWeek(anchor);
  return Array.from({ length: 7 }, (_, index) => addDays(monday, index));
}
