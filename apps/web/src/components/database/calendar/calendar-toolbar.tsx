'use client';

import { ChevronLeftIcon, ChevronRightIcon } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import * as React from 'react';

import { type DatabaseCalendarMode } from '@exocortex/contracts';
import { Button, DatePicker, Toggle, ToggleGroup } from '@exocortex/ui';

import {
  CALENDAR_MODES,
  calendarLabel,
  fromDateInputValue,
  stepAnchor,
  toDateInputValue,
} from './range';

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
  const t = useTranslations('calendar.toolbar');
  const tModes = useTranslations('calendar.modes');
  const tSteps = useTranslations('calendar.steps');
  const locale = useLocale();
  const period = calendarLabel(mode, anchor, locale, {
    withinMonth: (fromDay, to) => t('weekWithinMonth', { fromDay, to }),
    range: (from, to) => t('weekRange', { from, to }),
  });

  return (
    <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
      <div className="flex items-center gap-1">
        <Button variant="outline" size="sm" onClick={() => onAnchorChange(new Date())}>
          {t('today')}
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={tSteps(`${mode}.previous`)}
          onClick={() => onAnchorChange(stepAnchor(mode, anchor, -1))}
        >
          <ChevronLeftIcon />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={tSteps(`${mode}.next`)}
          onClick={() => onAnchorChange(stepAnchor(mode, anchor, 1))}
        >
          <ChevronRightIcon />
        </Button>
        <p className="ml-1 text-sm font-medium" data-testid="calendar-period">
          {period}
        </p>
      </div>

      <div className="flex items-center gap-2">
        <DatePicker
          size="sm"
          aria-label={t('jumpTo')}
          value={toDateInputValue(anchor)}
          onChange={(value) => {
            const picked = value === null ? null : fromDateInputValue(value);
            if (picked !== null) onAnchorChange(picked);
          }}
        />
        <ToggleGroup
          aria-label={t('modeSwitch')}
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
              {tModes(entry)}
            </Toggle>
          ))}
        </ToggleGroup>
      </div>
    </div>
  );
}
