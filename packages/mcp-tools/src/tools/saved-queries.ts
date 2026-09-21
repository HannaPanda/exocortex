import { z } from 'zod';

import {
  createSavedQueryRequestSchema,
  deleteSavedQueryResponseSchema,
  idSchema,
  reorderSavedQueryRequestSchema,
  type SavedQuery,
  savedQueryDefinitionSchema,
  savedQueryListResponseSchema,
  savedQueryResponseSchema,
  type SavedQueryResultsResponse,
  savedQueryResultsResponseSchema,
  updateSavedQueryRequestSchema,
} from '@exocortex/contracts';

import { type AnyToolDefinition, defineTool } from '../tool.js';

/**
 * Saved searches, smart views and query blocks (issue #74).
 *
 * The one thing a model has to understand here, and the reason the
 * descriptions keep saying it: a saved query stores a *question*, never an
 * answer. Asking for its results runs it again, so a list that was three pages
 * yesterday may be five today, and that is the feature rather than a bug to
 * work around by caching the ids.
 */

const DEFINITION_HELP =
  'Die Abfrage kombiniert: text (Suchbegriff) mit textMode HYBRID (Volltext plus Bedeutung) ' +
  'oder KEYWORD (nur Volltext), types (PAGE, COLLECTION, PROJECT), underDocumentId (nur ' +
  'unterhalb dieser Seite, zur Laufzeit aufgelöst), collectionId (nur Zeilen dieser Datenbank) ' +
  'mit propertyFilter (dieselben Filter wie eine Datenbankansicht), entityIds mit entityMatch ' +
  'ANY oder ALL, updated und created (je withinDays für ein mitwanderndes Fenster, sonst after ' +
  'und before), includeArchived, sort (RELEVANCE, UPDATED_DESC, UPDATED_ASC, CREATED_DESC, ' +
  'CREATED_ASC, TITLE_ASC, TITLE_DESC) und limit. Alle Felder sind optional.';

function formatSavedQuery(savedQuery: SavedQuery): string {
  const parts = [`- ${savedQuery.name} (id: ${savedQuery.id})`];
  if (savedQuery.description !== null) parts.push(savedQuery.description);
  if (savedQuery.inSidebar) parts.push('in der Navigation');
  const definition = savedQuery.definition;
  if (definition.text !== null && definition.text.length > 0) {
    parts.push(`Suchbegriff: "${definition.text}"`);
  }
  if (definition.underDocumentId !== null) parts.push(`unter ${definition.underDocumentId}`);
  if (definition.collectionId !== null) parts.push(`Datenbank ${definition.collectionId}`);
  return parts.join(' · ');
}

function formatResults(result: SavedQueryResultsResponse): string {
  if (result.results.length === 0) {
    return `Keine Treffer${result.name === null ? '' : ` für "${result.name}"`}.`;
  }
  const lines = result.results.map((hit, index) => {
    const location =
      hit.path.length === 0 ? 'oberste Ebene' : hit.path.map((entry) => entry.title).join(' > ');
    return `${index + 1}. ${hit.title} (id: ${hit.documentId}, in: ${location}) — ${hit.snippet}`;
  });
  // The reader has to know when the list stops short: acting on "there are
  // three of these" when there are forty is the failure the flag prevents.
  const more = result.truncated
    ? `\n(Das ist nicht die ganze Antwort, das Limit von ${result.definition.limit} hat sie gekürzt.)`
    : '';
  return `${lines.join('\n')}${more}`;
}

export const savedQueryListTool: AnyToolDefinition = defineTool({
  name: 'exo_saved_query_list',
  description:
    'Listet die gespeicherten Suchen eines Arbeitsbereichs, die als Smart View in der ' +
    'Navigation stehenden zuerst. Eine gespeicherte Suche ist eine Frage, keine Trefferliste: ' +
    'mit exo_saved_query_run wird sie beantwortet, und die Antwort kann sich jedes Mal ' +
    'unterscheiden.',
  inputSchema: z.object({ workspaceId: idSchema }),
  surfaces: ['mcp', 'ai'],
  domain: 'savedQueries',
  mutating: false,
  async execute(client, input) {
    const result = await client.request({
      method: 'GET',
      path: `/api/workspaces/${input.workspaceId}/saved-queries`,
      responseSchema: savedQueryListResponseSchema,
    });
    if (result.savedQueries.length === 0) {
      return {
        text:
          'Dieser Arbeitsbereich hat noch keine gespeicherten Suchen. exo_saved_query_create ' +
          'legt eine an, exo_saved_query_preview probiert eine Abfrage vorher aus.',
        data: result,
      };
    }
    return {
      text: `${result.savedQueries.length} gespeicherte Suche(n):\n${result.savedQueries
        .map(formatSavedQuery)
        .join('\n')}`,
      data: result,
    };
  },
});

export const savedQueryGetTool: AnyToolDefinition = defineTool({
  name: 'exo_saved_query_get',
  description:
    'Liest die vollständige Definition einer gespeicherten Suche: Abfrage, Darstellung und ob ' +
    'sie in der Navigation steht. Für die Treffer selbst exo_saved_query_run.',
  inputSchema: z.object({ savedQueryId: idSchema }),
  surfaces: ['mcp', 'ai'],
  domain: 'savedQueries',
  mutating: false,
  async execute(client, input) {
    const result = await client.request({
      method: 'GET',
      path: `/api/saved-queries/${input.savedQueryId}`,
      responseSchema: savedQueryResponseSchema,
    });
    return {
      text: `${formatSavedQuery(result.savedQuery)}\n${JSON.stringify(result.savedQuery.definition, null, 2)}`,
      data: result,
    };
  },
});

export const savedQueryPreviewTool: AnyToolDefinition = defineTool({
  name: 'exo_saved_query_preview',
  description:
    'Führt eine Abfrage aus, ohne sie zu speichern. Das ist der Weg, eine Suche erst zu prüfen ' +
    'und dann mit exo_saved_query_create abzulegen, und zugleich die mächtigere Schwester von ' +
    `exo_search: sie filtert zusätzlich nach Ort, Typ, Eigenschaften, Entitäten und Zeitraum. ${DEFINITION_HELP}`,
  inputSchema: z.object({
    workspaceId: idSchema,
    definition: savedQueryDefinitionSchema,
  }),
  surfaces: ['mcp', 'ai'],
  domain: 'savedQueries',
  mutating: false,
  async execute(client, input) {
    const result = await client.request({
      method: 'POST',
      path: `/api/workspaces/${input.workspaceId}/saved-queries/preview`,
      body: { definition: input.definition },
      responseSchema: savedQueryResultsResponseSchema,
    });
    return { text: formatResults(result), data: result };
  },
});

export const savedQueryRunTool: AnyToolDefinition = defineTool({
  name: 'exo_saved_query_run',
  description:
    'Beantwortet eine gespeicherte Suche jetzt. Die Treffer werden bei jedem Aufruf neu ' +
    'ermittelt und mit den Rechten des aufrufenden Kontos, nicht mit denen desjenigen, der die ' +
    'Suche angelegt hat. limit überschreibt das gespeicherte Limit.',
  inputSchema: z.object({
    savedQueryId: idSchema,
    limit: z.number().int().min(1).max(200).optional(),
  }),
  surfaces: ['mcp', 'ai'],
  domain: 'savedQueries',
  mutating: false,
  async execute(client, input) {
    const result = await client.request({
      method: 'GET',
      path: `/api/saved-queries/${input.savedQueryId}/results`,
      query: input.limit === undefined ? undefined : { limit: input.limit },
      responseSchema: savedQueryResultsResponseSchema,
    });
    return { text: formatResults(result), data: result };
  },
});

export const savedQueryCreateTool: AnyToolDefinition = defineTool({
  name: 'exo_saved_query_create',
  description:
    'Legt eine gespeicherte Suche an. Mit inSidebar: true wird daraus ein Smart View, also ein ' +
    'eigener Eintrag in der Navigation, den alle Mitglieder sehen. Gespeichert wird nur die ' +
    `Frage, nie die Treffer. ${DEFINITION_HELP}`,
  inputSchema: z.object({ workspaceId: idSchema }).extend(createSavedQueryRequestSchema.shape),
  surfaces: ['mcp', 'ai'],
  domain: 'savedQueries',
  mutating: true,
  target: (input) => `workspace:${input.workspaceId}`,
  async execute(client, input) {
    const { workspaceId, ...body } = input;
    const result = await client.request({
      method: 'POST',
      path: `/api/workspaces/${workspaceId}/saved-queries`,
      body,
      responseSchema: savedQueryResponseSchema,
    });
    return {
      text:
        `"${result.savedQuery.name}" gespeichert (id: ${result.savedQuery.id}). ` +
        'Beantworten mit exo_saved_query_run.',
      data: result,
    };
  },
});

export const savedQueryUpdateTool: AnyToolDefinition = defineTool({
  name: 'exo_saved_query_update',
  description:
    'Ändert Name, Beschreibung, Symbol, Abfrage, Darstellung oder die Sichtbarkeit in der ' +
    'Navigation. Nur die mitgegebenen Felder werden geändert; definition wird immer als Ganzes ' +
    `ersetzt, also vorher mit exo_saved_query_get lesen. ${DEFINITION_HELP}`,
  inputSchema: z.object({ savedQueryId: idSchema }).extend(updateSavedQueryRequestSchema.shape),
  surfaces: ['mcp', 'ai'],
  domain: 'savedQueries',
  mutating: true,
  target: (input) => `saved-query:${input.savedQueryId}`,
  async execute(client, input) {
    const { savedQueryId, ...body } = input;
    const result = await client.request({
      method: 'PATCH',
      path: `/api/saved-queries/${savedQueryId}`,
      body,
      responseSchema: savedQueryResponseSchema,
    });
    return { text: `Gespeicherte Suche "${result.savedQuery.name}" geändert.`, data: result };
  },
});

export const savedQueryReorderTool: AnyToolDefinition = defineTool({
  name: 'exo_saved_query_reorder',
  description:
    'Verschiebt eine gespeicherte Suche in der Reihenfolge der Navigation. Angegeben wird der ' +
    'Nachbar (afterId oder beforeId), nicht eine Position.',
  inputSchema: z
    .object({ savedQueryId: idSchema })
    .extend(reorderSavedQueryRequestSchema.shape)
    .describe('savedQueryId ist die bewegte Suche, afterId/beforeId der Nachbar.'),
  surfaces: ['mcp', 'ai'],
  domain: 'savedQueries',
  mutating: true,
  target: (input) => `saved-query:${input.savedQueryId}`,
  async execute(client, input) {
    const { savedQueryId, ...body } = input;
    const result = await client.request({
      method: 'POST',
      path: `/api/saved-queries/${savedQueryId}/position`,
      body,
      responseSchema: savedQueryResponseSchema,
    });
    return { text: `"${result.savedQuery.name}" verschoben.`, data: result };
  },
});

export const savedQueryDeleteTool: AnyToolDefinition = defineTool({
  name: 'exo_saved_query_delete',
  description:
    'Löscht eine gespeicherte Suche. Die Seiten, die sie gefunden hat, bleiben selbstverständlich ' +
    'unangetastet: eine gespeicherte Suche besitzt nichts. Weg ist nur die Frage, und die kommt ' +
    'nicht zurück.',
  inputSchema: z.object({ savedQueryId: idSchema }),
  surfaces: ['mcp', 'ai'],
  domain: 'savedQueries',
  mutating: true,
  destructive: true,
  target: (input) => `saved-query:${input.savedQueryId}`,
  async execute(client, input) {
    const result = await client.request({
      method: 'DELETE',
      path: `/api/saved-queries/${input.savedQueryId}`,
      responseSchema: deleteSavedQueryResponseSchema,
    });
    return {
      text: 'Die gespeicherte Suche ist gelöscht. Die gefundenen Seiten sind unberührt.',
      data: result,
    };
  },
});

export const SAVED_QUERY_TOOLS: readonly AnyToolDefinition[] = [
  savedQueryListTool,
  savedQueryGetTool,
  savedQueryPreviewTool,
  savedQueryRunTool,
  savedQueryCreateTool,
  savedQueryUpdateTool,
  savedQueryReorderTool,
  savedQueryDeleteTool,
];
