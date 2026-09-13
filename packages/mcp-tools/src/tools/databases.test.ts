import { describe, expect, it } from 'vitest';

import { type ExocortexApiClient } from '../client.js';
import { ToolInputValidationError } from '../tool.js';

import {
  databaseCreateTool,
  databaseOptionDeleteTool,
  databaseOptionUpdateTool,
  databasePropertyReorderTool,
  databaseRowGetTool,
  databaseSchemaTool,
  databaseViewReorderTool,
} from './databases.js';

interface RecordedCall {
  kind: 'request' | 'upload';
  method?: string;
  path: string;
  body?: unknown;
  query?: unknown;
}

/** Hand-written fake client: records every call, answers with a fixed response. */
function createFakeClient(response: unknown): {
  client: ExocortexApiClient;
  calls: RecordedCall[];
} {
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
        calls.push({
          kind: 'request',
          method: input.method,
          path: input.path,
          body: input.body,
          query: input.query,
        });
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

describe('databaseCreateTool', () => {
  it('creates the collection with its symbol, so no second call is needed', async () => {
    // `exo_page_create` used to be the way to a database with a symbol, via a
    // `type` it silently ignored (issue #41). The symbol has to arrive here
    // now, in the one call that also creates the columns.
    const { client, calls } = createFakeClient({
      ...rowDocument,
      id: 'col1234567',
      parentId: null,
      type: 'COLLECTION' as const,
      title: 'Aufgaben',
      icon: 'lucide:list-todo',
      iconColor: 'yellow',
    });

    const result = await databaseCreateTool.run(client, {
      workspaceId: 'ws1234567',
      title: 'Aufgaben',
      icon: 'lucide:list-todo',
      iconColor: 'yellow',
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toBe('/api/workspaces/ws1234567/documents');
    expect(calls[0]?.body).toEqual({
      title: 'Aufgaben',
      parentId: undefined,
      type: 'COLLECTION',
      icon: 'lucide:list-todo',
      iconColor: 'yellow',
    });
    expect(result.text).toContain('Aufgaben');
  });
});

/**
 * The four capabilities the browser had on its own until ADR-025: renaming and
 * removing a select option, and moving a column or a view. Each is checked for
 * the path it builds, because a wrong one fails at runtime against the API and
 * nowhere earlier -- the catalogue talks HTTP and the type checker never sees
 * the join.
 */
describe('the capabilities that used to be drag-and-drop only', () => {
  it('renames one option without touching the others', async () => {
    const { client, calls } = createFakeClient({
      id: 'opt123456',
      label: 'Erledigt',
      color: 'green',
      orderKey: 'a0',
    });

    const result = await databaseOptionUpdateTool.run(client, {
      documentId: 'col1234567',
      propertyId: 'prop123456',
      optionId: 'opt123456',
      label: 'Erledigt',
    });

    expect(calls).toEqual([
      {
        kind: 'request',
        method: 'PATCH',
        path: '/api/documents/col1234567/properties/prop123456/options/opt123456',
        body: { label: 'Erledigt' },
        query: undefined,
      },
    ]);
    expect(result.text).toContain('Erledigt');
  });

  it('refuses an option update that changes nothing', async () => {
    const { client, calls } = createFakeClient({});

    // The refine that `.extend()` drops has to be re-applied by hand, so this
    // is the assertion that the copy in the tool is still there.
    await expect(
      databaseOptionUpdateTool.run(client, {
        documentId: 'col1234567',
        propertyId: 'prop123456',
        optionId: 'opt123456',
      }),
    ).rejects.toThrow(ToolInputValidationError);
    expect(calls).toHaveLength(0);
  });

  it('removes one option', async () => {
    const { client, calls } = createFakeClient({ deleted: true });

    await databaseOptionDeleteTool.run(client, {
      documentId: 'col1234567',
      propertyId: 'prop123456',
      optionId: 'opt123456',
    });

    expect(calls[0]?.method).toBe('DELETE');
    expect(calls[0]?.path).toBe(
      '/api/documents/col1234567/properties/prop123456/options/opt123456',
    );
  });

  it('moves a column to the front with a null anchor', async () => {
    const { client, calls } = createFakeClient({
      id: 'prop123456',
      documentId: 'col1234567',
      name: 'Status',
      type: 'SELECT',
      config: {},
      options: [],
      orderKey: 'a0',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const result = await databasePropertyReorderTool.run(client, {
      documentId: 'col1234567',
      propertyId: 'prop123456',
      afterPropertyId: null,
    });

    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.path).toBe('/api/documents/col1234567/properties/prop123456/reorder');
    expect(calls[0]?.body).toEqual({ afterPropertyId: null, beforePropertyId: undefined });
    expect(result.text).toContain('Status');
  });

  it('moves a view behind another one', async () => {
    const { client, calls } = createFakeClient({
      id: 'view123456',
      documentId: 'col1234567',
      name: 'Board',
      type: 'BOARD',
      filters: { combinator: 'and', conditions: [] },
      sorts: [],
      groupByPropertyId: null,
      config: {},
      orderKey: 'a1',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    await databaseViewReorderTool.run(client, {
      documentId: 'col1234567',
      viewId: 'view123456',
      afterViewId: 'view000000',
    });

    expect(calls[0]?.path).toBe('/api/documents/col1234567/views/view123456/reorder');
    expect(calls[0]?.body).toEqual({ afterViewId: 'view000000' });
  });
});
