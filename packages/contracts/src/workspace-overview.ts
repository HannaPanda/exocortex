import { z } from 'zod';

import { documentPathEntrySchema } from './documents';
import {
  DOCUMENT_ICON_COLORS,
  documentTypeSchema,
  idSchema,
  isoDateTimeSchema,
} from './primitives';

/**
 * A page as the overview names it: enough to draw a row, never enough to render
 * the page. The path is what separates this from a bare title — a workspace can
 * hold three pages called "Notizen", and a landing view that shows only titles
 * makes the reader guess which one it means.
 */
export const overviewDocumentSchema = z.object({
  id: idSchema,
  title: z.string(),
  icon: z.string().nullable(),
  iconColor: z.enum(DOCUMENT_ICON_COLORS).nullable(),
  type: documentTypeSchema,
  /** Ancestors, root first, excluding the document itself. Empty at top level. */
  path: z.array(documentPathEntrySchema),
});
export type OverviewDocument = z.infer<typeof overviewDocumentSchema>;

/**
 * A page in the "carry on" list.
 *
 * `editedAt` is the later of the document row's own `updatedAt` and the last
 * binary Yjs write. Neither alone is the answer: the row is only touched by a
 * rename, a move or an icon change, and the Yjs timestamp is missing for a page
 * whose body was never opened. Sorting by the row alone would rank a rename
 * above an hour of writing, which is exactly backwards.
 */
export const recentlyEditedDocumentSchema = overviewDocumentSchema.extend({
  editedAt: isoDateTimeSchema,
  editedByName: z.string().nullable(),
});
export type RecentlyEditedDocument = z.infer<typeof recentlyEditedDocumentSchema>;

/** A database (`type: 'COLLECTION'`) with the size of its table. */
export const overviewDatabaseSchema = overviewDocumentSchema.extend({
  rowCount: z.number().int().nonnegative(),
});
export type OverviewDatabase = z.infer<typeof overviewDatabaseSchema>;

/** A top-level page, with the size of the branch hanging under it. */
export const overviewSectionSchema = overviewDocumentSchema.extend({
  descendantCount: z.number().int().nonnegative(),
});
export type OverviewSection = z.infer<typeof overviewSectionSchema>;

/**
 * One thing that wants a decision, with somewhere to click.
 *
 * A bare count is a nag, not a task: "3 offene Kommentare" without the pages
 * they sit on leaves the reader searching. `documents` carries the first few
 * targets so the item is actionable from the landing view itself.
 */
export const attentionItemSchema = z.object({
  count: z.number().int().nonnegative(),
  documents: z.array(overviewDocumentSchema),
});
export type AttentionItem = z.infer<typeof attentionItemSchema>;

export const workspaceAttentionSchema = z.object({
  /** Comment threads nobody has resolved. */
  openComments: attentionItemSchema,
  /** Pages carrying a `[[reference]]` that resolves to nothing. */
  brokenLinks: attentionItemSchema,
  /** Attachments whose text extraction has not finished or has failed. */
  stalledAttachments: attentionItemSchema,
});
export type WorkspaceAttention = z.infer<typeof workspaceAttentionSchema>;

export const workspaceOverviewStatsSchema = z.object({
  pageCount: z.number().int().nonnegative(),
  databaseCount: z.number().int().nonnegative(),
  /** Pages edited within the last seven days. */
  editedThisWeek: z.number().int().nonnegative(),
  memberCount: z.number().int().nonnegative(),
  attachmentCount: z.number().int().nonnegative(),
  attachmentBytes: z.number().int().nonnegative(),
});
export type WorkspaceOverviewStats = z.infer<typeof workspaceOverviewStatsSchema>;

/**
 * Everything the landing view of a workspace draws, in one answer.
 *
 * One endpoint rather than six: the view is worthless until all of it is there,
 * so six requests would only buy six chances to render half a page.
 */
export const workspaceOverviewResponseSchema = z.object({
  workspaceId: idSchema,
  workspaceName: z.string(),
  stats: workspaceOverviewStatsSchema,
  recentlyEdited: z.array(recentlyEditedDocumentSchema),
  databases: z.array(overviewDatabaseSchema),
  sections: z.array(overviewSectionSchema),
  attention: workspaceAttentionSchema,
});
export type WorkspaceOverviewResponse = z.infer<typeof workspaceOverviewResponseSchema>;
