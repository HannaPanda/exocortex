import {
  type DatabaseProperty,
  type DatabaseRow,
  type DatabaseRowPropertyValue,
  parseDatePropertyConfig,
} from '@exocortex/contracts';

/**
 * How the database tools write a row's cells as text. Split out of
 * `databases.ts` when the FILES cells got their names (issue #245).
 */

/**
 * One cell as table text. A date span is an object, so `String()` alone would
 * put "[object Object]" in front of the model where an appointment belongs.
 *
 * A time stays the ISO instant in UTC, which is unambiguous for a model and
 * for a script alike (issue #255); `data` carries it unchanged either way. A
 * whole day is written as the day: as an instant it is UTC midnight, which
 * reads as the evening before in any zone west of Greenwich. Whether a value
 * is a whole day comes from the span's own `allDay`, or from the column when
 * the caller knows it (`wholeDay`).
 */
export function formatCell(value: DatabaseRowPropertyValue['value'], wholeDay = false): string {
  if (value === null) return '';
  const day = (iso: string, whole: boolean) => (whole ? iso.slice(0, 10) : iso);
  if (typeof value === 'object' && !Array.isArray(value) && 'start' in value) {
    const whole = wholeDay || value.allDay;
    return value.end === null
      ? day(value.start, whole)
      : `${day(value.start, whole)} bis ${day(value.end, whole)}`;
  }
  if (typeof value === 'string' && wholeDay) return day(value, true);
  return String(value);
}

/** The DATE columns without a time: their values are whole days. */
export function wholeDayColumns(properties: readonly DatabaseProperty[]): Set<string> {
  return new Set(
    properties
      .filter(
        (property) =>
          property.type === 'DATE' && !parseDatePropertyConfig(property.config).includeTime,
      )
      .map((property) => property.id),
  );
}

/**
 * A FILES value by name rather than by id alone (issue #245): an id is what a
 * write needs, the name is what says which file it is. An id the row's
 * `files` do not answer for is a file that is gone.
 */
export function formatFiles(
  value: DatabaseRowPropertyValue['value'],
  row: DatabaseRow,
): string | null {
  if (row.files === undefined || !Array.isArray(value)) return null;
  const names = new Map(row.files.map((file) => [file.id, file.filename] as const));
  return value
    .map((id) => {
      const name = names.get(id);
      return name === undefined ? `(gelöscht, id: ${id})` : `${name} (id: ${id})`;
    })
    .join(', ');
}

export function formatRow(
  row: DatabaseRow,
  wholeDays: ReadonlySet<string>,
  fileColumns: ReadonlySet<string>,
): string[] {
  return [
    row.document.title,
    ...row.values.map((v) =>
      fileColumns.has(v.propertyId)
        ? (formatFiles(v.value, row) ?? formatCell(v.value))
        : formatCell(v.value, wholeDays.has(v.propertyId)),
    ),
  ];
}

/** The FILES columns, whose values are shown by file name. */
export function fileColumnsOf(properties: readonly DatabaseProperty[]): Set<string> {
  return new Set(properties.filter((p) => p.type === 'FILES').map((p) => p.id));
}
