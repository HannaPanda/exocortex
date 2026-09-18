import { z } from 'zod';

/**
 * Web research: search the open web, then read one of the pages (issue #26).
 *
 * Two calls rather than one, because they are two different things that fail
 * separately. Search hands back addresses and is cheap; fetching renders a page
 * in a real browser and is the expensive half. A model that only ever gets the
 * merged version cannot decide to read nothing, which is the decision that
 * makes research cost what it should.
 *
 * Both answers carry text this deployment did not write. `ContentOrigin: 'web'`
 * in `./ai-trust` is what the built-in AI's loop does with that.
 */

export const webSearchRequestSchema = z.object({
  query: z.string().trim().min(2).max(500),
  /** Clamped against `ai.webSearchMaxResults`; absent means the setting decides. */
  limit: z.number().int().min(1).max(50).optional(),
  /**
   * SearXNG's `language`, e.g. `de` or `en-US`. Absent searches every language,
   * which is usually what a technical question wants.
   */
  language: z
    .string()
    .trim()
    .regex(/^[a-z]{2}(-[A-Za-z]{2})?$/)
    .optional(),
});
export type WebSearchRequest = z.infer<typeof webSearchRequestSchema>;

export const webSearchResultSchema = z.object({
  title: z.string(),
  url: z.string(),
  /** The engine's own snippet, not ours. Empty for engines that ship none. */
  snippet: z.string(),
  /** Which engine found this hit, so a forum post is not read as an index page. */
  engine: z.string(),
});
export type WebSearchResult = z.infer<typeof webSearchResultSchema>;

export const webSearchResponseSchema = z.object({
  query: z.string(),
  results: z.array(webSearchResultSchema),
  /**
   * Engines that did not answer, with the reason they gave.
   *
   * Carried all the way to the caller on purpose: SearXNG scrapes the engines,
   * and from a datacentre address some of them answer with a CAPTCHA. Without
   * this field a throttled engine and a genuinely rare topic look identical.
   */
  unresponsiveEngines: z.array(z.string()),
  tookMs: z.number().int().nonnegative(),
});
export type WebSearchResponse = z.infer<typeof webSearchResponseSchema>;

export const webFetchRequestSchema = z.object({
  url: z.string().trim().min(1).max(2_000),
  /** Clamped against `ai.webResearchMaxChars`; absent means the setting decides. */
  maxChars: z.number().int().min(500).max(200_000).optional(),
  /** Outgoing links of the page. Off by default: most fetches want the text. */
  includeLinks: z.boolean().default(false),
});
export type WebFetchRequest = z.infer<typeof webFetchRequestSchema>;

export const webFetchLinkSchema = z.object({ url: z.string(), text: z.string() });
export type WebFetchLink = z.infer<typeof webFetchLinkSchema>;

export const webFetchResponseSchema = z.object({
  /** The address that was requested, after normalization. */
  requestedUrl: z.string(),
  /** Where the browser ended up. Differs from the above on every redirect. */
  url: z.string(),
  title: z.string().nullable(),
  description: z.string().nullable(),
  statusCode: z.number().int().nullable(),
  /** The page as Markdown, already clamped to `maxChars`. */
  markdown: z.string(),
  /** True when the text was cut. The caller says so rather than pretending. */
  truncated: z.boolean(),
  links: z.array(webFetchLinkSchema),
  tookMs: z.number().int().nonnegative(),
});
export type WebFetchResponse = z.infer<typeof webFetchResponseSchema>;
