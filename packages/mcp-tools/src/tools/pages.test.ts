import { describe, expect, it } from 'vitest';

import { type ExocortexApiClient } from '../client.js';

import {
  pageArchiveTool,
  pageGenerateCoverTool,
  pageReadTool,
  pageResolveLinkTool,
  pageSetCoverTool,
  pageWriteTool,
} from './pages.js';

interface RecordedCall {
  kind: 'request' | 'upload';
  method?: string;
  path: string;
  body?: unknown;
  query?: unknown;
}

/** Hand-written fake client: records every call, answers with a fixed response. */
function createFakeClient(response: unknown): { client: ExocortexApiClient; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const client: ExocortexApiClient = {
    async request(input) {
      calls.push({
        kind: 'request',
        method: input.method,
        path: input.path,
        body: input.body,
        query: input.query,
      });
      return input.responseSchema.parse(response);
    },
    async upload(input) {
      calls.push({ kind: 'upload', path: input.path });
      return input.responseSchema.parse(response);
    },
  };
  return { client, calls };
}

describe('pageReadTool', () => {
  it('calls the markdown export endpoint and truncates long content', async () => {
    const longMarkdown = 'x'.repeat(70_000);
    const { client, calls } = createFakeClient({
      documentId: 'doc123456',
      filename: 'doc.md',
      markdown: longMarkdown,
    });

    const result = await pageReadTool.run(client, { documentId: 'doc123456' });

    expect(calls).toEqual([
      { kind: 'request', method: 'GET', path: '/api/documents/doc123456/export/markdown', body: undefined },
    ]);
    expect(result.text.length).toBeLessThan(longMarkdown.length);
    expect(result.text.endsWith('… (gekürzt)')).toBe(true);
    expect((result.data as { fullLength: number }).fullLength).toBe(longMarkdown.length);
  });
});

describe('pageWriteTool', () => {
  it('posts markdown to the content endpoint with the declared target', async () => {
    const { client, calls } = createFakeClient({
      documentId: 'doc123456',
      snapshotId: 'snap12345',
      yjsUpdatedAt: new Date().toISOString(),
      schemaVersion: 1,
      byteSize: 42,
      appliedToLiveSession: false,
      warnings: [],
    });

    const input = { documentId: 'doc123456', markdown: 'Hallo Welt', mode: 'replace' as const };
    const result = await pageWriteTool.run(client, input);

    expect(calls).toEqual([
      {
        kind: 'request',
        method: 'POST',
        path: '/api/documents/doc123456/content',
        body: { markdown: 'Hallo Welt', mode: 'replace' },
      },
    ]);
    expect(pageWriteTool.targetOf(input)).toBe('document:doc123456');
    expect(result.text).toContain('snap12345');
  });
});

describe('pageArchiveTool', () => {
  it('posts to the archive endpoint', async () => {
    const { client, calls } = createFakeClient({
      id: 'doc123456',
      workspaceId: 'ws1234567',
      parentId: null,
      type: 'PAGE',
      title: 'Archivierte Seite',
      icon: null,
      iconColor: null,
      layout: 'narrow',
      coverAttachmentId: null,
      coverPosition: 50,
      orderKey: 'a0',
      createdById: 'user1234',
      updatedById: 'user1234',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      archivedAt: new Date().toISOString(),
    });

    const result = await pageArchiveTool.run(client, { documentId: 'doc123456' });

    expect(calls).toEqual([
      { kind: 'request', method: 'POST', path: '/api/documents/doc123456/archive', body: undefined },
    ]);
    expect(result.text).toContain('Archivierte Seite');
  });
});

describe('pageSetCoverTool', () => {
  const summary = {
    id: 'doc123456',
    workspaceId: 'ws1234567',
    parentId: null,
    type: 'PAGE' as const,
    title: 'Seite mit Bild',
    icon: null,
    iconColor: null,
    layout: 'narrow' as const,
    coverAttachmentId: 'att1234567',
    coverPosition: 20,
    orderKey: 'a0',
    createdById: 'user1234',
    updatedById: 'user1234',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    archivedAt: null,
  };

  it('patches the page with the attachment and the crop', async () => {
    const { client, calls } = createFakeClient(summary);

    const result = await pageSetCoverTool.run(client, {
      documentId: 'doc123456',
      attachmentId: 'att1234567',
      position: 20,
    });

    expect(calls).toEqual([
      {
        kind: 'request',
        method: 'PATCH',
        path: '/api/documents/doc123456',
        body: { coverAttachmentId: 'att1234567', coverPosition: 20 },
      },
    ]);
    expect(result.text).toContain('Titelbild gesetzt');
  });

  it('removes the cover without touching the crop', async () => {
    const { client, calls } = createFakeClient({ ...summary, coverAttachmentId: null, coverPosition: 50 });

    const result = await pageSetCoverTool.run(client, {
      documentId: 'doc123456',
      attachmentId: null,
      position: 20,
    });

    expect(calls).toEqual([
      {
        kind: 'request',
        method: 'PATCH',
        path: '/api/documents/doc123456',
        body: { coverAttachmentId: null },
      },
    ]);
    expect(result.text).toContain('Titelbild entfernt');
  });
});

describe('pageResolveLinkTool', () => {
  it('reports when no page has that title', async () => {
    const { client, calls } = createFakeClient({ title: 'Nirgendwo', matches: [], resolvedBy: 'none' });

    const result = await pageResolveLinkTool.run(client, {
      workspaceId: 'ws1234567',
      title: 'Nirgendwo',
    });

    expect(calls).toEqual([
      {
        kind: 'request',
        method: 'GET',
        path: '/api/workspaces/ws1234567/documents/resolve',
        query: { title: 'Nirgendwo', includeArchived: true, limit: 10 },
      },
    ]);
    expect(result.text).toBe('Keine Seite mit dem Titel "Nirgendwo".');
  });

  it('reports a single match without a path', async () => {
    const { client, calls } = createFakeClient({
      title: 'Ziel',
      resolvedBy: 'title',
      matches: [
        {
          id: 'doc123456',
          workspaceId: 'ws1234567',
          type: 'PAGE',
          title: 'Ziel',
          icon: null,
          iconColor: null,
          archivedAt: null,
          path: [],
        },
      ],
    });

    const result = await pageResolveLinkTool.run(client, {
      workspaceId: 'ws1234567',
      title: 'Ziel',
    });

    expect((calls[0] as { query: unknown }).query).toEqual({
      title: 'Ziel',
      includeArchived: true,
      limit: 10,
    });
    expect(result.text).toBe('Ziel (id: doc123456)');
  });

  it('reports every match with its path when the title is ambiguous', async () => {
    const { client } = createFakeClient({
      title: 'Doppelt',
      resolvedBy: 'title',
      matches: [
        {
          id: 'doc1111111',
          workspaceId: 'ws1234567',
          type: 'PAGE',
          title: 'Doppelt',
          icon: null,
          iconColor: null,
          archivedAt: null,
          path: [{ id: 'parent1234', title: 'Elternseite' }],
        },
        {
          id: 'doc2222222',
          workspaceId: 'ws1234567',
          type: 'PAGE',
          title: 'Doppelt',
          icon: null,
          iconColor: null,
          archivedAt: '2026-01-01T00:00:00.000Z',
          path: [],
        },
      ],
    });

    const result = await pageResolveLinkTool.run(client, {
      workspaceId: 'ws1234567',
      title: 'Doppelt',
    });

    expect(result.text).toBe(
      'Doppelt (id: doc1111111, Pfad: Elternseite)\nDoppelt (id: doc2222222, archiviert)',
    );
  });

  it('resolves by identity, so a renamed target still answers', async () => {
    const { client, calls } = createFakeClient({
      title: 'Neuer Name',
      resolvedBy: 'id',
      matches: [
        {
          id: 'doc123456',
          workspaceId: 'ws1234567',
          type: 'PAGE',
          title: 'Neuer Name',
          icon: null,
          iconColor: null,
          archivedAt: null,
          path: [],
        },
      ],
    });

    const result = await pageResolveLinkTool.run(client, {
      workspaceId: 'ws1234567',
      documentId: 'doc123456',
      title: 'Alter Name',
    });

    expect((calls[0] as { query: unknown }).query).toEqual({
      documentId: 'doc123456',
      title: 'Alter Name',
      includeArchived: true,
      limit: 10,
    });
    expect(result.text).toBe('Neuer Name (id: doc123456)');
  });

  it('says so when the identity is gone and the title had to stand in', async () => {
    const { client } = createFakeClient({
      title: 'Ziel',
      resolvedBy: 'title',
      matches: [
        {
          id: 'doc999999',
          workspaceId: 'ws1234567',
          type: 'PAGE',
          title: 'Ziel',
          icon: null,
          iconColor: null,
          archivedAt: null,
          path: [],
        },
      ],
    });

    const result = await pageResolveLinkTool.run(client, {
      workspaceId: 'ws1234567',
      documentId: 'doc123456',
      title: 'Ziel',
    });

    expect(result.text).toContain('Über den Titel aufgelöst');
  });

  it('reports an unresolved reference when neither identity nor title answers', async () => {
    const { client } = createFakeClient({ title: 'Weg', matches: [], resolvedBy: 'none' });

    const result = await pageResolveLinkTool.run(client, {
      workspaceId: 'ws1234567',
      documentId: 'doc123456',
      title: 'Weg',
    });

    expect(result.text).toContain('unaufgelöst');
  });
});

describe('pageGenerateCoverTool', () => {
  it('asks the API to draw one and reports that it is not finished yet', async () => {
    const { client, calls } = createFakeClient({ status: 'pending', documentId: 'doc123456' });

    const result = await pageGenerateCoverTool.run(client, {
      documentId: 'doc123456',
      prompt: 'Berge im Morgennebel',
    });

    expect(calls).toEqual([
      {
        kind: 'request',
        method: 'POST',
        path: '/api/documents/doc123456/cover/generate',
        body: { prompt: 'Berge im Morgennebel' },
      },
    ]);
    expect(result.text).toContain('wird erzeugt');
  });

  it('refuses a prompt too short to mean anything', async () => {
    const { client, calls } = createFakeClient({ status: 'pending', documentId: 'doc123456' });

    await expect(
      pageGenerateCoverTool.run(client, { documentId: 'doc123456', prompt: 'x' }),
    ).rejects.toThrow();
    expect(calls).toEqual([]);
  });
});
