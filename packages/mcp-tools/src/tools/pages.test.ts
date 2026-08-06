import { describe, expect, it } from 'vitest';

import { type ExocortexApiClient } from '../client.js';

import { pageArchiveTool, pageReadTool, pageSetCoverTool, pageWriteTool } from './pages.js';

interface RecordedCall {
  kind: 'request' | 'upload';
  method?: string;
  path: string;
  body?: unknown;
}

/** Hand-written fake client: records every call, answers with a fixed response. */
function createFakeClient(response: unknown): { client: ExocortexApiClient; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const client: ExocortexApiClient = {
    async request(input) {
      calls.push({ kind: 'request', method: input.method, path: input.path, body: input.body });
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
