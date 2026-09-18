'use client';

import { ChevronLeftIcon, ChevronRightIcon } from 'lucide-react';
import * as React from 'react';

import { type DatabaseCalendarMode } from '@exocortex/contracts';
import { Button, Input, Toggle, ToggleGroup } from '@exocortex/ui';

import {
  CALENDAR_MODE_LABELS,
  CALENDAR_MODES,
  calendarLabel,
  fromDateInputValue,
  stepAnchor,
  toDateInputValue,
} from './range';

const STEP_LABELS: Record<DatabaseCalendarMode, { previous: string; next: string }> = {
  LIST: { previous: 'Vorheriger Monat', next: 'Nächster Monat' },
  DAY: { previous: 'Vorheriger Tag', next: 'Nächster Tag' },
  WEEK: { previous: 'Vorherige Woche', next: 'Nächste Woche' },
  MONTH: { previous: 'Vorheriger Monat', next: 'Nächster Monat' },
  YEAR: { previous: 'Vorheriges Jahr', next: 'Nächstes Jahr' },
};

interface CalendarToolbarProps {
  mode: DatabaseCalendarMode;
  anchor: Date;
  onModeChange: (mode: DatabaseCalendarMode) => void;
  onAnchorChange: (anchor: Date) => void;
}

/**
 * Period label, the four ways to move through time, and the mode switcher.
 *
 * The date picker is a native `input[type=date]`: on a phone it opens the
 * platform's own picker, which is the one the reader already knows, and it
 * costs no bundle at all.
 */
export function CalendarToolbar({
  mode,
  anchor,
  onModeChange,
  onAnchorChange,
}: CalendarToolbarProps) {
  const steps = STEP_LABELS[mode];

  return (
    <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
      <div className="flex items-center gap-1">
        <Button variant="outline" size="sm" onClick={() => onAnchorChange(new Date())}>
          Heute
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={steps.previous}
          onClick={() => onAnchorChange(stepAnchor(mode, anchor, -1))}
        >
          <ChevronLeftIcon />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={steps.next}
          onClick={() => onAnchorChange(stepAnchor(mode, anchor, 1))}
        >
          <ChevronRightIcon />
        </Button>
        <p className="ml-1 text-sm font-medium" data-testid="calendar-period">
          {calendarLabel(mode, anchor)}
        </p>
      </div>

      <div className="flex items-center gap-2">
        <Input
          type="date"
          aria-label="Datum wählen"
          className="h-8 w-40"
          value={toDateInputValue(anchor)}
          onChange={(event: React.ChangeEvent<HTMLInputElement>) => {
            const picked = fromDateInputValue(event.target.value);
            if (picked !== null) onAnchorChange(picked);
          }}
        />
        <ToggleGroup
          aria-label="Ansicht"
          value={[mode]}
          onValueChange={(next: string[]) => {
            // Base UI reports an empty array when the active item is pressed
            // again. A calendar with no mode is not a state, so that is a no-op.
            const picked = next[0];
            if (picked !== undefined) onModeChange(picked as DatabaseCalendarMode);
          }}
        >
          {CALENDAR_MODES.map((entry) => (
            <Toggle key={entry} value={entry} variant="outline" size="sm">
              {CALENDAR_MODE_LABELS[entry]}
            </Toggle>
          ))}
        </ToggleGroup>
      </div>
    </div>
  );
}
