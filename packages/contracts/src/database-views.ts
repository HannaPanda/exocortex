import { z } from 'zod';

import { documentSummarySchema } from './documents';
import { documentTitleSchema, idSchema, isoDateTimeSchema, paginationSchema } from './primitives';

/**
 * Notion-style databases. A database is a `Document` with `type: 'COLLECTION'`;
 * its rows are ordinary `Document` children (`type: 'PAGE'`), so a row is a
 * fully editable page with its own tree position, search index, trash and
 * authorization (see ADR-011). This file only models the typed schema layered
 * on top: properties, views, filters/sorts and row property values.
 */

export const databasePropertyTypeSchema = z.enum([
  'TEXT',
  'NUMBER',
  'SELECT',
  'MULTI_SELECT',
  'DATE',
  'CHECKBOX',
  'URL',
  'EMAIL',
  'PHONE',
  'PERSON',
  'FILES',
  'CREATED_TIME',
  'UPDATED_TIME',
  'CREATED_BY',
  'UPDATED_BY',
  'RELATION',
  'ROLLUP',
  'FORMULA',
]);
export type DatabasePropertyType = z.infer<typeof databasePropertyTypeSchema>;

/** Property types the query engine and property-write endpoint implement. */
export const IMPLEMENTED_PROPERTY_TYPES = [
  'TEXT',
  'NUMBER',
  'SELECT',
  'MULTI_SELECT',
  'DATE',
  'CHECKBOX',
  'URL',
  'EMAIL',
  'PHONE',
  'PERSON',
  'FILES',
  'CREATED_TIME',
  'UPDATED_TIME',
  'CREATED_BY',
  'UPDATED_BY',
  'RELATION',
  'ROLLUP',
  'FORMULA',
] as const satisfies readonly DatabasePropertyType[];

/** Property types computed from the row `Document` itself, never stored. */
export const COMPUTED_PROPERTY_TYPES = [
  'CREATED_TIME',
  'UPDATED_TIME',
  'CREATED_BY',
  'UPDATED_BY',
] as const satisfies readonly DatabasePropertyType[];

/**
 * Property types the query engine computes from *other* rows on every read:
 * a rollup aggregates over a relation, a formula evaluates an expression. They
 * are never written, so a write to one is a client mistake rather than an
 * update (ADR-041).
 */
export const DERIVED_PROPERTY_TYPES = [
  'ROLLUP',
  'FORMULA',
] as const satisfies readonly DatabasePropertyType[];

/**
 * Property types that need a `config` before they mean anything. Creating one
 * without it is refused rather than stored half-finished, because a rollup
 * with no relation and a formula with no expression are not columns yet.
 */
export const CONFIGURED_PROPERTY_TYPES = [
  'RELATION',
  'ROLLUP',
  'FORMULA',
] as const satisfies readonly DatabasePropertyType[];

/** Property types whose value is a JSON array of ids. */
export const ARRAY_VALUED_PROPERTY_TYPES = [
  'MULTI_SELECT',
  'PERSON',
  'FILES',
  'RELATION',
] as const satisfies readonly DatabasePropertyType[];

/**
 * Same nine names as the `--content-*`/`--content-bg-*` tokens in
 * packages/ui/src/tokens.css. Duplicated here rather than imported because
 * `packages/contracts` must stay dependency-free (dependency-graph.mjs);
 * apps/web maps both to the same Tailwind classes.
 */
export const DATABASE_OPTION_COLORS = [
  'gray',
  'brown',
  'orange',
  'yellow',
  'green',
  'blue',
  'purple',
  'pink',
  'red',
] as const;
export const databaseOptionColorSchema = z.enum(DATABASE_OPTION_COLORS);
export type DatabaseOptionColor = z.infer<typeof databaseOptionColorSchema>;

export const databasePropertyOptionSchema = z.object({
  id: idSchema,
  label: z.string().trim().min(1).max(100),
  color: databaseOptionColorSchema,
  orderKey: z.string(),
});
export type DatabasePropertyOption = z.infer<typeof databasePropertyOptionSchema>;

export const createDatabasePropertyOptionRequestSchema = z.object({
  label: z.string().trim().min(1).max(100),
  color: databaseOptionColorSchema,
});
export type CreateDatabasePropertyOptionRequest = z.infer<
  typeof createDatabasePropertyOptionRequestSchema
>;

export const updateDatabasePropertyOptionRequestSchema = z.object({
  label: z.string().trim().min(1).max(100).optional(),
  color: databaseOptionColorSchema.optional(),
});
export type UpdateDatabasePropertyOptionRequest = z.infer<
  typeof updateDatabasePropertyOptionRequestSchema
>;

// ---------------------------------------------------------------------------
// DATE property configuration
// ---------------------------------------------------------------------------

/**
 * Typed shape of a DATE property's `config` bag.
 *
 * `isRange` is what separates a due date from a calendar event, and it decides
 * the *response* shape of every value of that property: `false` keeps the bare
 * ISO string every existing client already reads, `true` returns
 * `databaseDateRangeValueSchema`. Flipping it is therefore a contract change
 * for that one property, never a global one -- which is why the flag lives on
 * the property and not on the value.
 */
export const databaseDatePropertyConfigSchema = z.object({
  /** Whether values carry a time-of-day. Parsing and display hint. */
  includeTime: z.boolean().default(false),
  /** Whether a value is a span with an end. A calendar event is, a due date is not. */
  isRange: z.boolean().default(false),
  /**
   * IANA zone the wall-clock parts are meant in, e.g. `Europe/Berlin`. Null
   * means "render in the viewer's zone". Stored values are always UTC instants;
   * this only says which zone they were authored in, which a recurring event
   * and an external calendar both need to round-trip correctly.
   */
  timeZone: z.string().trim().min(1).max(64).nullable().default(null),
});
export type DatabaseDatePropertyConfig = z.infer<typeof databaseDatePropertyConfigSchema>;

/**
 * Reads a DATE property's config, filling in defaults for a property created
 * before the field existed. Never throws: an unparsable bag falls back to the
 * defaults, because a hand-edited row must not be able to break a query.
 */
export function parseDatePropertyConfig(
  config: Record<string, unknown> | null | undefined,
): DatabaseDatePropertyConfig {
  const parsed = databaseDatePropertyConfigSchema.safeParse(config ?? {});
  return parsed.success ? parsed.data : databaseDatePropertyConfigSchema.parse({});
}

export const databasePropertySchema = z.object({
  id: idSchema,
  documentId: idSchema,
  type: databasePropertyTypeSchema,
  name: z.string().trim().min(1).max(100),
  orderKey: z.string(),
  config: z.record(z.string(), z.unknown()).nullable(),
  options: z.array(databasePropertyOptionSchema),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type DatabaseProperty = z.infer<typeof databasePropertySchema>;

export const createDatabasePropertyRequestSchema = z.object({
  type: databasePropertyTypeSchema,
  name: z.string().trim().min(1).max(100),
  /** Server derives the fractional orderKey; omit for "append to the end". */
  afterPropertyId: idSchema.nullable().optional(),
  /**
   * Type-specific configuration, validated against the schema for `type`.
   * Required for RELATION, ROLLUP and FORMULA (`CONFIGURED_PROPERTY_TYPES`):
   * those three carry their whole meaning in it.
   */
  config: z.record(z.string(), z.unknown()).nullable().optional(),
});
export type CreateDatabasePropertyRequest = z.infer<typeof createDatabasePropertyRequestSchema>;

export const updateDatabasePropertyRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    config: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .refine((value) => value.name !== undefined || value.config !== undefined, {
    message: 'At least one of "name" or "config" must be provided',
  });
export type UpdateDatabasePropertyRequest = z.infer<typeof updateDatabasePropertyRequestSchema>;

export const reorderDatabasePropertyRequestSchema = z.object({
  afterPropertyId: idSchema.nullable(),
  beforePropertyId: idSchema.nullable().optional(),
});
export type ReorderDatabasePropertyRequest = z.infer<typeof reorderDatabasePropertyRequestSchema>;

// ---------------------------------------------------------------------------
// Filters and sorts: a structured, validated tree — never free-form SQL or JS.
// ---------------------------------------------------------------------------

export const databaseFilterOperatorSchema = z.enum([
  'equals',
  'not_equals',
  'contains',
  'not_contains',
  'is_empty',
  'is_not_empty',
  'greater_than',
  'less_than',
  'on_or_after',
  'on_or_before',
  /**
   * DATE only, and the reason the calendar can be a saved view at all: matches
   * every row whose span intersects the half-open window `[from, to)` passed as
   * `value: [fromIso, toIso]`. A point-in-time date (`isRange: false`) counts as
   * a zero-length span, so the operator works on both kinds of DATE property.
   *
   * Not expressible as two conditions in the tree: an overlap compares the
   * property's *start* against `to` and its *end* against `from`, so it reads
   * two columns of one property, which a single-column condition cannot do.
   */
  'overlaps',
]);
export type DatabaseFilterOperator = z.infer<typeof databaseFilterOperatorSchema>;

export const databaseFilterValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.string()),
]);

export const databaseFilterConditionSchema = z.object({
  propertyId: idSchema,
  operator: databaseFilterOperatorSchema,
  /** Absent for `is_empty`/`is_not_empty`. */
  value: databaseFilterValueSchema.optional(),
});
export type DatabaseFilterCondition = z.infer<typeof databaseFilterConditionSchema>;

export interface DatabaseFilterGroup {
  combinator: 'and' | 'or';
  conditions: (DatabaseFilterCondition | DatabaseFilterGroup)[];
}

export const databaseFilterGroupSchema: z.ZodType<DatabaseFilterGroup> = z.lazy(() =>
  z.object({
    combinator: z.enum(['and', 'or']),
    conditions: z
      .array(z.union([databaseFilterConditionSchema, databaseFilterGroupSchema]))
      .max(20),
  }),
);

export const EMPTY_DATABASE_FILTER_GROUP: DatabaseFilterGroup = {
  combinator: 'and',
  conditions: [],
};

export const databaseSortSchema = z.object({
  propertyId: idSchema,
  direction: z.enum(['asc', 'desc']),
});
export type DatabaseSort = z.infer<typeof databaseSortSchema>;

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export const databaseViewTypeSchema = z.enum(['TABLE', 'BOARD', 'GALLERY', 'CALENDAR']);
export type DatabaseViewType = z.infer<typeof databaseViewTypeSchema>;

export const databaseViewVisiblePropertySchema = z.object({
  propertyId: idSchema,
  visible: z.boolean(),
  orderKey: z.string(),
});

/**
 * TABLE only: how many lines a cell may show before its content is clamped.
 * The full value always stays reachable through the cell editor, so this is a
 * density choice, not a data limit.
 */
export const databaseRowHeightSchema = z.enum(['short', 'medium', 'tall']);
export type DatabaseRowHeight = z.infer<typeof databaseRowHeightSchema>;

/**
 * Column-width bounds in CSS pixels. The lower bound keeps a column wide
 * enough for its header menu, the upper one keeps a single column from
 * pushing every other one off screen.
 */
export const DATABASE_COLUMN_MIN_WIDTH = 80;
export const DATABASE_COLUMN_MAX_WIDTH = 720;
export const DATABASE_COLUMN_DEFAULT_WIDTH = 180;
/**
 * Width key of the row-title column in `columnWidths`. Not a property id: the
 * title lives on the row `Document` itself (ADR-011), so it has none.
 */
export const DATABASE_TITLE_COLUMN_KEY = 'title';

/**
 * CALENDAR only: which projection of the same rows the view draws.
 *
 * A mode is not a view type. All five read one `datePropertyId` and one saved
 * filter set, and differ only in the window they ask the API for and how they
 * lay the answer out, so switching one is a config change on the existing view
 * rather than a second view to keep in sync.
 */
export const databaseCalendarModeSchema = z.enum(['LIST', 'DAY', 'WEEK', 'MONTH', 'YEAR']);
export type DatabaseCalendarMode = z.infer<typeof databaseCalendarModeSchema>;

const databaseViewConfigFields = {
  visibleProperties: z.array(databaseViewVisiblePropertySchema),
  /** CALENDAR only: which DATE property to plot rows on. */
  datePropertyId: idSchema.nullable(),
  /**
   * CALENDAR only: the mode the view opens in. Stored on the view rather than
   * in the browser, because "remember the chosen view" has to survive a
   * different device, and because every surface reaches the same capability
   * (ADR-025): an agent reads and sets this through `exo_database_view_update`.
   */
  calendarMode: databaseCalendarModeSchema,
  /** GALLERY only: which FILES property supplies the card cover. */
  coverPropertyId: idSchema.nullable(),
  /**
   * TABLE only: column widths in CSS pixels, keyed by property id plus the
   * reserved `title` key. A column that is missing here uses
   * `DATABASE_COLUMN_DEFAULT_WIDTH`, so an untouched view needs no entries.
   */
  columnWidths: z.record(
    z.string().min(1).max(64),
    z.number().int().min(DATABASE_COLUMN_MIN_WIDTH).max(DATABASE_COLUMN_MAX_WIDTH),
  ),
  /** TABLE only: row density. */
  rowHeight: databaseRowHeightSchema,
} as const;

/** Read shape: defaults fill in what a view stored before a field existed. */
export const databaseViewConfigSchema = z.object({
  ...databaseViewConfigFields,
  visibleProperties: databaseViewConfigFields.visibleProperties.default([]),
  datePropertyId: databaseViewConfigFields.datePropertyId.optional(),
  calendarMode: databaseViewConfigFields.calendarMode.default('MONTH'),
  coverPropertyId: databaseViewConfigFields.coverPropertyId.optional(),
  columnWidths: databaseViewConfigFields.columnWidths.default({}),
  rowHeight: databaseViewConfigFields.rowHeight.default('short'),
});
export type DatabaseViewConfig = z.infer<typeof databaseViewConfigSchema>;

/**
 * Write shape: every field optional and **no defaults**.
 *
 * The update endpoint merges `config` shallowly onto the stored one, so a
 * default here would not mean "unchanged", it would mean "reset": a request
 * that only sets `columnWidths` would silently push `rowHeight` back to
 * `short`. Optional-without-default keeps an unmentioned field unmentioned.
 */
export const databaseViewConfigUpdateSchema = z.object({
  visibleProperties: databaseViewConfigFields.visibleProperties.optional(),
  datePropertyId: databaseViewConfigFields.datePropertyId.optional(),
  calendarMode: databaseViewConfigFields.calendarMode.optional(),
  coverPropertyId: databaseViewConfigFields.coverPropertyId.optional(),
  columnWidths: databaseViewConfigFields.columnWidths.optional(),
  rowHeight: databaseViewConfigFields.rowHeight.optional(),
});

export const databaseViewSchema = z.object({
  id: idSchema,
  documentId: idSchema,
  type: databaseViewTypeSchema,
  name: z.string().trim().min(1).max(100),
  orderKey: z.string(),
  filters: databaseFilterGroupSchema,
  sorts: z.array(databaseSortSchema),
  groupByPropertyId: idSchema.nullable(),
  config: databaseViewConfigSchema,
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type DatabaseView = z.infer<typeof databaseViewSchema>;

export const createDatabaseViewRequestSchema = z.object({
  type: databaseViewTypeSchema,
  name: z.string().trim().min(1).max(100).default('Neue Ansicht'),
});
export type CreateDatabaseViewRequest = z.infer<typeof createDatabaseViewRequestSchema>;

export const updateDatabaseViewRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    filters: databaseFilterGroupSchema.optional(),
    sorts: z.array(databaseSortSchema).optional(),
    groupByPropertyId: idSchema.nullable().optional(),
    config: databaseViewConfigUpdateSchema.optional(),
  })
  .refine(
    (value) =>
      value.name !== undefined ||
      value.filters !== undefined ||
      value.sorts !== undefined ||
      value.groupByPropertyId !== undefined ||
      value.config !== undefined,
    { message: 'At least one field must be provided' },
  );
export type UpdateDatabaseViewRequest = z.infer<typeof updateDatabaseViewRequestSchema>;

export const reorderDatabaseViewRequestSchema = z.object({
  afterViewId: idSchema.nullable(),
});
export type ReorderDatabaseViewRequest = z.infer<typeof reorderDatabaseViewRequestSchema>;

/**
 * `GET /api/documents/:documentId/properties` and `.../views`.
 *
 * These lived in `packages/mcp-tools/src/local-schemas.ts` while contracts was
 * frozen; they belong here, because every client that reads a database's schema
 * needs them, not only the tool catalogue.
 */
export const databasePropertyListResponseSchema = z.object({
  properties: z.array(databasePropertySchema),
});
export type DatabasePropertyListResponse = z.infer<typeof databasePropertyListResponseSchema>;

export const databaseViewListResponseSchema = z.object({
  views: z.array(databaseViewSchema),
});
export type DatabaseViewListResponse = z.infer<typeof databaseViewListResponseSchema>;

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/**
 * Value of a DATE property with `isRange: true`.
 *
 * `end` is nullable because an appointment without a stated end is a normal
 * thing to write down; the calendar renders it with a default duration rather
 * than inventing an end here. `allDay` is per value, not per property: the same
 * calendar holds birthdays and 14:00 meetings.
 */
export const databaseDateRangeValueSchema = z.object({
  start: isoDateTimeSchema,
  end: isoDateTimeSchema.nullable().default(null),
  allDay: z.boolean().default(false),
});
export type DatabaseDateRangeValue = z.infer<typeof databaseDateRangeValueSchema>;

export const databaseRowPropertyValueSchema = z.object({
  propertyId: idSchema,
  /**
   * A DATE property accepts a bare ISO string in both modes, so every existing
   * writer keeps working; it accepts and returns `databaseDateRangeValueSchema`
   * only when the property has `isRange: true` (see
   * `databaseDatePropertyConfigSchema`).
   */
  value: z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.array(z.string()),
    databaseDateRangeValueSchema,
    z.null(),
  ]),
});
export type DatabaseRowPropertyValue = z.infer<typeof databaseRowPropertyValueSchema>;

export const databaseRowSchema = z.object({
  document: documentSummarySchema,
  values: z.array(databaseRowPropertyValueSchema),
});
export type DatabaseRow = z.infer<typeof databaseRowSchema>;

/**
 * Answer to "is this document a database row, and if so what are its values?"
 * `row` is `null` when the document is not a `PAGE` whose parent is a
 * `COLLECTION` (ADR-011) — a plain page, a database itself, or a top-level
 * document all answer `null` here rather than a 404, because "not a row" is a
 * normal outcome for this question, not an error.
 */
export const documentRowResponseSchema = z.object({
  row: databaseRowSchema.nullable(),
});
export type DocumentRowResponse = z.infer<typeof documentRowResponseSchema>;

export const queryDatabaseRowsRequestSchema = z.object({
  /** Omit to query ad hoc with inline filters/sorts instead of a saved view. */
  viewId: idSchema.optional(),
  /**
   * Narrows the answer further. Alongside `viewId` these are **added** to the
   * view's saved filters with `and`, never substituted for them: a calendar
   * asking for one week wants that week *of its own view*, and a client that
   * could replace a saved filter by naming the view would be able to read rows
   * the view was set up to hide.
   */
  filters: databaseFilterGroupSchema.optional(),
  sorts: z.array(databaseSortSchema).optional(),
  ...paginationSchema.shape,
});
export type QueryDatabaseRowsRequest = z.infer<typeof queryDatabaseRowsRequestSchema>;

export const queryDatabaseRowsResponseSchema = z.object({
  rows: z.array(databaseRowSchema),
  nextCursor: z.string().nullable(),
});
export type QueryDatabaseRowsResponse = z.infer<typeof queryDatabaseRowsResponseSchema>;

export const createDatabaseRowRequestSchema = z.object({
  title: documentTitleSchema.default('Unbenannt'),
  values: z.array(databaseRowPropertyValueSchema).default([]),
});
export type CreateDatabaseRowRequest = z.infer<typeof createDatabaseRowRequestSchema>;

export const updateDatabaseRowValuesRequestSchema = z.object({
  values: z.array(databaseRowPropertyValueSchema).min(1),
});
export type UpdateDatabaseRowValuesRequest = z.infer<typeof updateDatabaseRowValuesRequestSchema>;
