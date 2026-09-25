import { z } from 'zod';

import { overviewModeSchema } from './documents';
import {
  DOCUMENT_ICON_COLORS,
  documentTypeSchema,
  idSchema,
  isoDateTimeSchema,
} from './primitives';

/**
 * What an overview page shows (issue #53, ADR-028).
 *
 * The composition is derived, so this is a read of a projection and never of a
 * page body. Two halves travel together because they are shown together and a
 * second round trip for the child list would only add latency: the composed
 * paragraph, which needs a model and may be absent, and the entries, which are
 * computed from the tree and are always there.
 */

export const overviewEntrySchema = z.object({
  documentId: idSchema,
  title: z.string(),
  icon: z.string().nullable(),
  iconColor: z.enum(DOCUMENT_ICON_COLORS).nullable(),
  type: documentTypeSchema,
  /** True when this child is itself an overview, so a reader can go one deeper. */
  isOverview: z.boolean(),
  /**
   * The child's digest: two or three sentences about it. `null` while no run
   * has produced one, which is what an entry looks like on the day it is
   * created.
   */
  summary: z.string().nullable(),
  /** Active sub-pages of this child, so a reader sees how much is underneath it. */
  childCount: z.number().int().nonnegative(),
});
export type OverviewEntry = z.infer<typeof overviewEntrySchema>;

/**
 * Why an overview reads the way it does. Four different silences would
 * otherwise all look like "there is no text here":
 *
 * `off`          the page is not an overview at all
 * `pending`      it is, and no composition has run yet
 * `ready`        a composition exists
 * `unavailable`  no model can be reached, so the list is all there will be
 */
export const overviewStateSchema = z.enum(['off', 'pending', 'ready', 'unavailable']);
export type OverviewState = z.infer<typeof overviewStateSchema>;

/**
 * Why the last refresh of an overview produced nothing, as a code (issue #98).
 *
 * Stored as JSON in `DocumentDigest.lastError`, so the browser words it in
 * its reader's language (`document.overview.errors`) and an agent can branch
 * on it. A row written before the codes existed holds a German sentence
 * instead; `readStoredOverviewError` answers `null` for it, and the sentence
 * is still served as `error`.
 */
export const overviewErrorDetailSchema = z.discriminatedUnion('code', [
  /** The page is an overview and has no sub-pages yet. */
  z.object({ code: z.literal('no_children') }),
  /** More sub-pages than `overview.maxChildren`; the list stays, no intro is composed. */
  z.object({ code: z.literal('too_many_children'), maxChildren: z.number().int().nonnegative() }),
  /** The model call failed; the reason is in the worker's log. */
  z.object({ code: z.literal('composition_failed') }),
]);
export type OverviewErrorDetail = z.infer<typeof overviewErrorDetailSchema>;

/** English, for the log and for `error`. */
export function overviewErrorMessage(detail: OverviewErrorDetail): string {
  switch (detail.code) {
    case 'no_children':
      return 'This overview page has no sub-pages yet.';
    case 'too_many_children':
      return `This overview page has more than ${detail.maxChildren} sub-pages; the list stays complete, no intro is composed.`;
    case 'composition_failed':
      return 'The intro could not be composed.';
  }
}

/** The form a code is stored in `DocumentDigest.lastError`. */
export function storeOverviewError(detail: OverviewErrorDetail): string {
  return JSON.stringify(detail);
}

/** A stored `lastError` read back as a code, or `null` for an older row's sentence. */
export function readStoredOverviewError(stored: string): OverviewErrorDetail | null {
  if (!stored.startsWith('{')) return null;
  try {
    const parsed = overviewErrorDetailSchema.safeParse(JSON.parse(stored));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export const documentOverviewResponseSchema = z.object({
  documentId: idSchema,
  mode: overviewModeSchema,
  state: overviewStateSchema,
  /** The composed opening paragraph, Markdown without headings. */
  intro: z.string().nullable(),
  generatedAt: isoDateTimeSchema.nullable(),
  /** Model slug behind `intro`, for the footer. */
  model: z.string().nullable(),
  /**
   * True when the children have changed since `intro` was composed. The text is
   * still shown: an overview from yesterday is worth more than an empty page,
   * and this is what the badge beside it says.
   */
  stale: z.boolean(),
  /**
   * Why the last refresh produced nothing, or `null`: English for a coded
   * failure, the stored German sentence for a row older than the codes.
   */
  error: z.string().nullable(),
  /** The same failure as a code, `null` when there is none or the row predates codes. */
  errorDetail: overviewErrorDetailSchema.nullable(),
  entries: z.array(overviewEntrySchema),
});
export type DocumentOverviewResponse = z.infer<typeof documentOverviewResponseSchema>;

/**
 * Asking for a refresh.
 *
 * Answered before the text exists, like the cover request: composing takes a
 * model call, so this only enqueues the work and the page learns the outcome
 * from `document.overview.updated`.
 *
 * `skipped` is not a failure. It means the deployment cannot compose right now
 * (AI off, overviews off) and `reason` says which, so a button can explain
 * itself instead of spinning.
 */
export const refreshDocumentOverviewResponseSchema = z.object({
  status: z.enum(['pending', 'skipped']),
  documentId: idSchema,
  reason: z.string().nullable(),
});
export type RefreshDocumentOverviewResponse = z.infer<typeof refreshDocumentOverviewResponseSchema>;
