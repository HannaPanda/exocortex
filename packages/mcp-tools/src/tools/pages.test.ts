import { describe, expect, it } from 'vitest';

import { type ExocortexApiClient } from '../client.js';

import {
  pageArchiveTool,
  pageGenerateCoverTool,
  pageReadTool,
  pageResolveLinkTool,
  pageSetCoverTool,
  pageTreeTool,
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
      path: [],
      children: [],
    });

    const result = await pageReadTool.run(client, { documentId: 'doc123456' });

    expect(calls).toEqual([
      { kind: 'request', method: 'GET', path: '/api/documents/doc123456/export/markdown', body: undefined },
    ]);
    expect(result.text.length).toBeLessThan(longMarkdown.length);
    expect(result.text.endsWith('… (gekürzt)')).toBe(true);
    expect((result.data as { fullLength: number }).fullLength).toBe(longMarkdown.length);
  });

  it('names the child pages, which the Markdown itself never mentions', async () => {
    // The failure this pins: a section page whose body lists its topics as
    // prose reads as complete, so a caller that only gets the body treats the
    // prose as the structure and never learns about the real subpages.
    const { client } = createFakeClient({
      documentId: 'doc123456',
      filename: 'kreativ.md',
      markdown: '# Kreativ\n\nBereiche: DIY, Audio, Rezepte.',
      path: [{ id: 'root1234567', title: 'Second Brain' }],
      children: [
        {
          id: 'child1234567',
          workspaceId: 'ws1234567',
          parentId: 'doc123456',
          type: 'PAGE' as const,
          title: 'Triple Chocolate Cookies',
          icon: null,
          iconColor: null,
          layout: 'narrow' as const,
          coverAttachmentId: null,
          coverPosition: 50,
          orderKey: 'a0',
          createdById: 'user1234',
          updatedById: 'user1234',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          archivedAt: null,
        },
      ],
    });

    const result = await pageReadTool.run(client, { documentId: 'doc123456' });

    expect(result.text).toContain('Pfad: Second Brain');
    expect(result.text).toContain('Unterseiten (1):');
    expect(result.text).toContain('- Triple Chocolate Cookies (id: child1234567, type: PAGE)');
    expect(result.text).toContain('Bereiche: DIY, Audio, Rezepte.');
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
  const archived = (id: string, title: string) => ({
    id,
    workspaceId: 'ws1234567',
    parentId: null,
    type: 'PAGE' as const,
    title,
    icon: null,
    iconColor: null,
    layout: 'narrow' as const,
    coverAttachmentId: null,
    coverPosition: 50,
    orderKey: 'a0',
    createdById: 'user1234',
    updatedById: 'user1234',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    archivedAt: new Date().toISOString(),
  });

  it('posts to the archive endpoint', async () => {
    const { client, calls } = createFakeClient({
      ...archived('doc123456', 'Archivierte Seite'),
      archivedDescendants: [],
    });

    const result = await pageArchiveTool.run(client, { documentId: 'doc123456' });

    expect(calls).toEqual([
      { kind: 'request', method: 'POST', path: '/api/documents/doc123456/archive', body: undefined },
    ]);
    expect(result.text).toContain('Archivierte Seite');
  });

  it('names the subpages that went into the trash along with it', async () => {
    // The failure this pins: archiving a section reported one page while it
    // moved eight, so nobody noticed four recipes had gone with it.
    const { client } = createFakeClient({
      ...archived('doc123456', 'Rezepte'),
      archivedDescendants: [
        archived('child1111111', 'Macadamia-Cookies'),
        archived('child2222222', 'Erdbeer-Tiramisu'),
      ],
    });

    const result = await pageArchiveTool.run(client, { documentId: 'doc123456' });

    expect(result.text).toContain('Mit archiviert wurden 2 Unterseite(n)');
    expect(result.text).toContain('- Macadamia-Cookies (id: child1111111, type: PAGE)');
    expect(result.text).toContain('- Erdbeer-Tiramisu (id: child2222222, type: PAGE)');
    expect(result.text).toContain('exo_page_restore');
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

describe('pageTreeTool', () => {
  function node(id: string, title: string, children: unknown[] = []) {
    return {
      id,
      workspaceId: 'm19i6551nw1eafb88aoisg6x',
      parentId: null,
      type: 'PAGE',
      title,
      icon: null,
      iconColor: null,
      layout: 'narrow',
      coverAttachmentId: null,
      coverPosition: 50,
      orderKey: 'V',
      createdById: 'uuuuuuuu1111uuuu',
      updatedById: 'uuuuuuuu1111uuuu',
      createdAt: '2026-08-11T00:00:00.000Z',
      updatedAt: '2026-08-11T00:00:00.000Z',
      archivedAt: null,
      children,
    };
  }

  /** A tree response with the bookkeeping fields filled in from the nodes. */
  function treeResponse(
    nodes: ReturnType<typeof node>[],
    archived: ReturnType<typeof node>[] = [],
    path: { id: string; title: string }[] = [],
  ) {
    const count = (list: { children: unknown[] }[]): number =>
      list.reduce(
        (sum, entry) => sum + 1 + count(entry.children as { children: unknown[] }[]),
        0,
      );
    return { nodes, archived, path, totalCount: count(nodes) };
  }

  it('puts the pages in the text, not only in the structured payload', async () => {
    // The regression this pins: the tool used to answer "3 Wurzelseiten, 1
    // archivierte Seiten" and leave the pages themselves in `data`. A client
    // that reads the text content -- ChatGPT does -- learned nothing from it
    // and started guessing which workspace to write into.
    const { client } = createFakeClient(
      treeResponse([
        node('aaaaaaaa1111aaaa', 'Projekte', [node('bbbbbbbb2222bbbb', 'Kalender')]),
        node('cccccccc3333cccc', 'Notizen'),
      ]),
    );

    const result = await pageTreeTool.run(client, { workspaceId: 'm19i6551nw1eafb88aoisg6x' });

    expect(result.text).toContain('- Projekte (id: aaaaaaaa1111aaaa, type: PAGE)');
    expect(result.text).toContain('  - Kalender (id: bbbbbbbb2222bbbb, type: PAGE)');
    expect(result.text).toContain('- Notizen (id: cccccccc3333cccc, type: PAGE)');
  });

  it('names the archived pages instead of only counting them', async () => {
    // A caller that just archived something, or that is looking for a page it
    // cannot find in the tree, cannot learn anything from a bare number.
    const { client } = createFakeClient(
      treeResponse(
        [node('aaaaaaaa1111aaaa', 'Projekte')],
        [{ ...node('zzzzzzzz9999zzzz', 'Alter Kram'), archivedAt: '2026-08-01T00:00:00.000Z' }],
      ),
    );

    const result = await pageTreeTool.run(client, { workspaceId: 'm19i6551nw1eafb88aoisg6x' });

    expect(result.text).toContain('1 archivierte Seite(n)');
    expect(result.text).toContain('- Alter Kram (id: zzzzzzzz9999zzzz, type: PAGE)');
  });

  it('answers a branch with its path and offers no truncation note when it fits', async () => {
    const { client, calls } = createFakeClient(
      treeResponse(
        [node('bbbbbbbb2222bbbb', 'Kalender')],
        [],
        [{ id: 'aaaaaaaa1111aaaa', title: 'Projekte' }],
      ),
    );

    const result = await pageTreeTool.run(client, {
      workspaceId: 'm19i6551nw1eafb88aoisg6x',
      parentId: 'aaaaaaaa1111aaaa',
    });

    expect((calls[0] as { query: unknown }).query).toEqual({ parentId: 'aaaaaaaa1111aaaa' });
    expect(result.text).toContain('Zweig unter: Projekte');
    expect(result.text).toContain('- Kalender (id: bbbbbbbb2222bbbb, type: PAGE)');
    expect(result.text).not.toContain('gekürzt');
  });

  it('says a branch is empty rather than saying the workspace is', async () => {
    const { client } = createFakeClient(
      treeResponse([], [], [{ id: 'aaaaaaaa1111aaaa', title: 'Projekte' }]),
    );

    const result = await pageTreeTool.run(client, {
      workspaceId: 'm19i6551nw1eafb88aoisg6x',
      parentId: 'aaaaaaaa1111aaaa',
    });

    expect(result.text).toContain('Keine Unterseiten.');
    expect(result.text).not.toContain('Keine Seiten vorhanden.');
  });

  it('keeps every root section visible and shares the rest of the budget out', async () => {
    // The failure this guards against: spending the whole budget inside the
    // first section, so a reader looking for the last one concludes it is not
    // there. 20 sections of 30 children each is 620 pages for a 300-line cap.
    const roots = Array.from({ length: 20 }, (_, i) =>
      node(
        `rrrrrrrr${String(i).padStart(4, '0')}`,
        `Abschnitt ${String(i)}`,
        Array.from({ length: 30 }, (_, j) =>
          node(`cccccccc${String(i).padStart(2, '0')}${String(j).padStart(2, '0')}`, `Kind ${String(i)}-${String(j)}`),
        ),
      ),
    );
    const { client } = createFakeClient(treeResponse(roots));

    const result = await pageTreeTool.run(client, { workspaceId: 'm19i6551nw1eafb88aoisg6x' });

    // Every section is named, the last one included ...
    expect(result.text).toContain('- Abschnitt 0 (');
    expect(result.text).toContain('- Abschnitt 19 (');
    // ... and the 280 remaining lines are split 14 apiece rather than being
    // eaten by the first section.
    expect(result.text).toContain('  - Kind 0-13 (');
    expect(result.text).not.toContain('  - Kind 0-14 (');
    expect(result.text).toContain('  - Kind 19-13 (');
    expect(result.text).toContain('… 320 von 620 Seite(n) hier nicht angezeigt (gekürzt)');
    // The advice names the parents it is talking about, so it is an
    // instruction a caller can actually follow.
    expect(result.text).toContain('Abschnitt 0 (parentId: rrrrrrrr0000, 16)');
  });

  it('lets a small section hand its unused share to a large one', async () => {
    const roots = [
      node('rrrrrrrr0000', 'Klein', [node('cccccccc0000', 'Einziges Kind')]),
      node(
        'rrrrrrrr0001',
        'Gross',
        Array.from({ length: 400 }, (_, j) =>
          node(`cccccccc1${String(j).padStart(3, '0')}`, `Kind ${String(j)}`),
        ),
      ),
    ];
    const { client } = createFakeClient(treeResponse(roots));

    const result = await pageTreeTool.run(client, { workspaceId: 'm19i6551nw1eafb88aoisg6x' });

    // Klein wants 1 of its 149, so Gross gets 297 instead of 149.
    expect(result.text).toContain('  - Einziges Kind (');
    expect(result.text).toContain('  - Kind 296 (');
    expect(result.text).not.toContain('  - Kind 297 (');
  });

  it('spends a section share on the nearest pages, not the deepest branch', async () => {
    const deep = node('ddddddddaaaa', 'Tief', [
      node('ddddddddbbbb', 'Ebene 1', [node('ddddddddcccc', 'Ebene 2', [node('dddddddddddd', 'Ebene 3')])]),
    ]);
    const wide = node(
      'wwwwwwwwaaaa',
      'Breit',
      Array.from({ length: 600 }, (_, j) => node(`wwwwwwww${String(j).padStart(4, '0')}`, `Breit ${String(j)}`)),
    );
    const { client } = createFakeClient(treeResponse([deep, wide]));

    const result = await pageTreeTool.run(client, { workspaceId: 'm19i6551nw1eafb88aoisg6x' });

    // Tief needs only 3 lines and gets all of them; Breit spends its share on
    // its own direct children rather than descending anywhere.
    expect(result.text).toContain('      - Ebene 3 (');
    expect(result.text).toContain('  - Breit 0 (');
  });

  it('shows part of the root level rather than nothing when even that overflows', async () => {
    const roots = Array.from({ length: 400 }, (_, i) =>
      node(`rrrrrrrr${String(i).padStart(4, '0')}`, `Abschnitt ${String(i)}`),
    );
    const { client } = createFakeClient(treeResponse(roots));

    const result = await pageTreeTool.run(client, { workspaceId: 'm19i6551nw1eafb88aoisg6x' });

    expect(result.text).toContain('- Abschnitt 0 (');
    expect(result.text).toContain('- Abschnitt 299 (');
    expect(result.text).not.toContain('- Abschnitt 300 (');
    expect(result.text).toContain('… 100 von 400 Seite(n) hier nicht angezeigt');
  });

  it('has something to say about an empty workspace', async () => {
    const { client } = createFakeClient(treeResponse([]));

    const result = await pageTreeTool.run(client, { workspaceId: 'm19i6551nw1eafb88aoisg6x' });

    expect(result.text).toBe('Keine Seiten vorhanden.');
  });
});
