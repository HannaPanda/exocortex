'use client';

import { CalendarIcon } from 'lucide-react';
import * as React from 'react';

import { cn } from '../lib/utils';

import { Button } from './ui/button';
import { Calendar } from './ui/calendar';
import { Input } from './ui/input';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';

/**
 * The one way a date is entered in eXocortex: a button naming the day, and
 * `Calendar` in a `Popover` under it (decided 2026-09-24, see `DESIGN.md` §5,
 * "Inputs / Fields"). The shadcn registry ships this only as an example
 * (`date-picker-demo`), not as a component, so the composition lives here once
 * instead of at every call site.
 *
 * The value is the string a date input used to hold, `YYYY-MM-DD`, or `null`
 * for no date, so a call site that stored one keeps its conversions. The day
 * is read in the browser's zone, never as UTC midnight: `2026-10-05` is the
 * fifth wherever it is shown.
 *
 * What the native field did and this keeps: clearing (`clearable`), jumping to
 * today, and reaching a distant year without a hundred clicks (the month and
 * year dropdowns). What it gives up is typing a date, which was the trade-off
 * of the decision.
 */

/** `YYYY-MM-DD` as a local day, or `undefined` for anything else. */
export function parseDateValue(value: string | null | undefined): Date | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value ?? '');
  if (match === null) return undefined;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

/** A local day as `YYYY-MM-DD`. */
export function formatDateValue(date: Date): string {
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

const BUTTON_LABEL = new Intl.DateTimeFormat('de-DE', {
  weekday: 'short',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});

/** How far the year dropdown reaches: a birthday back, a plan forward. */
const START_MONTH = new Date(1900, 0);
const END_MONTH = new Date(new Date().getFullYear() + 30, 11);

/** The trigger's look: a field, not a button, in both of its forms. */
function triggerClassName(
  variant: 'outline' | 'ghost',
  size: 'default' | 'sm',
  empty: boolean,
  className: string | undefined,
): string {
  return cn(
    'justify-start font-normal tabular-nums',
    size === 'sm' ? 'h-8 px-2.5' : 'h-9 px-3',
    // The input border and shadow, so it sits beside a time or text field as
    // one of them; in a table cell, no chrome until the pointer is on it.
    variant === 'outline'
      ? 'border-input shadow-xs'
      : 'border border-transparent px-1.5 hover:border-input hover:bg-transparent',
    empty && 'text-muted-foreground',
    'aria-invalid:border-destructive aria-invalid:ring-destructive/20',
    className,
  );
}

export interface DatePickerProps {
  value: string | null;
  onChange: (value: string | null) => void;
  /** Offers "Entfernen" in the popover. Off where a day is required. */
  clearable?: boolean;
  placeholder?: string;
  disabled?: boolean;
  /** Shows the day as text, with no control at all. */
  readOnly?: boolean;
  /** `ghost` for a table cell, where the field has no chrome at rest. */
  variant?: 'outline' | 'ghost';
  size?: 'default' | 'sm';
  id?: string;
  className?: string;
  'aria-label'?: string;
  'aria-labelledby'?: string;
  'aria-invalid'?: boolean;
  'data-testid'?: string;
}

export function DatePicker({
  value,
  onChange,
  clearable = false,
  placeholder = 'Datum wählen',
  disabled = false,
  readOnly = false,
  variant = 'outline',
  size = 'default',
  id,
  className,
  'aria-label': ariaLabel,
  'aria-labelledby': ariaLabelledBy,
  'aria-invalid': ariaInvalid,
  'data-testid': testId,
}: DatePickerProps) {
  const [open, setOpen] = React.useState(false);
  // Shown at once, before the owner's own state or the server catches up; a
  // new value from outside replaces it, adjusted while rendering rather than
  // in an effect.
  const [shown, setShown] = React.useState(value);
  const [previous, setPrevious] = React.useState(value);
  if (value !== previous) {
    setPrevious(value);
    setShown(value);
  }

  const selected = parseDateValue(shown);
  const label = selected === undefined ? null : BUTTON_LABEL.format(selected);

  if (readOnly) {
    return (
      <span className={cn('px-1.5 text-sm', label === null && 'text-muted-foreground', className)}>
        {label ?? ''}
      </span>
    );
  }

  const commit = (next: string | null): void => {
    setShown(next);
    setOpen(false);
    onChange(next);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            id={id}
            type="button"
            variant={variant}
            disabled={disabled}
            aria-label={
              ariaLabel === undefined ? undefined : `${ariaLabel}: ${label ?? placeholder}`
            }
            aria-labelledby={ariaLabelledBy}
            aria-invalid={ariaInvalid}
            data-testid={testId}
            data-slot="date-picker"
            className={triggerClassName(variant, size, label === null, className)}
          />
        }
      >
        <CalendarIcon className="text-muted-foreground" aria-hidden />
        <span className="truncate">{label ?? placeholder}</span>
      </PopoverTrigger>
      {/* The day picker focuses the chosen day, or today, itself; the
          popover's own initial focus would land on the month dropdown. */}
      <PopoverContent align="start" className="w-auto p-0" initialFocus={false}>
        <Calendar
          autoFocus
          mode="single"
          captionLayout="dropdown"
          startMonth={START_MONTH}
          endMonth={END_MONTH}
          selected={selected}
          defaultMonth={selected}
          onSelect={(day) => {
            // A click on the chosen day deselects it in react-day-picker;
            // here that is "keep it", and removing is the explicit button.
            if (day !== undefined) commit(formatDateValue(day));
            else setOpen(false);
          }}
        />
        <div className="flex items-center justify-between gap-2 border-t border-border p-2">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => commit(formatDateValue(new Date()))}
          >
            Heute
          </Button>
          {clearable && shown !== null ? (
            <Button type="button" size="sm" variant="ghost" onClick={() => commit(null)}>
              Entfernen
            </Button>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}

export interface DateTimePickerProps extends Omit<DatePickerProps, 'value' | 'onChange'> {
  /** `YYYY-MM-DDTHH:MM`, the value a `datetime-local` input held, or `null`. */
  value: string | null;
  onChange: (value: string | null) => void;
  /** The time a day gets when it is picked without one. */
  defaultTime?: string;
}

/**
 * A day and a time: the picker above, and the browser's time field beside it.
 * The time stays native because it is typed, not browsed, and it is disabled
 * until there is a day for it to belong to.
 */
export function DateTimePicker({
  value,
  onChange,
  defaultTime = '09:00',
  readOnly,
  disabled,
  size = 'default',
  variant = 'outline',
  className,
  'aria-label': ariaLabel,
  'data-testid': testId,
  ...rest
}: DateTimePickerProps) {
  const [day = null, time = null] = value === null ? [] : value.split('T');
  const timeLabel = ariaLabel === undefined ? 'Uhrzeit' : `${ariaLabel}, Uhrzeit`;

  if (readOnly) {
    return (
      <span className={cn('flex items-center gap-1 text-sm', className)}>
        <DatePicker value={day} onChange={() => undefined} readOnly />
        {time}
      </span>
    );
  }

  return (
    <div className={cn('flex min-w-0 items-center gap-1.5', className)}>
      <DatePicker
        {...rest}
        value={day}
        size={size}
        variant={variant}
        disabled={disabled}
        aria-label={ariaLabel}
        data-testid={testId}
        onChange={(next) => onChange(next === null ? null : `${next}T${time ?? defaultTime}`)}
      />
      <Input
        type="time"
        aria-label={timeLabel}
        disabled={disabled === true || day === null}
        value={time ?? ''}
        data-testid={testId === undefined ? undefined : `${testId}-time`}
        className={cn(
          'w-auto shrink-0 tabular-nums',
          size === 'sm' && 'h-8',
          variant === 'ghost' &&
            'border-transparent bg-transparent px-1.5 shadow-none hover:border-input',
        )}
        onChange={(event) => {
          if (day !== null && event.target.value.length > 0) {
            onChange(`${day}T${event.target.value}`);
          }
        }}
      />
    </div>
  );
}
