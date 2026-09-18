import { z } from 'zod';

import { type Logger } from '@exocortex/logger';

import { AiProviderError } from './provider';

/**
 * One fetched web page, in the shape the research API hands on.
 *
 * `url` is what Steel says it ended up at, not what was asked for. Those differ
 * on every redirect, and the difference is load-bearing twice: the SSRF check
 * re-runs against it (`apps/api/src/research`), and the model attributes what it
 * read to the address it actually came from rather than the one it guessed.
 */
export interface WebPage {
  /** Final address after redirects, as the browser reports it. */
  url: string;
  title: string | null;
  description: string | null;
  /** Readable page text. Markdown, so headings and tables survive. */
  markdown: string;
  /** HTTP status of the fetched document, when the browser saw one. */
  statusCode: number | null;
  /** Outgoing links, so a run can follow one without guessing an address. */
  links: readonly WebPageLink[];
}

export interface WebPageLink {
  url: string;
  text: string;
}

export interface WebFetchInput {
  url: string;
  timeoutMs?: number;
  correlationId?: string;
}

export interface WebFetcher {
  fetch(input: WebFetchInput): Promise<WebPage>;
}

/**
 * The subset of Steel's `POST /v1/scrape` response we read.
 *
 * Verified against `ghcr.io/steel-dev/steel-browser:latest` on 2026-09-18.
 * Unknown keys are dropped by zod, and every field but `content` is optional,
 * because a page that failed halfway still reports whatever it managed to
 * collect and that is worth more than a parse error.
 */
const steelScrapeResponseSchema = z.object({
  content: z.object({ markdown: z.string().nullable().default(null) }).default({ markdown: null }),
  metadata: z
    .object({
      statusCode: z.number().int().nullable().default(null),
      title: z.string().nullable().default(null),
      description: z.string().nullable().default(null),
      urlSource: z.string().nullable().default(null),
    })
    .nullish(),
  links: z
    .array(z.object({ url: z.string(), text: z.string().default('') }))
    .nullish()
    .transform((links) => links ?? []),
});

/**
 * Links kept from one page.
 *
 * A navigation-heavy page has hundreds, and they are the least interesting part
 * of what was fetched: the text is the answer, the links are a convenience for
 * the next hop. The cap is here rather than in the API because it is a property
 * of how much a model can usefully be handed, not a policy a workspace tunes.
 */
const MAX_LINKS = 50;

function dropEmpty(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export interface SteelWebFetcherOptions {
  /** Base URL of the Steel browser, e.g. `http://127.0.0.1:3000`. No trailing slash. */
  baseUrl: string;
  /** Sent as `steel-api-key` when the instance asks for one. Self-hosted Steel does not. */
  apiKey?: string | undefined;
  logger: Logger;
}

/**
 * Web page fetching through a Steel browser instance.
 *
 * Steel is a headless Chrome behind an HTTP API. `POST /v1/scrape` renders the
 * page and returns it cleaned up, in **one** call -- which is the whole reason
 * this is the REST side of Steel rather than `steel-mcp-server`. That server is
 * built on the Web-Voyager pattern: click, scroll, type, screenshot with
 * numbered marks, one model round per step and a vision call per screenshot.
 * That is the right shape for "operate this interface" and the wrong one for
 * "read me this page", which is text and is one request.
 *
 * What this does not do is find a page. Search is a second client
 * (`./searxng`), because Steel has no index and a model that must already know
 * the address is looking something up, not researching.
 */
export function createSteelWebFetcher(options: SteelWebFetcherOptions): WebFetcher {
  const baseUrl = options.baseUrl.replace(/\/+$/, '');

  return {
    async fetch(input: WebFetchInput): Promise<WebPage> {
      const controller = new AbortController();
      const timeoutMs = input.timeoutMs ?? 45_000;
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await fetch(`${baseUrl}/v1/scrape`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(options.apiKey === undefined ? {} : { 'steel-api-key': options.apiKey }),
          },
          body: JSON.stringify({
            url: input.url,
            // Markdown only. Steel converts the *rendered* DOM, so a page with
            // text has markdown; the other formats it offers are HTML and a
            // `readability` blob that is also HTML, and handing a model tags
            // instead of prose is worse than handing it the honest "no text".
            format: ['markdown'],
            // Let the browser give up before this client does, so a slow page
            // is reported as a failed fetch rather than an aborted socket.
            delay: 0,
            timeout: Math.floor(timeoutMs * 0.9),
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          const detail = (await response.text()).slice(0, 300);
          options.logger.info('Steel could not fetch the page', {
            correlationId: input.correlationId,
            status: response.status,
          });
          // Steel answers 4xx for "that page did not load" and 5xx for "the
          // browser broke". Only the second is our infrastructure failing, and
          // the two have to stay apart: the first is an answer the model can
          // act on (try another address), the second is not.
          throw new AiProviderError(
            response.status >= 500 ? 'ai_provider_unavailable' : 'web_fetch_failed',
            `Steel responded with ${response.status}: ${detail}`,
          );
        }

        const parsed = steelScrapeResponseSchema.safeParse(await response.json());
        if (!parsed.success) {
          throw new AiProviderError(
            'ai_provider_unavailable',
            `Steel returned an unexpected response shape: ${parsed.error.message.slice(0, 200)}`,
          );
        }
        const payload = parsed.data;

        return {
          url: dropEmpty(payload.metadata?.urlSource) ?? input.url,
          title: dropEmpty(payload.metadata?.title),
          description: dropEmpty(payload.metadata?.description),
          markdown: dropEmpty(payload.content.markdown) ?? '',
          statusCode: payload.metadata?.statusCode ?? null,
          links: payload.links.slice(0, MAX_LINKS),
        };
      } catch (error) {
        if (error instanceof AiProviderError) throw error;
        // An abort is the timeout above; anything else is Steel not answering
        // at all. Both are "the browser did not deliver", never "the page said
        // no", so neither may be reported as a result.
        throw new AiProviderError(
          'ai_provider_unavailable',
          controller.signal.aborted
            ? `Steel did not answer within ${timeoutMs}ms`
            : `Steel is unreachable: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}

/** Null when no Steel URL is configured, so web research reports "not set up" rather than failing per call. */
export function createOptionalSteelWebFetcher(options: {
  baseUrl: string | undefined;
  apiKey?: string | undefined;
  logger: Logger;
}): WebFetcher | null {
  if (options.baseUrl === undefined || options.baseUrl.length === 0) return null;
  return createSteelWebFetcher({
    baseUrl: options.baseUrl,
    apiKey: options.apiKey,
    logger: options.logger,
  });
}
