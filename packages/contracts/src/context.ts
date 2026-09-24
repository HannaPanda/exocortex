import { z } from 'zod';

import { documentPathEntrySchema } from './documents';
import { idSchema, isoDateTimeSchema } from './primitives';
import { searchResultSchema } from './search';

/**
 * The context compiler (issue #110, ADR-061): a question and a budget in, the
 * passages that answer it out.
 *
 * It sits between `exo_search` and `exo_page_read`. A search names pages, a
 * read loads one; a typical question an agent asks ("what do we know about
 * X") wants neither, it wants the few paragraphs out of several pages that
 * are about X, and it wants them in one call and under a ceiling it chose.
 */

/** Longest answer a caller may ask for. The same ceiling `memory/recall` has. */
export const CONTEXT_MAX_CHARS = 50_000;

/**
 * Workspaces to look in, as a comma-separated list in the query string.
 *
 * A list rather than a repeated parameter because the request is a GET (it
 * changes nothing, so a read-only token may send it) and a GET carries its
 * arguments in the query string, where a repeated key arrives as a string or
 * an array depending on how often it was repeated.
 */
const workspaceIdListSchema = z
  .union([z.string(), z.array(idSchema)])
  .transform((value) =>
    (Array.isArray(value) ? value : value.split(','))
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  )
  .pipe(z.array(idSchema).min(1).max(20));

export const contextCompileRequestSchema = z.object({
  q: z.string().trim().min(1).max(500),
  /**
   * Absent means every workspace the caller is a member of, except the agents'
   * memory area: the compiler answers from knowledge, and a session's own
   * notes are what `memory/recall` is for. Naming the memory area explicitly
   * includes it.
   */
  workspaceIds: workspaceIdListSchema.optional(),
  /** Hard ceiling on `text`. Counted in characters of exactly what is returned. */
  maxChars: z.coerce.number().int().min(500).max(CONTEXT_MAX_CHARS).default(12_000),
  /** How many different pages may contribute. */
  maxSources: z.coerce.number().int().min(1).max(30).default(12),
  /**
   * How much of the budget one page may take. Defaults to a third of
   * `maxChars`, so a single long page cannot be the whole answer while
   * several other pages are relevant too.
   */
  perSourceMaxChars: z.coerce.number().int().min(200).max(CONTEXT_MAX_CHARS).optional(),
});
export type ContextCompileRequest = z.infer<typeof contextCompileRequestSchema>;

/** Which half of the retrieval found a passage. */
export const contextMatchSchema = z.enum(['keyword', 'semantic', 'both']);
export type ContextMatch = z.infer<typeof contextMatchSchema>;

export const contextPassageSchema = z.object({
  /** The passage verbatim, as it stands on the page. Never a summary. */
  text: z.string(),
  /** Fused rank score. Only comparable within one answer. */
  score: z.number(),
  match: contextMatchSchema,
  /**
   * The heading the passage sits under, with the block to read it by. Same
   * field and same meaning as on a search result: `null` says the passage is
   * not located, never that it sits at the top of the page.
   */
  section: searchResultSchema.shape.section,
  /** Whether the passage was cut to fit the budget. */
  truncated: z.boolean(),
});
export type ContextPassage = z.infer<typeof contextPassageSchema>;

export const contextSourceSchema = z.object({
  workspaceId: idSchema,
  workspaceName: z.string(),
  documentId: idSchema,
  title: z.string(),
  path: z.array(documentPathEntrySchema),
  updatedAt: isoDateTimeSchema,
  /** In the order they stand on the page, not in the order they ranked. */
  passages: z.array(contextPassageSchema),
});
export type ContextSource = z.infer<typeof contextSourceSchema>;

export const contextStageSchema = z.enum(['keyword', 'semantic']);
export type ContextStage = z.infer<typeof contextStageSchema>;

export const contextCompileResponseSchema = z.object({
  query: z.string(),
  sources: z.array(contextSourceSchema),
  /** The same passages, rendered for a prompt. Its length is `usedChars`. */
  text: z.string(),
  usedChars: z.number().int().nonnegative(),
  /**
   * Whether anything relevant was left out or cut: a passage that did not fit,
   * a page beyond `maxSources`, a passage shortened to fit.
   */
  truncated: z.boolean(),
  /** Passages that were considered, and how many of them made it into the answer. */
  candidates: z.number().int().nonnegative(),
  selected: z.number().int().nonnegative(),
  /**
   * Which retrieval stages answered. `semantic` is missing when semantic
   * search is switched off or the model could not be reached; the answer is
   * then full-text alone, and says so.
   */
  stages: z.array(contextStageSchema),
  tookMs: z.number().int().nonnegative(),
});
export type ContextCompileResponse = z.infer<typeof contextCompileResponseSchema>;
