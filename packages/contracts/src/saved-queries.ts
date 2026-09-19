import { z } from 'zod';

import { databaseFilterGroupSchema } from './database-views';
import { documentPathEntrySchema } from './documents';
import {
  DOCUMENT_ICON_COLORS,
  documentTypeSchema,
  idSchema,
  isoDateTimeSchema,
} from './primitives';

/**
 * Saved searches, smart views and query blocks (issue #74).
 *
 * One query model behind three surfaces. A saved query is a *question*, stored
 * and answered again every time somebody looks: the definition below is the
 * question, and nothing in it holds an answer. That is the whole point. A list
 * of document ids frozen at save time would be a database of its own and would
 * go stale the first time anybody wrote a page, and it would also freeze the
 * permissions of whoever saved it. The query runs as the caller, every time.
 *
 * What it is not: a second database system (ADR-011 owns that). A smart view
 * references pages that already exist and stores nothing but the question and
 * how to lay the answer out.
 */

/** A date somebody typed or a `Date` from the database, normalized to ISO. */
const dateBoundSchema = isoDateTimeSchema.refine(
  (value) => !Number.isNaN(Date.parse(value)),
  'not a date',
);

/**
 * How the text half of a query matches.
 *
 * `HYBRID` is what the search box does: full-text fused with the vector search
 * when the deployment has it configured, degrading to full-text alone when it
 * does not (ADR-020). `KEYWORD` asks for full-text only, which is the right
 * answer for a query that is about an exact word rather than about a subject,
 * and which costs no embedding call.
 */
export const savedQueryTextModeSchema = z.enum(['HYBRID', 'KEYWORD']);
export type SavedQueryTextMode = z.infer<typeof savedQueryTextModeSchema>;

/**
 * How the answer is ordered.
 *
 * `RELEVANCE` needs a text to be relevant to. A query without one falls back
 * to `UPDATED_DESC` while it runs rather than being refused: "everything under
 * Projekte" is a legitimate question, and the most recently touched first is
 * the only ordering it has.
 */
export const savedQuerySortSchema = z.enum([
  'RELEVANCE',
  'UPDATED_DESC',
  'UPDATED_ASC',
  'CREATED_DESC',
  'CREATED_ASC',
  'TITLE_ASC',
  'TITLE_DESC',
]);
export type SavedQuerySort = z.infer<typeof savedQuerySortSchema>;

/**
 * One time window, expressed either relative or absolute.
 *
 * Relative is the one that matters for something *saved*: "die letzten 30 Tage"
 * has to still mean the last thirty days next month, and an absolute date
 * written at save time would quietly turn into a fixed window nobody notices
 * has stopped moving. The absolute bounds are there for the report that really
 * is about one quarter.
 */
export const savedQueryDateRangeSchema = z.object({
  /** Counted back from now, at query time. Wins over `after` when both are set. */
  withinDays: z.number().int().min(1).max(3650).nullable().default(null),
  after: dateBoundSchema.nullable().default(null),
  before: dateBoundSchema.nullable().default(null),
});
export type SavedQueryDateRange = z.infer<typeof savedQueryDateRangeSchema>;

const EMPTY_RANGE: SavedQueryDateRange = { withinDays: null, after: null, before: null };

/** Whether a page has to mention every named entity or just one of them. */
export const savedQueryEntityMatchSchema = z.enum(['ANY', 'ALL']);
export type SavedQueryEntityMatch = z.infer<typeof savedQueryEntityMatchSchema>;

/**
 * The question itself.
 *
 * Every field is optional with a neutral default, so `{}` is the valid query
 * "everything in this workspace, newest first". A caller that only wants a
 * subtree sends one field, and an agent does not have to learn nine.
 */
export const savedQueryDefinitionSchema = z
  .object({
    /** What to look for. `null` or empty asks a purely structural question. */
    text: z.string().trim().max(200).nullable().default(null),
    textMode: savedQueryTextModeSchema.default('HYBRID'),
    /** Empty means every type. */
    types: z.array(documentTypeSchema).max(3).default([]),
    /**
     * Only pages inside this page's subtree, the page itself included. The
     * subtree is resolved when the query runs, so moving a page in or out
     * changes the answer rather than needing the query to be edited.
     */
    underDocumentId: idSchema.nullable().default(null),
    /**
     * Only rows of this database (ADR-011). Required for `propertyFilter`,
     * because a property id only means something inside the database that
     * defines it.
     */
    collectionId: idSchema.nullable().default(null),
    /** The same filter tree a database view uses, evaluated by the same engine. */
    propertyFilter: databaseFilterGroupSchema.nullable().default(null),
    /** Pages that mention these entities (issue #47). */
    entityIds: z.array(idSchema).max(20).default([]),
    entityMatch: savedQueryEntityMatchSchema.default('ANY'),
    updated: savedQueryDateRangeSchema.default(EMPTY_RANGE),
    created: savedQueryDateRangeSchema.default(EMPTY_RANGE),
    includeArchived: z.boolean().default(false),
    sort: savedQuerySortSchema.default('RELEVANCE'),
    limit: z.number().int().min(1).max(200).default(25),
  })
  .refine((value) => value.propertyFilter === null || value.collectionId !== null, {
    message: 'propertyFilter requires collectionId',
    path: ['propertyFilter'],
  });
export type SavedQueryDefinition = z.infer<typeof savedQueryDefinitionSchema>;

/** The neutral query: everything in the workspace, newest first. */
export const EMPTY_SAVED_QUERY_DEFINITION: SavedQueryDefinition = savedQueryDefinitionSchema.parse(
  {},
);

/** Is this definition asking anything at all beyond "show me the workspace"? */
export function isNarrowedSavedQuery(definition: SavedQueryDefinition): boolean {
  return (
    (definition.text !== null && definition.text.length > 0) ||
    definition.types.length > 0 ||
    definition.underDocumentId !== null ||
    definition.collectionId !== null ||
    definition.entityIds.length > 0 ||
    definition.updated.withinDays !== null ||
    definition.updated.after !== null ||
    definition.updated.before !== null ||
    definition.created.withinDays !== null ||
    definition.created.after !== null ||
    definition.created.before !== null
  );
}

/** How the answer is laid out. Presentation only; it never changes the answer. */
export const savedQueryLayoutSchema = z.enum(['LIST', 'TABLE', 'CARDS']);
export type SavedQueryLayout = z.infer<typeof savedQueryLayoutSchema>;

export const savedQueryDisplaySchema = z.object({
  layout: savedQueryLayoutSchema.default('LIST'),
  /** Where the hit sits. Off for a list whose rows are all siblings anyway. */
  showPath: z.boolean().default(true),
  showSnippet: z.boolean().default(true),
  showUpdatedAt: z.boolean().default(true),
});
export type SavedQueryDisplay = z.infer<typeof savedQueryDisplaySchema>;

export const DEFAULT_SAVED_QUERY_DISPLAY: SavedQueryDisplay = savedQueryDisplaySchema.parse({});

export const savedQuerySchema = z.object({
  id: idSchema,
  workspaceId: idSchema,
  name: z.string(),
  description: z.string().nullable(),
  /** Same two spellings a page icon has: a literal emoji or `lucide:<name>`. */
  icon: z.string().nullable(),
  iconColor: z.enum(DOCUMENT_ICON_COLORS).nullable(),
  definition: savedQueryDefinitionSchema,
  display: savedQueryDisplaySchema,
  /** Whether it is a smart view: an entry of its own in the navigation. */
  inSidebar: z.boolean(),
  /** Fractional index among the sidebar entries; see `@exocortex/database`. */
  orderKey: z.string(),
  createdById: idSchema,
  updatedById: idSchema,
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type SavedQuery = z.infer<typeof savedQuerySchema>;

export const savedQueryResponseSchema = z.object({ savedQuery: savedQuerySchema });
export type SavedQueryResponse = z.infer<typeof savedQueryResponseSchema>;

export const savedQueryListResponseSchema = z.object({
  /** Sidebar entries first in their own order, then the rest alphabetically. */
  savedQueries: z.array(savedQuerySchema),
});
export type SavedQueryListResponse = z.infer<typeof savedQueryListResponseSchema>;

export const deleteSavedQueryResponseSchema = z.object({ deleted: z.literal(true) });
export type DeleteSavedQueryResponse = z.infer<typeof deleteSavedQueryResponseSchema>;

/** The fields a saved query carries. Shared by create and update so they cannot drift. */
const savedQueryFieldsSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).nullable().optional(),
  icon: z.string().trim().max(80).nullable().optional(),
  iconColor: z.enum(DOCUMENT_ICON_COLORS).nullable().optional(),
  definition: savedQueryDefinitionSchema,
  display: savedQueryDisplaySchema.optional(),
  inSidebar: z.boolean().optional(),
});

export const createSavedQueryRequestSchema = savedQueryFieldsSchema;
export type CreateSavedQueryRequest = z.infer<typeof createSavedQueryRequestSchema>;

export const updateSavedQueryRequestSchema = savedQueryFieldsSchema
  .partial()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one field must be provided',
  });
export type UpdateSavedQueryRequest = z.infer<typeof updateSavedQueryRequestSchema>;

export const reorderSavedQueryRequestSchema = z
  .object({
    afterId: idSchema.optional(),
    beforeId: idSchema.optional(),
  })
  .refine((value) => value.afterId !== undefined || value.beforeId !== undefined, {
    message: 'afterId or beforeId is required',
  });
export type ReorderSavedQueryRequest = z.infer<typeof reorderSavedQueryRequestSchema>;

/** One page in the answer. The search result plus the two columns a list view sorts by. */
export const savedQueryHitSchema = z.object({
  documentId: idSchema,
  workspaceId: idSchema,
  parentId: idSchema.nullable(),
  title: z.string(),
  icon: z.string().nullable(),
  iconColor: z.enum(DOCUMENT_ICON_COLORS).nullable(),
  type: documentTypeSchema,
  path: z.array(documentPathEntrySchema),
  /** Highlighted fragment, matching passage, or the first lines of the page. */
  snippet: z.string(),
  /** Fusion score for a text query, 0 for a purely structural one. */
  rank: z.number(),
  archivedAt: isoDateTimeSchema.nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type SavedQueryHit = z.infer<typeof savedQueryHitSchema>;

export const savedQueryResultsResponseSchema = z.object({
  /** `null` when an unsaved definition was run straight from the search area. */
  savedQueryId: idSchema.nullable(),
  name: z.string().nullable(),
  /** The definition as it was actually run, defaults filled in. */
  definition: savedQueryDefinitionSchema,
  results: z.array(savedQueryHitSchema),
  /**
   * Whether the limit cut the answer short. A list that stops at its limit
   * without saying so reads as a complete answer, and acting on "there are
   * three of these" when there are forty is the failure this prevents.
   */
  truncated: z.boolean(),
  /** Which search adapter answered the text half, or `none` without one. */
  adapter: z.string(),
  tookMs: z.number().int().nonnegative(),
});
export type SavedQueryResultsResponse = z.infer<typeof savedQueryResultsResponseSchema>;

/** Running a stored query. The limit override is for a block that shows five of them. */
export const runSavedQueryRequestSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
});
export type RunSavedQueryRequest = z.infer<typeof runSavedQueryRequestSchema>;

/** Running a definition that has not been saved, which is what the search area does. */
export const previewSavedQueryRequestSchema = z.object({
  definition: savedQueryDefinitionSchema,
});
export type PreviewSavedQueryRequest = z.infer<typeof previewSavedQueryRequestSchema>;
