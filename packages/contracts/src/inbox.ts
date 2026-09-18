import { z } from 'zod';

import { documentSummarySchema } from './documents';
import { documentTitleSchema, idSchema } from './primitives';

/**
 * Quick capture and the inbox it fills (issue #71, ADR-036).
 *
 * A capture is not its own content type: it creates an ordinary page under an
 * ordinary page. What the request carries is therefore only what a hurried
 * caller has in hand -- some text, maybe where it came from -- and never a
 * place in the tree, because deciding that is the work capture exists to
 * postpone.
 */

export const captureRequestSchema = z.object({
  /** The captured text, Markdown. Its first line becomes the title. */
  text: z.string().min(1).max(100_000),
  /** Overrules the line the title would otherwise be derived from. */
  title: documentTitleSchema.optional(),
  /** Where this came from, in words: a site name, an app, a person. */
  source: z.string().trim().max(200).optional(),
  /** Where this came from, as an address. Rendered as a link under the text. */
  sourceUrl: z.string().url().max(2000).optional(),
  /**
   * A target other than the inbox. Present because a share target (issue #72)
   * may know its destination; leaving it out is the normal case and is what
   * makes capture cheap.
   */
  parentId: idSchema.optional(),
});
export type CaptureRequest = z.infer<typeof captureRequestSchema>;

export const captureResponseSchema = z.object({
  document: documentSummarySchema,
  /**
   * The page the capture landed under: the inbox, or whatever `parentId`
   * named. Null only when the target was the workspace root.
   */
  parent: documentSummarySchema.nullable(),
  /** Whether this call had to create the inbox first. */
  inboxCreated: z.boolean(),
  /** Deep link to the new page, or null when no app URL is configured. */
  url: z.string().nullable(),
});
export type CaptureResponse = z.infer<typeof captureResponseSchema>;

export const inboxResponseSchema = z.object({
  /** Null until the first capture: the inbox is created when it is first used. */
  inbox: documentSummarySchema.nullable(),
  /** What is waiting to be filed, newest first. */
  items: z.array(documentSummarySchema),
  /** How many entries the inbox holds in total; `items` may be capped. */
  itemCount: z.number().int().nonnegative(),
});
export type InboxResponse = z.infer<typeof inboxResponseSchema>;

export const inboxQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export type InboxQuery = z.infer<typeof inboxQuerySchema>;
