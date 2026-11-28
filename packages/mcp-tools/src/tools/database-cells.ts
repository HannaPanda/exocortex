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

/**
 * A PERSON, CREATED_BY or UPDATED_BY value by name (issue #314), beside the
 * id a write needs. Somebody who left the workspace keeps their name with a
 * note; an id the row's `people` do not answer for is a deleted account.
 */
export function formatPeople(
  value: DatabaseRowPropertyValue['value'],
  row: DatabaseRow,
): string | null {
  if (row.people === undefined) return null;
  const ids = typeof value === 'string' ? [value] : Array.isArray(value) ? value : null;
  if (ids === null) return null;
  const people = new Map(row.people.map((person) => [person.id, person] as const));
  return ids
    .map((id) => {
      const person = people.get(id);
      if (person === undefined) return `(gelöschtes Konto, id: ${id})`;
      return person.member
        ? `${person.name} (id: ${id})`
        : `${person.name} (kein Mitglied mehr, id: ${id})`;
    })
    .join(', ');
}

/** Which columns of a database need more than the bare value to be read. */
export interface CellColumns {
  /** DATE columns without a time: their values are whole days. */
  wholeDays: ReadonlySet<string>;
  /** FILES columns, shown by file name. */
  files: ReadonlySet<string>;
  /** PERSON, CREATED_BY and UPDATED_BY columns, shown by name. */
  people: ReadonlySet<string>;
}

export function cellColumnsOf(properties: readonly DatabaseProperty[]): CellColumns {
  return {
    wholeDays: wholeDayColumns(properties),
    files: new Set(properties.filter((p) => p.type === 'FILES').map((p) => p.id)),
    people: new Set(
      properties
        .filter((p) => p.type === 'PERSON' || p.type === 'CREATED_BY' || p.type === 'UPDATED_BY')
        .map((p) => p.id),
    ),
  };
}

/** One cell of `row` as text, by whatever its column needs to be read. */
export function formatRowCell(
  row: DatabaseRow,
  propertyId: string,
  value: DatabaseRowPropertyValue['value'],
  columns: CellColumns,
): string {
  if (columns.files.has(propertyId)) return formatFiles(value, row) ?? formatCell(value);
  if (columns.people.has(propertyId)) return formatPeople(value, row) ?? formatCell(value);
  return formatCell(value, columns.wholeDays.has(propertyId));
}

export function formatRow(row: DatabaseRow, columns: CellColumns): string[] {
  return [
    row.document.title,
    ...row.values.map((v) => formatRowCell(row, v.propertyId, v.value, columns)),
  ];
}
