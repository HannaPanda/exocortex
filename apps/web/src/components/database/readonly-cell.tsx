'use client';

import { useTranslations } from 'next-intl';

import { type DatabaseProperty, type DatabaseRowHeight } from '@exocortex/contracts';
import { cn } from '@exocortex/ui';

import { useFormatter } from '@/lib/formatter';

import { type CellValue } from './cells';
import { ROW_HEIGHT_LINE_CLAMP } from './table-columns';

/**
 * The cell of a value the query engine computes: created and updated time, a
 * rollup, a formula. Nothing here is editable, so the whole job is formatting
 * (split out of `cells.tsx`, issue #97).
 */

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T/;
/** A whole day, which the API sends without a time (issue #255). */
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

type Translator = ReturnType<typeof useTranslations<'database.cells'>>;
type Formatter = ReturnType<typeof useFormatter>;

function formatComputed(
  property: DatabaseProperty,
  value: CellValue,
  t: Translator,
  format: Formatter,
): string {
  if (value === null) return '–';
  if (property.type === 'CREATED_TIME' || property.type === 'UPDATED_TIME') {
    return formatInstant(String(value), format);
  }
  // A formula answers a number, a text, a date or a yes/no, and the cell only
  // ever sees the value. An ISO instant is recognised by its shape so a date
  // formula reads like a date column rather than like a timestamp.
  if (typeof value === 'boolean') return value ? t('yes') : t('no');
  if (typeof value === 'string' && ISO_INSTANT.test(value)) return formatInstant(value, format);
  if (typeof value === 'string' && ISO_DAY.test(value)) return formatDay(value, format);
  if (typeof value === 'number') return format.number(value, { maximumFractionDigits: 6 });
  return String(value);
}

/** A whole day is the same day everywhere, so it is read in UTC, where it was stored. */
function formatDay(value: string, format: Formatter): string {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime())
    ? value
    : format.dateTime(parsed, { dateStyle: 'medium', timeZone: 'UTC' });
}

function formatInstant(value: string, format: Formatter): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? value
    : format.dateTime(parsed, { dateStyle: 'medium', timeStyle: 'short' });
}

/**
 * The same text for a card on a board or in a gallery (issue #255), where a
 * created time or a date formula otherwise arrived as the raw ISO instant.
 */
export function useComputedValueFormat(): (property: DatabaseProperty, value: CellValue) => string {
  const t = useTranslations('database.cells');
  const format = useFormatter();
  return (property, value) => formatComputed(property, value, t, format);
}

export function ReadonlyCell({
  property,
  value,
  rowHeight = 'short',
}: {
  property: DatabaseProperty;
  value: CellValue;
  rowHeight?: DatabaseRowHeight;
}) {
  const t = useTranslations('database.cells');
  const format = useFormatter();
  const text = formatComputed(property, value, t, format);
  return (
    <div
      className="flex min-h-8 items-start px-1.5 py-1.5 text-sm text-muted-foreground"
      data-testid="readonly-cell"
    >
      <span
        title={text}
        className={cn('break-words whitespace-normal', ROW_HEIGHT_LINE_CLAMP[rowHeight])}
      >
        {text}
      </span>
    </div>
  );
}
