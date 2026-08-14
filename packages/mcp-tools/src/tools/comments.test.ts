import { describe, expect, it } from 'vitest';

import { type ExocortexApiClient } from '../client.js';

import {
  commentCreateTool,
  commentDeleteTool,
  commentListTool,
  commentResolveTool,
  commentUpdateTool,
} from './comments.js';

interface RecordedCall {
  method: string;
  path: string;
  query?: Readonly<Record<string, string | number | boolean | undefined>>;
  body?: unknown;
}

function createFakeClient(response: unknown): {
  client: ExocortexApiClient;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const client: ExocortexApiClient = {
    async request(input) {
      calls.push({ method: input.method, path: input.path, query: input.query, body: input.body });
      return input.responseSchema.parse(response);
    },
    async upload(input) {
      return input.responseSchema.parse(response);
    },
  };
  return { client, calls };
}

const NOW = '2026-08-09T10:00:00.000Z';

function comment(overrides: Record<string, unknown> = {}) {
  return {
    id: 'comment0001',
    documentId: 'doc1234567',
    parentId: null,
    blockId: null,
    anchorText: null,
    orphaned: false,
    body: 'Der Absatz widerspricht dem darüber.',
    createdBy: { id: 'user123456', name: 'Johanna' },
    createdAt: NOW,
    updatedAt: NOW,
    editedAt: null,
    resolvedAt: null,
    resolvedBy: null,
    ...overrides,
  };
}

const LIST_RESPONSE = {
  openCount: 1,
  resolvedCount: 1,
  threads: [
    {
      root: comment({
        id: 'comment0001',
        blockId: 'abcdefgh1234',
        anchorText: 'Die betroffene Stelle',
      }),
      replies: [comment({ id: 'comment0002', parentId: 'comment0001', body: 'Stimmt.' })],
    },
    {
      root: comment({
        id: 'comment0003',
        resolvedAt: NOW,
        resolvedBy: { id: 'user223456', name: 'Stefan' },
        body: 'Schon erledigt.',
      }),
      replies: [],
    },
  ],
};

describe('commentListTool', () => {
  it('renders open and resolved threads with their replies', async () => {
    const { client, calls } = createFakeClient(LIST_RESPONSE);

    const result = await commentListTool.run(client, { documentId: 'doc1234567' });

    expect(calls).toEqual([
      {
        method: 'GET',
        path: '/api/documents/doc1234567/comments',
        query: { includeResolved: true },
        body: undefined,
      },
    ]);
    expect(result.text).toContain('1 offen, 1 erledigt');
    expect(result.text).toContain('[offen] Johanna');
    expect(result.text).toContain('Block abcdefgh1234: „Die betroffene Stelle"');
    expect(result.text).toContain('↳ Johanna');
    expect(result.text).toContain('erledigt von Stefan');
  });

  it('says a thread is orphaned and still shows what it was about', async () => {
    const { client } = createFakeClient({
      openCount: 1,
      resolvedCount: 0,
      threads: [
        {
          root: comment({
            blockId: 'goneblock11',
            anchorText: 'Der gelöschte Absatz',
            orphaned: true,
          }),
          replies: [],
        },
      ],
    });

    const result = await commentListTool.run(client, { documentId: 'doc1234567' });
    expect(result.text).toContain('verwaist, ursprünglich: „Der gelöschte Absatz"');
  });

  it('passes includeResolved through and stays read-only', async () => {
    const { client, calls } = createFakeClient({ openCount: 0, resolvedCount: 0, threads: [] });
    const result = await commentListTool.run(client, {
      documentId: 'doc1234567',
      includeResolved: false,
    });

    expect(calls[0]?.query).toEqual({ includeResolved: false });
    expect(result.text).toContain('Kein anzuzeigender Faden.');
    expect(commentListTool.mutating).toBe(false);
  });
});

describe('commentCreateTool', () => {
  it('posts to the page and reports where the remark landed', async () => {
    const { client, calls } = createFakeClient({
      comment: comment({ blockId: 'abcdefgh1234', anchorText: 'Die Stelle' }),
    });

    const result = await commentCreateTool.run(client, {
      documentId: 'doc1234567',
      body: 'Hier fehlt eine Quelle.',
      blockId: 'abcdefgh1234',
      anchorText: 'Die Stelle',
    });

    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.path).toBe('/api/documents/doc1234567/comments');
    expect(calls[0]?.body).toEqual({
      body: 'Hier fehlt eine Quelle.',
      blockId: 'abcdefgh1234',
      anchorText: 'Die Stelle',
      parentId: null,
    });
    expect(result.text).toContain('Kommentar angelegt');
    expect(result.text).toContain('Block abcdefgh1234');
  });

  it('calls a reply a reply', async () => {
    const { client } = createFakeClient({
      comment: comment({ id: 'comment0009', parentId: 'comment0001' }),
    });
    const result = await commentCreateTool.run(client, {
      documentId: 'doc1234567',
      body: 'Sehe ich auch so.',
      parentId: 'comment0001',
    });
    expect(result.text).toContain('Antwort angelegt');
  });

  it('rejects a malformed block identifier before any request is made', async () => {
    const { client, calls } = createFakeClient({ comment: comment() });
    await expect(
      commentCreateTool.run(client, {
        documentId: 'doc1234567',
        body: 'Text',
        blockId: 'NOT-A-BLOCK-ID',
      }),
    ).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it('declares the page as its write target', () => {
    expect(commentCreateTool.mutating).toBe(true);
    expect(commentCreateTool.targetOf({ documentId: 'doc1234567', body: 'Text' })).toBe(
      'document:doc1234567',
    );
  });
});

describe('commentUpdateTool', () => {
  it('patches the comment itself and targets it', async () => {
    const { client, calls } = createFakeClient({ comment: comment({ editedAt: NOW }) });

    await commentUpdateTool.run(client, { commentId: 'comment0001', body: 'Neu formuliert' });

    expect(calls[0]).toMatchObject({
      method: 'PATCH',
      path: '/api/comments/comment0001',
      body: { body: 'Neu formuliert' },
    });
    expect(commentUpdateTool.targetOf({ commentId: 'comment0001', body: 'x'.repeat(3) })).toBe(
      'comment:comment0001',
    );
  });
});

describe('commentResolveTool', () => {
  it('resolves by default and can reopen', async () => {
    const resolved = createFakeClient({ comment: comment({ resolvedAt: NOW }) });
    const first = await commentResolveTool.run(resolved.client, { commentId: 'comment0001' });
    expect(resolved.calls[0]).toMatchObject({
      method: 'POST',
      path: '/api/comments/comment0001/resolve',
      body: { resolved: true },
    });
    expect(first.text).toContain('erledigt');

    const reopened = createFakeClient({ comment: comment() });
    const second = await commentResolveTool.run(reopened.client, {
      commentId: 'comment0001',
      resolved: false,
    });
    expect(reopened.calls[0]?.body).toEqual({ resolved: false });
    expect(second.text).toContain('wieder geöffnet');
  });
});

describe('commentDeleteTool', () => {
  it('names the replies that went with the root', async () => {
    const { client, calls } = createFakeClient({ deleted: true, removedReplies: 2 });

    const result = await commentDeleteTool.run(client, { commentId: 'comment0001' });

    expect(calls[0]).toMatchObject({ method: 'DELETE', path: '/api/comments/comment0001' });
    expect(result.text).toContain('2 Antwort(en)');
  });

  it('stays quiet about replies when there were none', async () => {
    const { client } = createFakeClient({ deleted: true, removedReplies: 0 });
    const result = await commentDeleteTool.run(client, { commentId: 'comment0001' });
    expect(result.text).toBe('Kommentar gelöscht.');
  });
});
