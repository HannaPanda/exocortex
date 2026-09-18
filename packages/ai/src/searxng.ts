import { z } from 'zod';

import { type Logger } from '@exocortex/logger';

import { AiProviderError } from './provider';

/** One hit, in the three fields every engine agrees on. */
export interface WebSearchResult {
  title: string;
  url: string;
  /** The engine's own snippet. Empty for engines that ship none. */
  snippet: string;
  /** Which engine produced this hit, so a run can tell a forum from an index. */
  engine: string;
}

export interface WebSearchAnswer {
  query: string;
  results: readonly WebSearchResult[];
  /**
   * Engines that did not answer this query, with the reason they gave.
   *
   * Reported rather than swallowed: SearXNG scrapes the engines itself, and
   * from a datacentre address some of them answer with a CAPTCHA instead of
   * results (DuckDuckGo does so from this host, measured 2026-09-18). A thin
   * result list is then a throttled engine, not a rare topic, and only this
   * field can tell the two apart.
   */
  unresponsiveEngines: readonly string[];
}

export interface WebSearchInput {
  query: string;
  /** Upper bound on hits handed back. The engines decide how many exist. */
  limit: number;
  /** UI language, passed through as SearXNG's `language`. */
  language?: string;
  timeoutMs?: number;
  correlationId?: string;
}

export interface WebSearcher {
  search(input: WebSearchInput): Promise<WebSearchAnswer>;
}

/**
 * The subset of SearXNG's `GET /search?format=json` response we read.
 *
 * Verified against SearXNG 2026.9.18 on 2026-09-18. `unresponsive_engines` is
 * an array of tuples rather than objects, which is why it is parsed as one.
 */
const searxngResponseSchema = z.object({
  query: z.string().default(''),
  results: z
    .array(
      z.object({
        title: z.string().default(''),
        url: z.string().default(''),
        content: z.string().nullish(),
        engine: z.string().default(''),
      }),
    )
    .default([]),
  unresponsive_engines: z.array(z.array(z.string())).default([]),
});

export interface SearxngWebSearcherOptions {
  /** Base URL of the SearXNG instance, e.g. `http://127.0.0.1:8090`. No trailing slash. */
  baseUrl: string;
  logger: Logger;
}

/**
 * Web search through a self-hosted SearXNG instance.
 *
 * SearXNG is a metasearch engine: it forwards the query to the real engines and
 * merges what comes back. That is the only shape that gets DuckDuckGo results
 * without us scraping DuckDuckGo, which has no search API and whose terms the
 * `ddgs`-style libraries break -- and it keeps every query on this host instead
 * of handing the full record of what this deployment wondered about to a search
 * vendor. The price is that SearXNG does the scraping, so an engine blocked
 * from this address is ordinary maintenance rather than a broken build; see
 * `unresponsiveEngines`.
 */
export function createSearxngWebSearcher(options: SearxngWebSearcherOptions): WebSearcher {
  const baseUrl = options.baseUrl.replace(/\/+$/, '');

  return {
    async search(input: WebSearchInput): Promise<WebSearchAnswer> {
      const controller = new AbortController();
      const timeoutMs = input.timeoutMs ?? 20_000;
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      const query = new URLSearchParams({ q: input.query, format: 'json' });
      if (input.language !== undefined) query.set('language', input.language);

      try {
        const response = await fetch(`${baseUrl}/search?${query.toString()}`, {
          method: 'GET',
          headers: { Accept: 'application/json' },
          signal: controller.signal,
        });

        if (!response.ok) {
          options.logger.error('SearXNG search failed', undefined, {
            correlationId: input.correlationId,
            status: response.status,
          });
          // 403 here almost always means one thing: `search.formats` in
          // settings.yml does not list `json`, and SearXNG refuses the format
          // rather than the query. Naming it saves the next person an hour.
          throw new AiProviderError(
            'ai_provider_unavailable',
            response.status === 403
              ? 'SearXNG refused the request; check that `search.formats` in settings.yml lists `json`'
              : `SearXNG responded with ${response.status}`,
          );
        }

        const parsed = searxngResponseSchema.safeParse(await response.json());
        if (!parsed.success) {
          throw new AiProviderError(
            'ai_provider_unavailable',
            `SearXNG returned an unexpected response shape: ${parsed.error.message.slice(0, 200)}`,
          );
        }

        return {
          query: parsed.data.query.length === 0 ? input.query : parsed.data.query,
          results: parsed.data.results
            // A hit without an address is one nothing can be done with, and
            // engines do occasionally emit them.
            .filter((result) => result.url.length > 0)
            .slice(0, input.limit)
            .map((result) => ({
              title: result.title,
              url: result.url,
              snippet: result.content ?? '',
              engine: result.engine,
            })),
          unresponsiveEngines: parsed.data.unresponsive_engines
            .map((entry) => entry.filter((part) => part.length > 0).join(': '))
            .filter((entry) => entry.length > 0),
        };
      } catch (error) {
        if (error instanceof AiProviderError) throw error;
        throw new AiProviderError(
          'ai_provider_unavailable',
          controller.signal.aborted
            ? `SearXNG did not answer within ${timeoutMs}ms`
            : `SearXNG is unreachable: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}

/** Null when no SearXNG URL is configured, so the search tool simply does not exist. */
export function createOptionalSearxngWebSearcher(options: {
  baseUrl: string | undefined;
  logger: Logger;
}): WebSearcher | null {
  if (options.baseUrl === undefined || options.baseUrl.length === 0) return null;
  return createSearxngWebSearcher({ baseUrl: options.baseUrl, logger: options.logger });
}
