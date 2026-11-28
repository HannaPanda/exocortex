import { z } from 'zod';

import { documentPathEntrySchema } from './documents';
import {
  DOCUMENT_ICON_COLORS,
  documentTypeSchema,
  idSchema,
  isoDateTimeSchema,
} from './primitives';

export const searchRequestSchema = z.object({
  q: z.string().trim().min(1).max(200),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  includeArchived: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .transform((value) => value === true || value === 'true')
    .default(false),
});
export type SearchRequest = z.infer<typeof searchRequestSchema>;

export const searchResultSchema = z.object({
  documentId: idSchema,
  workspaceId: idSchema,
  title: z.string(),
  icon: z.string().nullable(),
  iconColor: z.enum(DOCUMENT_ICON_COLORS).nullable(),
  type: documentTypeSchema,
  /**
   * Ancestors of the hit, root first, so a caller can tell three pages called
   * "Rezepte" apart and knows where the one it found actually lives.
   */
  path: z.array(documentPathEntrySchema),
  /**
   * What to show under the title: the highlighted fragment around the words
   * that matched, or, for a page found by meaning alone, the passage whose
   * vector matched (ADR-034) and otherwise the first lines of the page.
   */
  snippet: z.string(),
  /**
   * The section the hit sits in (issue #118): the heading above it.
   *
   * A page can hold a hundred thousand characters, and a hit that names only
   * the page is the answer the caller already had: the run this came out of
   * searched fourteen times and every hit pointed at the page it had just
   * read. A semantic hit knows its passage (ADR-034) and therefore the heading
   * above it; a keyword hit knows the block its words stand in (issue #280,
   * ADR-100) and therefore the heading above that. `null` when the hit sits
   * under no heading or is not located at all; `blockId` and `attachment`
   * tell the two apart.
   */
  section: z
    .object({
      /**
       * Block to read the section with, for `exo_page_read` and
       * `exo_page_block_read`. `null` when the heading itself carries no
       * identifier: the section can be named, not opened.
       */
      blockId: z.string().nullable(),
      /** The heading and the headings it sits under, outermost first. */
      path: z.array(z.string()),
    })
    .nullable(),
  /**
   * The block the matched words stand in (issue #280, ADR-100): a paragraph,
   * a heading, a whole table, and in a list the list point itself. It is the
   * place of the first highlighted word of `snippet`, so the two always agree,
   * and `exo_page_block_read` reads exactly it. For words out of an
   * attachment, the block that shows the file, if one does. `null` for a hit
   * found by meaning alone (its passage spans several blocks), a match on the
   * title only, or a page not mapped yet.
   */
  blockId: z.string().nullable(),
  /**
   * Set when the words stand in the text of a file attached to the page
   * rather than on the page itself (ADR-050): which file. Never attributed to
   * a block of the page that does not show it.
   */
  attachment: z
    .object({
      attachmentId: z.string(),
      filename: z.string(),
    })
    .nullable(),
  rank: z.number(),
  archivedAt: isoDateTimeSchema.nullable(),
  updatedAt: isoDateTimeSchema,
});
export type SearchResult = z.infer<typeof searchResultSchema>;

export const searchResponseSchema = z.object({
  query: z.string(),
  results: z.array(searchResultSchema),
  /** Which adapter answered the query. Useful when OpenSearch is added later. */
  adapter: z.string(),
  tookMs: z.number().int().nonnegative(),
});
export type SearchResponse = z.infer<typeof searchResponseSchema>;
