'use client';

import * as React from 'react';
import { useLocale } from 'use-intl';

import {
  formatTimeOfDay,
  type HourCycle,
  parseTimeOfDay,
  readTimeOfDay,
  stepTimeOfDay,
} from '../lib/time-of-day';
import { cn } from '../lib/utils';

import { useHourCycle } from './hour-cycle';
import { Input } from './ui/input';

/**
 * The one way a time of day is entered in eXocortex (issue #255): a text
 * field that shows the time on the reader's clock and takes it typed.
 *
 * It replaces the browser's `type="time"`, which follows the operating
 * system rather than the interface: a German interface on an English Windows
 * read "12:00 PM", and no attribute changes that. A time stays typed rather
 * than browsed, which is why the date beside it has a calendar and this has
 * none. The value is the same `HH:MM` on a 24-hour clock the native field
 * held, so every call site keeps its conversions.
 *
 * Typing is forgiving and never guesses: `14:30`, `1430`, `2:30 pm` and the
 * language's own day period are read on blur or Enter; anything that is not
 * a time puts the last value back. Escape does the same at once. The arrow
 * keys move a quarter of an hour (with Shift, an hour) and land on it.
 */
export interface TimeInputProps {
  /** `HH:MM` on a 24-hour clock, or `null` for no time. */
  value: string | null;
  onChange: (value: string | null) => void;
  /** Lets an emptied field mean "no time". Off where a time is required. */
  clearable?: boolean;
  /** The clock to write on; the provider's (the account's) when left out. */
  hourCycle?: HourCycle;
  disabled?: boolean;
  /** `ghost` for a table cell, where the field has no chrome at rest. */
  variant?: 'outline' | 'ghost';
  size?: 'default' | 'sm';
  placeholder?: string;
  id?: string;
  className?: string;
  'aria-label'?: string;
  'aria-labelledby'?: string;
  'aria-describedby'?: string;
  'data-testid'?: string;
}

/** Wide enough for the longest time this clock writes, so a value never scrolls. */
function widthFor(locale: string, cycle: HourCycle | undefined): number {
  return Math.max(
    5,
    formatTimeOfDay('22:58', locale, cycle).length,
    formatTimeOfDay('10:58', locale, cycle).length,
  );
}

export function TimeInput({
  value,
  onChange,
  clearable = false,
  hourCycle: ownCycle,
  disabled = false,
  variant = 'outline',
  size = 'default',
  placeholder,
  id,
  className,
  'aria-label': ariaLabel,
  'aria-labelledby': ariaLabelledBy,
  'aria-describedby': ariaDescribedBy,
  'data-testid': testId,
}: TimeInputProps) {
  const locale = useLocale();
  const providedCycle = useHourCycle();
  const cycle = ownCycle ?? providedCycle;
  const shown = formatTimeOfDay(value, locale, cycle);
  // What is being typed; null while the field shows the value itself.
  const [draft, setDraft] = React.useState<string | null>(null);

  const commit = (text: string): void => {
    setDraft(null);
    if (text.trim().length === 0) {
      if (clearable && value !== null) onChange(null);
      return;
    }
    const next = parseTimeOfDay(text, locale);
    if (next !== null && next !== value) onChange(next);
  };

  const step = (delta: number): void => {
    const base = draft === null ? value : (parseTimeOfDay(draft, locale) ?? value);
    const next = stepTimeOfDay(readTimeOfDay(base) === null ? null : base, delta);
    setDraft(formatTimeOfDay(next, locale, cycle));
    onChange(next);
  };

  return (
    <Input
      type="text"
      inputMode="text"
      autoComplete="off"
      spellCheck={false}
      id={id}
      disabled={disabled}
      placeholder={placeholder ?? formatTimeOfDay('09:00', locale, cycle)}
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
      aria-describedby={ariaDescribedBy}
      data-testid={testId}
      data-slot="time-input"
      size={widthFor(locale, cycle)}
      value={draft ?? shown}
      className={cn(
        'w-auto shrink-0 tabular-nums',
        size === 'sm' && 'h-8',
        variant === 'ghost' &&
          'border-transparent bg-transparent px-1.5 shadow-none hover:border-input',
        className,
      )}
      onFocus={(event) => {
        setDraft(shown);
        event.currentTarget.select();
      }}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={(event) => commit(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          commit(event.currentTarget.value);
          setDraft(
            formatTimeOfDay(
              parseTimeOfDay(event.currentTarget.value, locale) ?? value,
              locale,
              cycle,
            ),
          );
        } else if (event.key === 'Escape' && draft !== null && draft !== shown) {
          // Takes the typing back; a second Escape reaches the dialog or
          // popover around the field as before.
          event.preventDefault();
          event.stopPropagation();
          setDraft(shown);
        } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
          event.preventDefault();
          const amount = event.shiftKey ? 60 : 15;
          step(event.key === 'ArrowUp' ? amount : -amount);
        }
      }}
    />
  );
}
