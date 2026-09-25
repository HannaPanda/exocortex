import { useFormatter, useTranslations } from 'next-intl';
import * as React from 'react';

import {
  type DatabaseProperty,
  type DatabaseRowPropertyValue,
  parseDatePropertyConfig,
} from '@exocortex/contracts';
import { DatePicker, DateTimePicker } from '@exocortex/ui';

import { type PropertyCellProps } from './cells';

/**
 * The DATE cell and its value helpers, split out of `cells.tsx` when the
 * date entry became `DatePicker` (the decision of 2026-09-24).
 */

type CellValue = DatabaseRowPropertyValue['value'];

/**
 * Two input conventions, kept strictly apart because mixing them is how a
 * calendar ends up off by a timezone:
 *
 * - **Whole days** (`includeTime: false`, or an all-day span) use
 *   `DatePicker` and are stored as UTC midnight. Reading is a plain
 *   `slice(0, 10)` of the ISO string, which is the convention every DATE value
 *   in this codebase already followed.
 * - **Times** (`includeTime: true`) use `DateTimePicker`, whose value is the
 *   `datetime-local` string and speaks the viewer's wall clock. `new Date(localString)` parses it as local
 *   and `toISOString()` hands back the UTC instant, so the round-trip is exact.
 */
function isoDateOnly(iso: string | null): string {
  return iso === null ? '' : iso.slice(0, 10);
}

function isoToDateTimeLocal(iso: string | null): string {
  if (iso === null) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function inputToIso(raw: string, includeTime: boolean): string | null {
  if (raw.length === 0) return null;
  const date = includeTime ? new Date(raw) : new Date(`${raw}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Reads either DATE response shape into one internal form. */
interface DateCellValue {
  start: string | null;
  end: string | null;
  allDay: boolean;
}

function readDateValue(value: CellValue): DateCellValue {
  if (typeof value === 'string') return { start: value, end: null, allDay: false };
  if (value !== null && typeof value === 'object' && !Array.isArray(value) && 'start' in value) {
    return { start: value.start, end: value.end, allDay: value.allDay };
  }
  return { start: null, end: null, allDay: false };
}

/**
 * The reader's rendering of a DATE value in either shape. A span on one day
 * shows the day once and both times, which is how an appointment is normally
 * read; a span across days shows both sides in full. The returned function
 * answers null for an empty value so a caller can drop the element entirely.
 *
 * A whole day is stored as UTC midnight, so it is formatted in UTC: in the
 * reader's zone a reader west of Greenwich would see the day before.
 */
export function useDateValueFormat(): (
  property: DatabaseProperty,
  value: CellValue,
) => string | null {
  const t = useTranslations('database.cells');
  const format = useFormatter();
  return React.useCallback(
    (property: DatabaseProperty, value: CellValue): string | null => {
      const config = parseDatePropertyConfig(property.config);
      const { start, end, allDay } = readDateValue(value);
      if (start === null) return null;

      const withTime = config.includeTime && !allDay;
      const day = (iso: string) =>
        format.dateTime(new Date(iso), {
          dateStyle: 'medium',
          ...(withTime ? {} : { timeZone: 'UTC' }),
        });
      const time = (iso: string) => format.dateTime(new Date(iso), { timeStyle: 'short' });
      const full = (iso: string) =>
        withTime
          ? format.dateTime(new Date(iso), { dateStyle: 'medium', timeStyle: 'short' })
          : day(iso);

      if (end === null) return full(start);
      if (day(start) === day(end)) {
        return withTime
          ? t('sameDayTimeRange', { day: day(start), start: time(start), end: time(end) })
          : day(start);
      }
      return t('dateRange', { start: full(start), end: full(end) });
    },
    [t, format],
  );
}

/** One day, with or without its time, as the cell's picker. */
function DateField({
  iso,
  includeTime,
  readOnly,
  label,
  onPick,
}: {
  iso: string | null;
  includeTime: boolean;
  readOnly: boolean | undefined;
  label?: string;
  onPick: (iso: string | null) => void;
}) {
  const pick = (raw: string | null) => onPick(raw === null ? null : inputToIso(raw, includeTime));
  if (includeTime) {
    return (
      <DateTimePicker
        variant="ghost"
        size="sm"
        clearable
        value={isoToDateTimeLocal(iso) || null}
        readOnly={readOnly}
        aria-label={label}
        onChange={pick}
      />
    );
  }
  return (
    <DatePicker
      variant="ghost"
      size="sm"
      clearable
      value={isoDateOnly(iso) || null}
      readOnly={readOnly}
      aria-label={label}
      onChange={pick}
    />
  );
}

export function DateCell({ property, value, onChange, readOnly }: PropertyCellProps) {
  const t = useTranslations('database.cells');
  const config = parseDatePropertyConfig(property.config);
  const current = readDateValue(value);
  const includeTime = config.includeTime && !current.allDay;

  // A non-span property keeps writing the bare ISO string the API expects for
  // it; only a span property may send the object form.
  const emit = (next: DateCellValue) => {
    if (!config.isRange) {
      onChange(next.start);
      return;
    }
    if (next.start === null) {
      onChange(null);
      return;
    }
    onChange({ start: next.start, end: next.end, allDay: next.allDay });
  };

  if (!config.isRange) {
    return (
      <DateField
        iso={current.start}
        includeTime={includeTime}
        readOnly={readOnly}
        onPick={(start) => emit({ ...current, start })}
      />
    );
  }

  return (
    <div className="flex min-h-8 flex-col gap-0.5">
      <DateField
        iso={current.start}
        includeTime={includeTime}
        readOnly={readOnly}
        label={t('rangeStart')}
        onPick={(start) =>
          // Clearing the start clears the whole span: an end without a
          // beginning is not a value the API accepts.
          emit(
            start === null
              ? { start: null, end: null, allDay: current.allDay }
              : { ...current, start },
          )
        }
      />
      <DateField
        iso={current.end}
        includeTime={includeTime}
        readOnly={readOnly}
        label={t('rangeEnd')}
        onPick={(end) => emit({ ...current, end })}
      />
    </div>
  );
}
