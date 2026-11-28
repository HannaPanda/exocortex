import { z } from 'zod';

import {
  copiedCellFileSchema,
  databaseRowPropertyValueSchema,
  databaseRowSchema,
} from './database-views';
import { documentSummarySchema } from './documents';
import { idSchema } from './primitives';

/**
 * Acting on several rows of one database at once (issue #244): the selection
 * in a table, or an agent tidying up a list.
 *
 * Each of these is one request rather than one per row, so the server checks
 * every row before it changes any of them. A hundred is what a table shows at
 * once, and a selection cannot be larger than what is on screen.
 */
export const DATABASE_ROW_BATCH_MAX = 100;

export const databaseRowIdsSchema = z.array(idSchema).min(1).max(DATABASE_ROW_BATCH_MAX);

/** The same values written into every named row. */
export const updateDatabaseRowsRequestSchema = z.object({
  rowIds: databaseRowIdsSchema,
  values: z.array(databaseRowPropertyValueSchema).min(1),
});
export type UpdateDatabaseRowsRequest = z.infer<typeof updateDatabaseRowsRequestSchema>;

export const databaseRowIdsRequestSchema = z.object({ rowIds: databaseRowIdsSchema });
export type DatabaseRowIdsRequest = z.infer<typeof databaseRowIdsRequestSchema>;

/** The rows as they are after the change, in the order they were named. */
export const databaseRowsResponseSchema = z.object({ rows: z.array(databaseRowSchema) });
export type DatabaseRowsResponse = z.infer<typeof databaseRowsResponseSchema>;

/**
 * The copies, in the order their rows were named, and every file of a FILES
 * cell that was copied for them (issue #316): each copy holds files of its
 * own, never the source row's.
 */
export const duplicateDatabaseRowsResponseSchema = databaseRowsResponseSchema.extend({
  copiedFiles: z.array(copiedCellFileSchema),
});
export type DuplicateDatabaseRowsResponse = z.infer<typeof duplicateDatabaseRowsResponseSchema>;

/**
 * The rows now in the trash, each restorable on its own like any page. A row
 * with pages under it takes them along, as archiving a page always does.
 */
export const trashDatabaseRowsResponseSchema = z.object({
  archived: z.array(documentSummarySchema),
});
export type TrashDatabaseRowsResponse = z.infer<typeof trashDatabaseRowsResponseSchema>;
