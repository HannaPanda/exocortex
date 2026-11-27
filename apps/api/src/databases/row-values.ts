import {
  ARRAY_VALUED_PROPERTY_TYPES,
  databaseDateRangeValueSchema,
  type DatabasePropertyType,
  type DatabaseRowFile,
  type DatabaseRowPropertyValue,
  type FormulaValueType,
  instantFromIsoInput,
  parseDatePropertyConfig,
} from '@exocortex/contracts';
import {
  type DatabasePropertyRef,
  type DatabaseQueryRowRecord,
  type DatabaseQueryScope,
  Prisma,
} from '@exocortex/database';

import { AppError } from '../common/app-error';

/**
 * How a row's property values travel between the wire and the typed columns
 * of `document_property_value`, in both directions. Pure functions, shared by
 * the single-row and the batch routes of `DatabaseRowsService`.
 */

export const COMPUTED_TYPES = new Set<DatabasePropertyType>([
  'CREATED_TIME',
  'UPDATED_TIME',
  'CREATED_BY',
  'UPDATED_BY',
]);
const ARRAY_TYPES = new Set<DatabasePropertyType>(ARRAY_VALUED_PROPERTY_TYPES);

export function computedValue(type: DatabasePropertyType, row: DatabaseQueryRowRecord): string {
  switch (type) {
    case 'CREATED_TIME':
      return row.createdAt.toISOString();
    case 'UPDATED_TIME':
      return row.updatedAt.toISOString();
    case 'CREATED_BY':
      return row.createdById;
    case 'UPDATED_BY':
      return row.updatedById;
    default:
      throw new Error(`${type} is not a computed property type`);
  }
}

export interface StoredValueRow {
  propertyId: string;
  textValue: string | null;
  numberValue: unknown;
  boolValue: boolean | null;
  dateValue: Date | null;
  dateEndValue: Date | null;
  dateAllDay: boolean | null;
  jsonValue: unknown;
}

/**
 * Response shape of a DATE value is decided by the property, not by what
 * happens to be stored: `isRange: false` returns the bare ISO string every
 * client has always read, `isRange: true` returns the span object. Deriving it
 * from "is `dateEndValue` set?" instead would make the same property answer in
 * two different shapes depending on the row, which no client can type.
 */
function storedToDateResponseValue(
  property: DatabasePropertyRef,
  stored: StoredValueRow,
): DatabaseRowPropertyValue['value'] {
  if (stored.dateValue === null) return null;
  if (!parseDatePropertyConfig(property.config).isRange) return stored.dateValue.toISOString();
  return {
    start: stored.dateValue.toISOString(),
    end: stored.dateEndValue === null ? null : stored.dateEndValue.toISOString(),
    allDay: stored.dateAllDay ?? false,
  };
}

/**
 * A derived value on its way out.
 *
 * PostgreSQL answers `numeric` as a string or a Decimal depending on the
 * driver, and the wire contract says number, so the conversion happens here
 * once rather than in every client. An empty aggregate stays `null`: "no
 * linked rows had a date" is not a date.
 */
export function derivedToResponseValue(
  type: FormulaValueType,
  raw: unknown,
  wholeDay: boolean,
): DatabaseRowPropertyValue['value'] {
  if (raw === null || raw === undefined) return null;
  if (type === 'number') {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (type === 'boolean') return Boolean(raw);
  if (type === 'date') {
    // A whole day travels as the day itself (issue #255): as an instant it
    // is UTC midnight, which a reader west of Greenwich sees as the evening
    // before. `derivedDateIsWholeDay` decides which dates are whole days.
    const iso = raw instanceof Date ? raw.toISOString() : String(raw);
    return wholeDay && /^\d{4}-\d{2}-\d{2}T/.test(iso) ? iso.slice(0, 10) : iso;
  }
  return String(raw);
}

export function storedToResponseValue(
  property: DatabasePropertyRef,
  stored: StoredValueRow | undefined,
): DatabaseRowPropertyValue['value'] {
  if (stored === undefined) return null;
  if (property.type === 'NUMBER')
    return stored.numberValue === null ? null : Number(stored.numberValue);
  if (property.type === 'CHECKBOX') return stored.boolValue;
  if (property.type === 'DATE') return storedToDateResponseValue(property, stored);
  if (ARRAY_TYPES.has(property.type)) return (stored.jsonValue as string[] | null) ?? null;
  return stored.textValue;
}

export interface ColumnData {
  textValue: string | null;
  numberValue: number | null;
  boolValue: boolean | null;
  dateValue: Date | null;
  dateEndValue: Date | null;
  dateAllDay: boolean | null;
  // Prisma's Json column needs the `JsonNull` sentinel for an explicit null,
  // not the plain JS value: a bare `null` there means "leave column unset".
  jsonValue: Prisma.InputJsonValue | typeof Prisma.JsonNull;
}

/**
 * A written date as its instant. A date and time without a zone is read in
 * the column's own zone when it has one (`instantFromIsoInput`, issue #255).
 */
function parseIsoOrThrow(property: DatabasePropertyRef, value: string): Date {
  const date = instantFromIsoInput(value, parseDatePropertyConfig(property.config).timeZone);
  if (date === null) {
    throw AppError.validation(`Property ${property.id} received an invalid date`);
  }
  return date;
}

/**
 * A DATE write accepts the bare ISO string in both modes, so every existing
 * writer (the MCP catalogue, Hermes, the morning briefing) keeps working; the
 * span object is accepted only where the property actually is a span, because
 * silently dropping an `end` on a non-range property would look like a
 * successful write of data that is not there afterwards.
 */
function toDateColumnData(
  property: DatabasePropertyRef,
  value: DatabaseRowPropertyValue['value'],
  empty: ColumnData,
): ColumnData {
  if (typeof value === 'string') {
    return { ...empty, dateValue: parseIsoOrThrow(property, value) };
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw AppError.validation(`Property ${property.id} expects an ISO date string or a date span`);
  }
  if (!parseDatePropertyConfig(property.config).isRange) {
    throw AppError.validation(
      `Property ${property.id} is not a date span; pass an ISO date string`,
    );
  }
  const span = databaseDateRangeValueSchema.safeParse(value);
  if (!span.success) {
    throw AppError.validation(`Property ${property.id} expects { start, end, allDay }`);
  }
  const start = parseIsoOrThrow(property, span.data.start);
  const end = span.data.end === null ? null : parseIsoOrThrow(property, span.data.end);
  if (end !== null && end < start) {
    throw AppError.validation(`Property ${property.id} received a span that ends before it starts`);
  }
  return { ...empty, dateValue: start, dateEndValue: end, dateAllDay: span.data.allDay };
}

/** Converts one incoming `{propertyId, value}` write into the correct typed column. */
export function toColumnData(
  property: DatabasePropertyRef,
  value: DatabaseRowPropertyValue['value'],
): ColumnData {
  const empty: ColumnData = {
    textValue: null,
    numberValue: null,
    boolValue: null,
    dateValue: null,
    dateEndValue: null,
    dateAllDay: null,
    jsonValue: Prisma.JsonNull,
  };
  if (value === null) return empty;

  if (property.type === 'NUMBER') {
    if (typeof value !== 'number')
      throw AppError.validation(`Property ${property.id} expects a number`);
    return { ...empty, numberValue: value };
  }
  if (property.type === 'CHECKBOX') {
    if (typeof value !== 'boolean')
      throw AppError.validation(`Property ${property.id} expects a boolean`);
    return { ...empty, boolValue: value };
  }
  if (property.type === 'DATE') {
    return toDateColumnData(property, value, empty);
  }
  if (ARRAY_TYPES.has(property.type)) {
    if (!Array.isArray(value))
      throw AppError.validation(`Property ${property.id} expects an array of ids`);
    return { ...empty, jsonValue: value };
  }
  if (typeof value !== 'string')
    throw AppError.validation(`Property ${property.id} expects a string`);
  return { ...empty, textValue: value };
}

/**
 * The `files` of one row: every file its FILES values name that still
 * exists, once, in the order the cells name them. Left out entirely for a
 * database without a FILES column, so those rows answer as before.
 */
export function filesOfRow(
  values: readonly DatabaseRowPropertyValue[],
  scope: DatabaseQueryScope,
  files: ReadonlyMap<string, DatabaseRowFile>,
): { files?: DatabaseRowFile[] } {
  const named: DatabaseRowFile[] = [];
  const seen = new Set<string>();
  let hasFilesColumn = false;
  for (const entry of values) {
    if (scope.properties.get(entry.propertyId)?.type !== 'FILES') continue;
    hasFilesColumn = true;
    if (!Array.isArray(entry.value)) continue;
    for (const id of entry.value) {
      const file = files.get(id);
      if (file === undefined || seen.has(id)) continue;
      seen.add(id);
      named.push(file);
    }
  }
  return hasFilesColumn ? { files: named } : {};
}

export function encodeCursor(offset: number): string {
  return Buffer.from(String(offset), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  const parsed = Number.parseInt(Buffer.from(cursor, 'base64url').toString('utf8'), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}
