import { afterEach, describe, expect, it, vi } from 'vitest';

import { type Logger } from '@exocortex/logger';

import { AiProviderError } from './provider';
import { createOptionalSearxngWebSearcher, createSearxngWebSearcher } from './searxng';
import { createOptionalSteelWebFetcher, createSteelWebFetcher } from './steel';

/**
 * The two web-research clients (issue #26).
 *
 * The payloads below have the shape of real answers from this host on
 * 2026-09-18: Steel's scrape of example.com and SearXNG's JSON search. A test written
 * against an invented shape proves that the parser agrees with the test, which
 * is exactly the failure a schema is supposed to catch.
 */

function fakeLogger(): Logger {
  const noop = (): void => {
    /* no output in tests */
  };
  const logger: Logger = {
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
    child: () => logger,
  };
  return logger;
}

function respondWith(body: unknown, status = 200): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(typeof body === 'string' ? body : JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    ),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const STEEL_ANSWER = {
  content: {
    markdown:
      'This domain is for use in documentation examples.\n\n[Learn more](https://iana.org/domains/example)',
  },
  metadata: {
    statusCode: 200,
    title: 'Example Domain',
    language: 'en',
    urlSource: 'https://example.com/',
    description: '',
    favicon: 'data:,',
    jsonLd: [],
  },
  links: [{ url: 'https://iana.org/domains/example', text: 'Learn more' }],
};

describe('fetching a page through Steel', () => {
  const fetcher = () =>
    createSteelWebFetcher({ baseUrl: 'http://steel.test/', logger: fakeLogger() });

  it('reads the markdown, the title and the address it ended up at', async () => {
    respondWith(STEEL_ANSWER);
    const page = await fetcher().fetch({ url: 'https://example.com' });
    expect(page.title).toBe('Example Domain');
    expect(page.url).toBe('https://example.com/');
    expect(page.statusCode).toBe(200);
    expect(page.markdown).toContain('documentation examples');
    expect(page.links).toEqual([{ url: 'https://iana.org/domains/example', text: 'Learn more' }]);
  });

  it('reports an empty description as absent rather than as an empty string', async () => {
    respondWith(STEEL_ANSWER);
    const page = await fetcher().fetch({ url: 'https://example.com' });
    expect(page.description).toBeNull();
  });

  it('falls back to the requested address when Steel names none', async () => {
    respondWith({ content: { markdown: 'hallo' } });
    const page = await fetcher().fetch({ url: 'https://example.com/x' });
    expect(page.url).toBe('https://example.com/x');
  });

  it('separates a page that did not load from a browser that is broken', async () => {
    respondWith({ message: 'net::ERR_CONNECTION_REFUSED' }, 400);
    await expect(fetcher().fetch({ url: 'https://example.com' })).rejects.toMatchObject({
      code: 'web_fetch_failed',
    });

    respondWith({ message: 'boom' }, 502);
    await expect(fetcher().fetch({ url: 'https://example.com' })).rejects.toMatchObject({
      code: 'ai_provider_unavailable',
    });
  });

  it('reports an unreachable browser as a provider failure, not as a result', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    await expect(fetcher().fetch({ url: 'https://example.com' })).rejects.toBeInstanceOf(
      AiProviderError,
    );
  });

  it('is not built at all without a base URL', () => {
    expect(createOptionalSteelWebFetcher({ baseUrl: undefined, logger: fakeLogger() })).toBeNull();
    expect(createOptionalSteelWebFetcher({ baseUrl: '', logger: fakeLogger() })).toBeNull();
  });
});

const SEARXNG_ANSWER = {
  query: 'zettelkasten',
  results: [
    {
      title: 'Zettelkasten',
      url: 'https://example.com/zettelkasten',
      content: 'A note-taking method',
      engine: 'google cse',
    },
    { title: 'No address', url: '', content: '', engine: 'brave' },
  ],
  answers: [],
  unresponsive_engines: [['duckduckgo', 'CAPTCHA']],
};

describe('searching through SearXNG', () => {
  const searcher = () =>
    createSearxngWebSearcher({ baseUrl: 'http://searxng.test/', logger: fakeLogger() });

  it('maps a hit onto title, address, snippet and engine', async () => {
    respondWith(SEARXNG_ANSWER);
    const answer = await searcher().search({ query: 'zettelkasten', limit: 10 });
    expect(answer.results[0]).toEqual({
      title: 'Zettelkasten',
      url: 'https://example.com/zettelkasten',
      snippet: 'A note-taking method',
      engine: 'google cse',
    });
  });

  it('drops a hit without an address instead of handing on a dead result', async () => {
    respondWith(SEARXNG_ANSWER);
    const answer = await searcher().search({ query: 'zettelkasten', limit: 10 });
    expect(answer.results).toHaveLength(1);
  });

  it('carries the engines that did not answer', async () => {
    respondWith(SEARXNG_ANSWER);
    const answer = await searcher().search({ query: 'zettelkasten', limit: 10 });
    expect(answer.unresponsiveEngines).toEqual(['duckduckgo: CAPTCHA']);
  });

  it('honours the limit', async () => {
    respondWith(SEARXNG_ANSWER);
    const answer = await searcher().search({ query: 'zettelkasten', limit: 0 });
    expect(answer.results).toHaveLength(0);
  });

  it('names the JSON format when SearXNG answers 403', async () => {
    respondWith('forbidden', 403);
    await expect(searcher().search({ query: 'x', limit: 5 })).rejects.toMatchObject({
      message: expect.stringContaining('search.formats'),
    });
  });

  it('is not built at all without a base URL', () => {
    expect(
      createOptionalSearxngWebSearcher({ baseUrl: undefined, logger: fakeLogger() }),
    ).toBeNull();
  });
});
