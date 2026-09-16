import { describe, expect, it } from 'vitest';

import { type ExocortexApiClient } from '../client.js';

import { filingHint, pageSuggestParentTool } from './placement.js';

function clientWith(responses: Record<string, unknown>): ExocortexApiClient {
  return {
    async request(input) {
      const body = responses[input.path];
      if (body === undefined) throw new Error(`unexpected path: ${input.path}`);
      return input.responseSchema.parse(body);
    },
    async upload(input) {
      return input.responseSchema.parse({});
    },
  };
}

function node(id: string, title: string, children: unknown[] = []): Record<string, unknown> {
  return {
    id,
    workspaceId: 'ws1234567',
    parentId: null,
    type: 'PAGE',
    title,
    icon: null,
    iconColor: null,
    overviewMode: 'off',
    layout: 'narrow',
    coverAttachmentId: null,
    coverPosition: 50,
    orderKey: 'a0',
    createdById: 'user1234',
    updatedById: 'user1234',
    createdAt: '2026-09-16T00:00:00.000Z',
    updatedAt: '2026-09-16T00:00:00.000Z',
    archivedAt: null,
    children,
  };
}

describe('pageSuggestParentTool', () => {
  it('names the candidate and the pages that argue for it', async () => {
    const client = clientWith({
      '/api/workspaces/ws1234567/documents/suggest-parent': {
        query: 'Lokale Musik-KI-Modelle',
        adapter: 'hybrid',
        suggestions: [
          {
            parentId: 'creative12',
            title: 'Creative & Media',
            path: [{ id: 'aitools123', title: 'AI & Tools' }],
            score: 1.83,
            childCount: 15,
            matches: [
              { documentId: 'fish123456', title: 'Fish Audio S2', similarity: 0.71 },
              { documentId: 'heygen1234', title: 'HeyGen', similarity: 0.64 },
            ],
          },
        ],
      },
    });

    const result = await pageSuggestParentTool.run(client, {
      workspaceId: 'ws1234567',
      title: 'Lokale Musik-KI-Modelle',
    });

    expect(result.text).toContain('Creative & Media');
    expect(result.text).toContain('parentId: creative12');
    // The path, because a title is not an address: the candidate sits under
    // "AI & Tools", which is exactly the level the caller would have stopped at.
    expect(result.text).toContain('AI & Tools');
    expect(result.text).toContain('Fish Audio S2, HeyGen');
  });

  it('says so rather than inventing a place when nothing is close', async () => {
    const client = clientWith({
      '/api/workspaces/ws1234567/documents/suggest-parent': {
        query: 'etwas ganz Neues',
        adapter: 'postgres',
        suggestions: [],
      },
    });

    const result = await pageSuggestParentTool.run(client, {
      workspaceId: 'ws1234567',
      title: 'etwas ganz Neues',
    });

    expect(result.text).toContain('Kein Vorschlag');
    expect(result.text).toContain('exo_page_tree');
  });
});

describe('filingHint', () => {
  it('names the sections under the chosen parent, largest first', async () => {
    const client = clientWith({
      '/api/workspaces/ws1234567/documents/tree': {
        nodes: [
          node('agents1234', 'KI & Agenten', [node('child12345', 'Docling')]),
          node('creative12', 'Creative & Media', [
            node('child23456', 'HeyGen'),
            node('child34567', 'Fish Audio'),
          ]),
          node('loose12345', 'Eine lose Seite'),
        ],
        archived: [],
        path: [],
        totalCount: 5,
      },
    });

    const hint = await filingHint(client, 'ws1234567', 'aitools123');

    expect(hint).toContain('Creative & Media (2, id: creative12)');
    expect(hint).toContain('KI & Agenten');
    // A page with nothing under it is not a section and would only make the
    // hint longer than the answer it qualifies.
    expect(hint).not.toContain('Eine lose Seite');
    expect(hint).toContain('exo_page_move');
  });

  it('stays silent when the parent holds no sections', async () => {
    const client = clientWith({
      '/api/workspaces/ws1234567/documents/tree': {
        nodes: [node('child12345', 'HeyGen')],
        archived: [],
        path: [],
        totalCount: 1,
      },
    });

    expect(await filingHint(client, 'ws1234567', 'creative12')).toBe('');
  });

  it('never turns a created page into a failed call', async () => {
    const failing: ExocortexApiClient = {
      async request() {
        throw new Error('tree unreachable');
      },
      async upload(input) {
        return input.responseSchema.parse({});
      },
    };
    expect(await filingHint(failing, 'ws1234567', null)).toBe('');
  });
});
