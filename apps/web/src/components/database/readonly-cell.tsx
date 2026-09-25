'use client';

import { useFormatter, useTranslations } from 'next-intl';

import { type DatabaseProperty, type DatabaseRowHeight } from '@exocortex/contracts';
import { cn } from '@exocortex/ui';

import { type CellValue } from './cells';
import { ROW_HEIGHT_LINE_CLAMP } from './table-columns';

/**
 * The cell of a value the query engine computes: created and updated time, a
 * rollup, a formula. Nothing here is editable, so the whole job is formatting
 * (split out of `cells.tsx`, issue #97).
 */

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T/;

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
  if (typeof value === 'number') return format.number(value, { maximumFractionDigits: 6 });
  return String(value);
}

function formatInstant(value: string, format: Formatter): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? value
    : format.dateTime(parsed, { dateStyle: 'medium', timeStyle: 'short' });
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
