import { describe, expect, it } from 'vitest';

import { type ExocortexApiClient } from '../client.js';

import { databaseRowGetTool, databaseSchemaTool } from './databases.js';

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

const rowDocument = {
  id: 'doc123456',
  workspaceId: 'ws1234567',
  parentId: 'col1234567',
  type: 'PAGE' as const,
  title: 'Rechnung schreiben',
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
};

describe('databaseRowGetTool', () => {
  it('calls the row endpoint and reports the values of a real row', async () => {
    const { client, calls } = createFakeClient({
      row: {
        document: rowDocument,
        values: [{ propertyId: 'prop1234567', value: 'Erledigt' }],
      },
    });

    const result = await databaseRowGetTool.run(client, { documentId: 'doc123456' });

    expect(calls).toEqual([
      { kind: 'request', method: 'GET', path: '/api/documents/doc123456/row', body: undefined },
    ]);
    expect(result.text).toContain('Rechnung schreiben (id: doc123456)');
    expect(result.text).toContain('prop1234567: Erledigt');
  });

  it('says so, not an error, when the document is not a row', async () => {
    const { client } = createFakeClient({ row: null });

    const result = await databaseRowGetTool.run(client, { documentId: 'doc123456' });

    expect(result.text).toBe('Seite doc123456 ist keine Datenbankzeile.');
    expect((result.data as { row: unknown }).row).toBeNull();
  });
});

describe('databaseSchemaTool', () => {
  it('reports the row count alongside the columns and views (issue #17)', async () => {
    const now = new Date().toISOString();
    const responsesByPath: Record<string, unknown> = {
      '/api/documents/col1234567': {
        id: 'col1234567',
        workspaceId: 'ws1234567',
        parentId: null,
        type: 'COLLECTION',
        title: 'Aufgaben',
        icon: null,
        iconColor: null,
        layout: 'full',
        coverAttachmentId: null,
        coverPosition: 50,
        orderKey: 'a0',
        createdById: 'user1234',
        updatedById: 'user1234',
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        access: 'write',
        breadcrumb: [],
        materializedAt: null,
        schemaVersion: 1,
        aiRuleMode: 'off',
        aiRuleTrigger: null,
        aiRulePriority: 100,
        createdByName: 'Owner',
        updatedByName: 'Owner',
        parentType: null,
        rowCount: 3,
      },
      '/api/documents/col1234567/properties': {
        properties: [
          {
            id: 'prop1234567',
            documentId: 'col1234567',
            type: 'TEXT',
            name: 'Titel',
            orderKey: 'a0',
            config: null,
            options: [],
            createdAt: now,
            updatedAt: now,
          },
        ],
      },
      '/api/documents/col1234567/views': {
        views: [
          {
            id: 'view1234567',
            documentId: 'col1234567',
            type: 'TABLE',
            name: 'Tabelle',
            orderKey: 'a0',
            filters: { combinator: 'and', conditions: [] },
            sorts: [],
            groupByPropertyId: null,
            config: {},
            createdAt: now,
            updatedAt: now,
          },
        ],
      },
    };
    const calls: RecordedCall[] = [];
    const client: ExocortexApiClient = {
      async request(input) {
        calls.push({ kind: 'request', method: input.method, path: input.path, body: input.body, query: input.query });
        return input.responseSchema.parse(responsesByPath[input.path]);
      },
      async upload() {
        throw new Error('databaseSchemaTool never uploads');
      },
    };

    const result = await databaseSchemaTool.run(client, { documentId: 'col1234567' });

    expect(calls.map((call) => call.path).sort()).toEqual([
      '/api/documents/col1234567',
      '/api/documents/col1234567/properties',
      '/api/documents/col1234567/views',
    ]);
    expect(result.text).toContain('Zeilen: 3');
    expect(result.text).toContain('Titel');
    expect(result.text).toContain('Tabelle');
    expect((result.data as { rowCount: number | null }).rowCount).toBe(3);
  });
});
