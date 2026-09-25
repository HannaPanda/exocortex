'use client';

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

function formatComputed(property: DatabaseProperty, value: CellValue): string {
  if (value === null) return '–';
  if (property.type === 'CREATED_TIME' || property.type === 'UPDATED_TIME') {
    return formatInstant(String(value));
  }
  // A formula answers a number, a text, a date or a yes/no, and the cell only
  // ever sees the value. An ISO instant is recognised by its shape so a date
  // formula reads like a date column rather than like a timestamp.
  if (typeof value === 'boolean') return value ? 'Ja' : 'Nein';
  if (typeof value === 'string' && ISO_INSTANT.test(value)) return formatInstant(value);
  if (typeof value === 'number') return value.toLocaleString('de-DE', { maximumFractionDigits: 6 });
  return String(value);
}

function formatInstant(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? value
    : parsed.toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' });
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
  const text = formatComputed(property, value);
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
