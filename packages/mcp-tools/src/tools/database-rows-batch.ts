import { z } from 'zod';

import {
  databaseRowIdsRequestSchema,
  databaseRowsResponseSchema,
  idSchema,
  trashDatabaseRowsResponseSchema,
  updateDatabaseRowsRequestSchema,
} from '@exocortex/contracts';

import { type AnyToolDefinition, defineTool } from '../tool.js';

/**
 * Several rows of one database at once (issue #244): what the selection bar
 * of a table does, for an agent. Each is one request, and the server checks
 * every row before it changes any, so a refusal changes nothing.
 */

const SELECTION =
  'rowIds sind die Kennungen der Zeilen (höchstens 100), alle aus der Datenbank documentId. ' +
  'Gehört eine nicht dazu oder liegt sie im Papierkorb, passiert gar nichts (database_rows_not_found nennt sie).';

const rowsUpdateInputSchema = z
  .object({ documentId: idSchema })
  .extend(updateDatabaseRowsRequestSchema.shape);

export const databaseRowsUpdateTool: AnyToolDefinition = defineTool({
  name: 'exo_database_rows_update',
  description:
    'Setzt dieselben Spaltenwerte in mehreren Zeilen einer Datenbank auf einmal, z. B. Status ' +
    '"erledigt" für zwölf Zeilen. Werte wie bei exo_database_row_update; alles oder nichts. ' +
    SELECTION,
  inputSchema: rowsUpdateInputSchema,
  surfaces: ['mcp', 'ai'],
  domain: 'databases',
  mutating: true,
  destructive: true,
  target: (input) => `document:${input.documentId}`,
  async execute(client, input) {
    const { documentId, ...body } = input;
    const result = await client.request({
      method: 'PATCH',
      path: `/api/documents/${documentId}/rows/values`,
      body,
      responseSchema: databaseRowsResponseSchema,
    });
    return {
      text: `${result.rows.length} Zeile(n) aktualisiert: ${titles(result.rows)}`,
      data: result,
    };
  },
});

const rowsInputSchema = z
  .object({ documentId: idSchema })
  .extend(databaseRowIdsRequestSchema.shape);

export const databaseRowsTrashTool: AnyToolDefinition = defineTool({
  name: 'exo_database_rows_trash',
  description:
    'Legt mehrere Zeilen einer Datenbank in den Papierkorb, wie exo_page_archive es für eine ' +
    'Seite tut: Unterseiten einer Zeile gehen mit, jede Zeile lässt sich mit exo_page_restore ' +
    'einzeln zurückholen. ' +
    SELECTION,
  inputSchema: rowsInputSchema,
  surfaces: ['mcp', 'ai'],
  domain: 'databases',
  mutating: true,
  destructive: true,
  target: (input) => `document:${input.documentId}`,
  async execute(client, input) {
    const { documentId, ...body } = input;
    const result = await client.request({
      method: 'POST',
      path: `/api/documents/${documentId}/rows/trash`,
      body,
      responseSchema: trashDatabaseRowsResponseSchema,
    });
    const lines = result.archived.map((entry) => `- ${entry.title} (id: ${entry.id})`);
    return {
      text: `${result.archived.length} Seite(n) im Papierkorb:\n${lines.join('\n')}`,
      data: result,
    };
  },
});

export const databaseRowsDuplicateTool: AnyToolDefinition = defineTool({
  name: 'exo_database_rows_duplicate',
  description:
    'Dupliziert Zeilen einer Datenbank: jede Kopie steht direkt unter ihrer Zeile, mit ' +
    'demselben Titel, Symbol, Titelbild, Text und denselben Werten, aber ohne Verbindung zum ' +
    'Original. Dateien, die die Kopie nennt, bleiben die der Originalzeile. ' +
    SELECTION,
  inputSchema: rowsInputSchema,
  surfaces: ['mcp', 'ai'],
  domain: 'databases',
  mutating: true,
  target: (input) => `document:${input.documentId}`,
  async execute(client, input) {
    const { documentId, ...body } = input;
    const result = await client.request({
      method: 'POST',
      path: `/api/documents/${documentId}/rows/duplicate`,
      body,
      responseSchema: databaseRowsResponseSchema,
    });
    return {
      text: `${result.rows.length} Kopie(n) angelegt: ${titles(result.rows)}`,
      data: result,
    };
  },
});

function titles(rows: readonly { document: { id: string; title: string } }[]): string {
  return rows.map((row) => `${row.document.title} (id: ${row.document.id})`).join(', ');
}

export const DATABASE_ROW_BATCH_TOOLS: readonly AnyToolDefinition[] = [
  databaseRowsUpdateTool,
  databaseRowsTrashTool,
  databaseRowsDuplicateTool,
];
