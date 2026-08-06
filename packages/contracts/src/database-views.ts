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
  // Reserved for a later round: accepted by the enum, rejected at the
  // property-create endpoint with `database_property_reserved` until the
  // query engine implements them.
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
] as const satisfies readonly DatabasePropertyType[];

/** Property types computed from the row `Document` itself, never stored. */
export const COMPUTED_PROPERTY_TYPES = [
  'CREATED_TIME',
  'UPDATED_TIME',
  'CREATED_BY',
  'UPDATED_BY',
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

export const databaseViewConfigSchema = z.object({
  visibleProperties: z.array(databaseViewVisiblePropertySchema).default([]),
  /** CALENDAR only: which DATE property to plot rows on. */
  datePropertyId: idSchema.nullable().optional(),
  /** GALLERY only: which FILES property supplies the card cover. */
  coverPropertyId: idSchema.nullable().optional(),
  /**
   * TABLE only: column widths in CSS pixels, keyed by property id plus the
   * reserved `title` key. A column that is missing here uses
   * `DATABASE_COLUMN_DEFAULT_WIDTH`, so an untouched view needs no entries.
   */
  columnWidths: z
    .record(
      z.string().min(1).max(64),
      z.number().int().min(DATABASE_COLUMN_MIN_WIDTH).max(DATABASE_COLUMN_MAX_WIDTH),
    )
    .default({}),
  /** TABLE only: row density. */
  rowHeight: databaseRowHeightSchema.default('short'),
});
export type DatabaseViewConfig = z.infer<typeof databaseViewConfigSchema>;

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
    config: databaseViewConfigSchema.partial().optional(),
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

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

export const databaseRowPropertyValueSchema = z.object({
  propertyId: idSchema,
  value: z.union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.null()]),
});
export type DatabaseRowPropertyValue = z.infer<typeof databaseRowPropertyValueSchema>;

export const databaseRowSchema = z.object({
  document: documentSummarySchema,
  values: z.array(databaseRowPropertyValueSchema),
});
export type DatabaseRow = z.infer<typeof databaseRowSchema>;

export const queryDatabaseRowsRequestSchema = z.object({
  /** Omit to query ad hoc with inline filters/sorts instead of a saved view. */
  viewId: idSchema.optional(),
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
