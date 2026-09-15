import { describe, expect, it } from 'vitest';

import { type ExocortexApiClient } from '../client.js';

import { researchFetchTool, researchSearchTool } from './research.js';

interface RecordedCall {
  method: string;
  path: string;
  query?: Readonly<Record<string, string | number | boolean | undefined>>;
}

/**
 * Answers each path with a canned payload. The research tools make several
 * calls per invocation, so a single-response fake would not exercise them.
 */
function createFakeClient(
  responses: Record<string, unknown>,
  options?: { appUrl?: string },
): { client: ExocortexApiClient; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const client: ExocortexApiClient = {
    appUrl: options?.appUrl,
    async request(input) {
      calls.push({ method: input.method, path: input.path, query: input.query });
      const response = responses[input.path];
      if (response === undefined) {
        throw new Error(`No canned response for ${input.path}`);
      }
      return input.responseSchema.parse(response);
    },
    async upload(input) {
      return input.responseSchema.parse(undefined);
    },
  };
  return { client, calls };
}

const NOW = '2026-08-10T10:00:00.000Z';

function workspace(id: string, name: string) {
  return {
    id,
    name,
    slug: name.toLowerCase(),
    role: 'OWNER' as const,
    memberCount: 1,
    createdAt: NOW,
    updatedAt: NOW,
    isMemory: false,
  };
}

function hit(overrides: Record<string, unknown> = {}) {
  return {
    documentId: 'doc1111111',
    workspaceId: 'ws11111111',
    title: 'Kalenderplan',
    icon: null,
    iconColor: null,
    type: 'PAGE' as const,
    path: [],
    snippet: 'Der <mark>Kalender</mark> läuft über eXocortex.',
    rank: 0.5,
    archivedAt: null,
    updatedAt: NOW,
    ...overrides,
  };
}

function searchResponse(results: unknown[]) {
  return { query: 'kalender', results, adapter: 'postgres', tookMs: 3 };
}

describe('search (deep research)', () => {
  it('merges hits from every workspace and ranks them together', async () => {
    const { client, calls } = createFakeClient(
      {
        '/api/workspaces': {
          workspaces: [workspace('ws11111111', 'Brain'), workspace('ws22222222', 'Arbeit')],
        },
        '/api/workspaces/ws11111111/search': searchResponse([
          hit({ rank: 0.2, documentId: 'docLow0001' }),
        ]),
        '/api/workspaces/ws22222222/search': searchResponse([
          hit({ rank: 0.9, documentId: 'docHigh001', workspaceId: 'ws22222222', title: 'Termine' }),
        ]),
      },
      { appUrl: 'https://exocortex.app' },
    );

    const result = await researchSearchTool.run(client, { query: 'kalender' });
    const payload = JSON.parse(result.text) as {
      results: { id: string; title: string; url?: string }[];
    };

    expect(payload.results.map((item) => item.id)).toEqual(['docHigh001', 'docLow0001']);
    expect(payload.results[0]?.url).toBe(
      'https://exocortex.app/arbeitsbereich/ws22222222/seite/docHigh001',
    );
    expect(calls.filter((call) => call.path.endsWith('/search'))).toHaveLength(2);
  });

  it('omits the url when the client has no public origin', async () => {
    const { client } = createFakeClient({
      '/api/workspaces': { workspaces: [workspace('ws11111111', 'Brain')] },
      '/api/workspaces/ws11111111/search': searchResponse([hit()]),
    });

    const result = await researchSearchTool.run(client, { query: 'kalender' });
    const payload = JSON.parse(result.text) as { results: Record<string, unknown>[] };

    // A wrong URL is worse than none: ChatGPT renders it as a citation a
    // person then clicks.
    expect(payload.results[0]).not.toHaveProperty('url');
  });

  it('answers with an empty result list rather than prose when nothing matches', async () => {
    const { client } = createFakeClient({
      '/api/workspaces': { workspaces: [workspace('ws11111111', 'Brain')] },
      '/api/workspaces/ws11111111/search': searchResponse([]),
    });

    const result = await researchSearchTool.run(client, { query: 'gibtesnicht' });
    expect(JSON.parse(result.text)).toEqual({ results: [] });
  });
});

function documentDetail(overrides: Record<string, unknown> = {}) {
  return {
    id: 'doc1111111',
    workspaceId: 'ws11111111',
    parentId: null,
    type: 'PAGE' as const,
    title: 'Kalenderplan',
    icon: null,
    iconColor: null,
    overviewMode: 'off',
    layout: 'narrow' as const,
    coverAttachmentId: null,
    coverPosition: 50,
    orderKey: 'a0',
    createdById: 'user111111',
    updatedById: 'user111111',
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    access: 'write' as const,
    breadcrumb: [],
    materializedAt: NOW,
    schemaVersion: 1,
    aiRuleMode: 'off' as const,
    aiRuleTrigger: null,
    aiRulePriority: 0,
    createdByName: 'Johanna',
    updatedByName: 'Johanna',
    parentType: null,
    rowCount: null,
    ...overrides,
  };
}

describe('fetch (deep research)', () => {
  it('returns the full Markdown with citation metadata', async () => {
    const { client } = createFakeClient(
      {
        '/api/documents/doc1111111': documentDetail(),
        '/api/documents/doc1111111/export/markdown': {
          documentId: 'doc1111111',
          filename: 'kalenderplan.md',
          markdown: '# Kalenderplan\n\neXocortex ist führend.',
          path: [{ id: 'parent11111', title: 'Projekte' }],
          children: [],
        },
      },
      { appUrl: 'https://exocortex.app' },
    );

    const result = await researchFetchTool.run(client, { id: 'doc1111111' });
    const payload = JSON.parse(result.text) as {
      id: string;
      title: string;
      text: string;
      url: string;
      metadata: { truncated: boolean; fullLength: number; path: string[] };
    };

    expect(payload.id).toBe('doc1111111');
    expect(payload.title).toBe('Kalenderplan');
    expect(payload.text).toContain('eXocortex ist führend.');
    expect(payload.url).toBe('https://exocortex.app/arbeitsbereich/ws11111111/seite/doc1111111');
    expect(payload.metadata.truncated).toBe(false);
    expect(payload.metadata.fullLength).toBe(payload.text.length);
    // Where the page sits travels with it: `results` has to keep the shape
    // deep research expects, so the metadata is the only place for it.
    expect(payload.metadata.path).toEqual(['Projekte']);
  });

  it('flags truncation instead of silently shortening the text', async () => {
    const markdown = 'x'.repeat(200_001);
    const { client } = createFakeClient({
      '/api/documents/doc1111111': documentDetail(),
      '/api/documents/doc1111111/export/markdown': {
        documentId: 'doc1111111',
        filename: 'lang.md',
        markdown,
        path: [],
        children: [],
      },
    });

    const result = await researchFetchTool.run(client, { id: 'doc1111111' });
    const payload = JSON.parse(result.text) as {
      text: string;
      metadata: { truncated: boolean; fullLength: number };
    };

    expect(payload.text).toHaveLength(200_000);
    expect(payload.metadata.truncated).toBe(true);
    expect(payload.metadata.fullLength).toBe(200_001);
  });
});
