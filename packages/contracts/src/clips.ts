import { z } from 'zod';

import { captureResponseSchema } from './inbox';
import { documentTitleSchema, idSchema } from './primitives';

/**
 * Clipping a web page (issue #72).
 *
 * A clip is a capture that knows where it came from: the address is the point
 * of it, and the selected text is what the person actually wanted. Reading the
 * whole article is opt-in, because that is the only part that costs a browser,
 * a round trip and an address check -- a clip without it is three strings and
 * never leaves this host.
 */
export const clipRequestSchema = z.object({
  /** The page being clipped. Only http and https. */
  url: z.string().url().max(2000),
  /** The page's title as the browser knows it. Beats anything derived. */
  title: documentTitleSchema.optional(),
  /** What was selected when the clip happened. Kept verbatim, as a quote. */
  selection: z.string().max(20_000).optional(),
  /**
   * Read the whole page through the browser and keep its text. Off by default:
   * a share from a phone should not silently start a fetch, and the selection
   * is usually the reason someone clipped in the first place.
   */
  fetchPage: z.boolean().default(false),
  /** A target other than the inbox, for a share that knows its destination. */
  parentId: idSchema.optional(),
});
export type ClipRequest = z.infer<typeof clipRequestSchema>;

export const clipResponseSchema = captureResponseSchema.extend({
  /** Whether the page itself was read, rather than only what was handed over. */
  fetched: z.boolean(),
  /** True when the article text was cut to fit a page. */
  truncated: z.boolean(),
  /** Characters written to the page, provenance line included. */
  characters: z.number().int().nonnegative(),
});
export type ClipResponse = z.infer<typeof clipResponseSchema>;
