import { describe, expect, it } from 'vitest';

import { type ExocortexApiClient, ExocortexApiError } from './client.js';
import {
  listMcpResources,
  listMcpResourceTemplates,
  pageResourceUri,
  parseResourceUri,
  readMcpResource,
  workspaceTreeResourceUri,
} from './resources.js';

const NOW = '2026-09-08T10:00:00.000Z';

function workspace(id: string, name: string, slug: string): unknown {
  return {
    id,
    name,
    slug,
    createdAt: NOW,
    updatedAt: NOW,
    role: 'OWNER',
    memberCount: 1,
    isMemory: false,
  };
}

function overviewDocument(id: string, title: string, path: { id: string; title: string }[]) {
  return { id, title, icon: null, iconColor: null, type: 'PAGE', path };
}

function overview(workspaceId: string, workspaceName: string, documents: unknown[]): unknown {
  return {
    workspaceId,
    workspaceName,
    stats: {
      pageCount: documents.length,
      databaseCount: 0,
      editedThisWeek: documents.length,
      memberCount: 1,
      attachmentCount: 0,
      attachmentBytes: 0,
    },
    recentlyEdited: documents.map((document) => ({
      ...(document as Record<string, unknown>),
      editedAt: NOW,
      editedByName: null,
    })),
    databases: [],
    sections: [],
    attention: {
      openComments: { count: 0, documents: [] },
      brokenLinks: { count: 0, documents: [] },
      stalledAttachments: { count: 0, documents: [] },
      duplicateTitleHeadings: { count: 0, documents: [] },
    },
  };
}

/**
 * A client that answers by path, so a test can say what the API returned
 * without the tests knowing how the resource layer got there.
 */
function clientReturning(routes: Record<string, unknown>): ExocortexApiClient {
  return {
    async request(input) {
      const answer = routes[input.path];
      if (answer === undefined) {
        throw new ExocortexApiError('not_found', `no route: ${input.path}`, 404, null);
      }
      if (answer instanceof ExocortexApiError) throw answer;
      return input.responseSchema.parse(answer);
    },
    async upload(input) {
      return input.responseSchema.parse(undefined);
    },
  };
}

describe('resource URIs', () => {
  it('round-trips the two addressable shapes', () => {
    expect(parseResourceUri(pageResourceUri('doc12345'))).toEqual({
      kind: 'page',
      documentId: 'doc12345',
    });
    expect(parseResourceUri(workspaceTreeResourceUri('ws123456'))).toEqual({
      kind: 'workspace-tree',
      workspaceId: 'ws123456',
    });
  });

  it('refuses anything that is not one of them', () => {
    for (const uri of [
      'file:///etc/passwd',
      'exocortex://page/',
      'exocortex://page/../../secret',
      'exocortex://workspace/ws123456',
      'exocortex://page/doc12345/extra',
    ]) {
      expect(parseResourceUri(uri)).toBeNull();
    }
  });

  it('names both templates so a client can address a page it found elsewhere', () => {
    expect(listMcpResourceTemplates().map((template) => template.uriTemplate)).toEqual([
      'exocortex://page/{documentId}',
      'exocortex://workspace/{workspaceId}/tree',
    ]);
  });
});

describe('listMcpResources', () => {
  it('offers one tree per workspace plus the pages last worked on', async () => {
    const client = clientReturning({
      '/api/workspaces': { workspaces: [workspace('ws123456', 'Second Brain', 'second-brain')] },
      '/api/workspaces/ws123456/overview': overview('ws123456', 'Second Brain', [
        overviewDocument('doc12345', 'nginx', [{ id: 'sec12345', title: 'Technik' }]),
      ]),
    });

    const resources = await listMcpResources(client);

    expect(resources).toHaveLength(2);
    expect(resources[0]?.uri).toBe('exocortex://workspace/ws123456/tree');
    expect(resources[1]).toMatchObject({
      uri: 'exocortex://page/doc12345',
      title: 'nginx',
      // The path, not the bare title: a workspace can hold three pages
      // called "nginx" and the attach menu shows no sidebar.
      description: 'Second Brain: Technik',
      mimeType: 'text/markdown',
    });
  });

  it('keeps the listing when one workspace overview fails', async () => {
    const client = clientReturning({
      '/api/workspaces': {
        workspaces: [
          workspace('ws123456', 'Second Brain', 'second-brain'),
          workspace('ws999999', 'Kaputt', 'kaputt'),
        ],
      },
      '/api/workspaces/ws123456/overview': overview('ws123456', 'Second Brain', [
        overviewDocument('doc12345', 'nginx', []),
      ]),
      // ws999999 has no overview route: its request throws.
    });

    const resources = await listMcpResources(client);

    expect(resources.map((resource) => resource.uri)).toEqual([
      'exocortex://workspace/ws123456/tree',
      'exocortex://workspace/ws999999/tree',
      'exocortex://page/doc12345',
    ]);
  });
});

describe('readMcpResource', () => {
  it('reads a page as Markdown, with its path and children above it', async () => {
    const client = clientReturning({
      '/api/documents/doc12345/export/markdown': {
        documentId: 'doc12345',
        filename: 'nginx.md',
        view: 'content',
        chars: 16,
        map: null,
        markdown: '# nginx\n\nLäuft.',
        path: [{ id: 'sec12345', title: 'Technik' }],
        children: [
          {
            id: 'kid12345',
            workspaceId: 'ws123456',
            parentId: 'doc12345',
            type: 'PAGE',
            title: 'TLS',
            icon: null,
            iconColor: null,
            overviewMode: 'off',
            layout: 'narrow',
            coverAttachmentId: null,
            coverPosition: 50,
            orderKey: 'a0',
            createdById: 'usr12345',
            updatedById: 'usr12345',
            createdAt: NOW,
            updatedAt: NOW,
            archivedAt: null,
          },
        ],
      },
    });

    const result = await readMcpResource(client, 'exocortex://page/doc12345');

    const text = result?.contents[0]?.text ?? '';
    expect(text).toContain('Pfad: Technik');
    expect(text).toContain('TLS (id: kid12345)');
    expect(text).toContain('# nginx');
    expect(result?.contents[0]?.mimeType).toBe('text/markdown');
  });

  it('answers "not there" for a page this caller may not read', async () => {
    const client = clientReturning({
      '/api/documents/doc12345/export/markdown': new ExocortexApiError(
        'forbidden',
        'nope',
        403,
        null,
      ),
    });

    expect(await readMcpResource(client, 'exocortex://page/doc12345')).toBeNull();
  });

  it('lets a real failure stay a failure', async () => {
    const client = clientReturning({
      '/api/documents/doc12345/export/markdown': new ExocortexApiError(
        'internal_error',
        'boom',
        500,
        null,
      ),
    });

    await expect(readMcpResource(client, 'exocortex://page/doc12345')).rejects.toThrow('boom');
  });

  it('renders the workspace tree with the ids a follow-up call needs', async () => {
    const client = clientReturning({
      '/api/workspaces/ws123456/documents/tree': {
        nodes: [
          {
            id: 'sec12345',
            workspaceId: 'ws123456',
            parentId: null,
            type: 'PAGE',
            title: 'Technik',
            icon: null,
            iconColor: null,
            overviewMode: 'off',
            layout: 'narrow',
            coverAttachmentId: null,
            coverPosition: 50,
            orderKey: 'a0',
            createdById: 'usr12345',
            updatedById: 'usr12345',
            createdAt: NOW,
            updatedAt: NOW,
            archivedAt: null,
            children: [],
          },
        ],
        archived: [],
        path: [],
        totalCount: 1,
      },
    });

    const result = await readMcpResource(client, 'exocortex://workspace/ws123456/tree');

    expect(result?.contents[0]?.text).toContain('Technik (id: sec12345');
  });

  it('refuses a URI it does not own', async () => {
    const client = clientReturning({});
    expect(await readMcpResource(client, 'file:///etc/passwd')).toBeNull();
  });
});
