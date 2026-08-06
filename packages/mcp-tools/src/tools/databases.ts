import { z } from 'zod';

import {
  createDatabasePropertyOptionRequestSchema,
  createDatabasePropertyRequestSchema,
  createDatabaseRowRequestSchema,
  createDatabaseViewRequestSchema,
  type DatabaseProperty,
  databasePropertyOptionSchema,
  databasePropertySchema,
  type DatabasePropertyType,
  type DatabaseRow,
  databaseRowSchema,
  databaseViewSchema,
  documentSummarySchema,
  documentTitleSchema,
  idSchema,
  IMPLEMENTED_PROPERTY_TYPES,
  queryDatabaseRowsRequestSchema,
  queryDatabaseRowsResponseSchema,
  updateDatabasePropertyRequestSchema,
  updateDatabaseRowValuesRequestSchema,
  updateDatabaseViewRequestSchema,
} from '@exocortex/contracts';

import { renderMarkdownTable } from '../format.js';
import {
  databasePropertyListResponseSchema,
  databaseViewListResponseSchema,
  deletedResultSchema,
} from '../local-schemas.js';
import { type AnyToolDefinition, defineTool } from '../tool.js';

/**
 * The query engine and property-write endpoint only implement a subset of the
 * 18 `DatabasePropertyType` values (`RELATION`/`ROLLUP`/`FORMULA` are
 * reserved). This enum is used for every tool input so the model is never
 * told it can create a property type the API will reject.
 */
const implementedPropertyTypeSchema = z.enum(
  IMPLEMENTED_PROPERTY_TYPES as unknown as readonly [DatabasePropertyType, ...DatabasePropertyType[]],
);

const createDatabaseRequestPropertySchema = z.object({
  type: implementedPropertyTypeSchema,
  name: z.string().trim().min(1).max(100),
});

const databaseCreateInputSchema = z.object({
  workspaceId: idSchema,
  title: documentTitleSchema.optional(),
  parentId: idSchema.nullable().optional(),
  properties: z.array(createDatabaseRequestPropertySchema).default([]),
});

export const databaseCreateTool: AnyToolDefinition = defineTool({
  name: 'exo_database_create',
  description: 'Legt eine neue Datenbank (Notion-artige Tabelle) mit optionalen Startspalten an.',
  inputSchema: databaseCreateInputSchema,
  surfaces: ['mcp', 'ai'],
  mutating: true,
  target: (input) => `workspace:${input.workspaceId}`,
  async execute(client, input) {
    const document = await client.request({
      method: 'POST',
      path: `/api/workspaces/${input.workspaceId}/documents`,
      body: { title: input.title, parentId: input.parentId, type: 'COLLECTION' },
      responseSchema: documentSummarySchema,
    });

    const properties: DatabaseProperty[] = [];
    for (const property of input.properties) {
      const created = await client.request({
        method: 'POST',
        path: `/api/documents/${document.id}/properties`,
        body: { type: property.type, name: property.name },
        responseSchema: databasePropertySchema,
      });
      properties.push(created);
    }

    return {
      text: `Datenbank erstellt: ${document.title} (id: ${document.id}) mit ${properties.length} Spalte(n).`,
      data: { document, properties },
    };
  },
});

export const databaseSchemaTool: AnyToolDefinition = defineTool({
  name: 'exo_database_schema',
  description: 'Liest Spalten und Ansichten einer Datenbank.',
  inputSchema: z.object({ documentId: idSchema }),
  surfaces: ['mcp', 'ai'],
  mutating: false,
  async execute(client, input) {
    const [properties, views] = await Promise.all([
      client.request({
        method: 'GET',
        path: `/api/documents/${input.documentId}/properties`,
        responseSchema: databasePropertyListResponseSchema,
      }),
      client.request({
        method: 'GET',
        path: `/api/documents/${input.documentId}/views`,
        responseSchema: databaseViewListResponseSchema,
      }),
    ]);
    const propertyLines = properties.properties.map((p) => `- ${p.name} (${p.type}, id: ${p.id})`);
    const viewLines = views.views.map((v) => `- ${v.name} (${v.type}, id: ${v.id})`);
    const text = [
      `Spalten (${properties.properties.length}):`,
      ...propertyLines,
      `Ansichten (${views.views.length}):`,
      ...viewLines,
    ].join('\n');
    return { text, data: { properties: properties.properties, views: views.views } };
  },
});

const databasePropertyCreateInputSchema = z
  .object({ documentId: idSchema })
  .extend(createDatabasePropertyRequestSchema.shape)
  .extend({ type: implementedPropertyTypeSchema });

export const databasePropertyCreateTool: AnyToolDefinition = defineTool({
  name: 'exo_database_property_create',
  description: 'Fügt einer Datenbank eine neue Spalte hinzu.',
  inputSchema: databasePropertyCreateInputSchema,
  surfaces: ['mcp', 'ai'],
  mutating: true,
  target: (input) => `document:${input.documentId}`,
  async execute(client, input) {
    const { documentId, ...body } = input;
    const result = await client.request({
      method: 'POST',
      path: `/api/documents/${documentId}/properties`,
      body,
      responseSchema: databasePropertySchema,
    });
    return { text: `Spalte erstellt: ${result.name} (${result.type}, id: ${result.id})`, data: result };
  },
});

/**
 * `.extend()` drops the base schema's own `.refine()` check (zod rebuilds a
 * plain `ZodObject` from the merged shape), so the "at least one field" rule
 * is re-applied here to keep the same validation the REST endpoint enforces.
 */
const databasePropertyUpdateInputSchema = z
  .object({ documentId: idSchema, propertyId: idSchema })
  .extend(updateDatabasePropertyRequestSchema.shape)
  .refine((value) => value.name !== undefined || value.config !== undefined, {
    message: 'At least one of "name" or "config" must be provided',
  });

export const databasePropertyUpdateTool: AnyToolDefinition = defineTool({
  name: 'exo_database_property_update',
  description: 'Ändert Name oder Konfiguration einer Datenbankspalte.',
  inputSchema: databasePropertyUpdateInputSchema,
  surfaces: ['mcp', 'ai'],
  mutating: true,
  target: (input) => `document:${input.documentId}`,
  async execute(client, input) {
    const { documentId, propertyId, ...body } = input;
    const result = await client.request({
      method: 'PATCH',
      path: `/api/documents/${documentId}/properties/${propertyId}`,
      body,
      responseSchema: databasePropertySchema,
    });
    return { text: `Spalte aktualisiert: ${result.name} (id: ${result.id})`, data: result };
  },
});

export const databasePropertyDeleteTool: AnyToolDefinition = defineTool({
  name: 'exo_database_property_delete',
  description: 'Löscht eine Datenbankspalte unwiderruflich, inklusive aller darin gespeicherten Werte.',
  inputSchema: z.object({ documentId: idSchema, propertyId: idSchema }),
  surfaces: ['mcp', 'ai'],
  mutating: true,
  target: (input) => `document:${input.documentId}`,
  async execute(client, input) {
    const result = await client.request({
      method: 'DELETE',
      path: `/api/documents/${input.documentId}/properties/${input.propertyId}`,
      responseSchema: deletedResultSchema,
    });
    return { text: `Spalte ${input.propertyId} gelöscht.`, data: result };
  },
});

const databaseOptionCreateInputSchema = z
  .object({ documentId: idSchema, propertyId: idSchema })
  .extend(createDatabasePropertyOptionRequestSchema.shape);

export const databaseOptionCreateTool: AnyToolDefinition = defineTool({
  name: 'exo_database_option_create',
  description: 'Fügt einer Auswahl-Spalte (SELECT/MULTI_SELECT) eine neue Option hinzu.',
  inputSchema: databaseOptionCreateInputSchema,
  surfaces: ['mcp', 'ai'],
  mutating: true,
  target: (input) => `document:${input.documentId}`,
  async execute(client, input) {
    const { documentId, propertyId, ...body } = input;
    const result = await client.request({
      method: 'POST',
      path: `/api/documents/${documentId}/properties/${propertyId}/options`,
      body,
      responseSchema: databasePropertyOptionSchema,
    });
    return { text: `Option erstellt: ${result.label} (id: ${result.id})`, data: result };
  },
});

const databaseViewCreateInputSchema = z
  .object({ documentId: idSchema })
  .extend(createDatabaseViewRequestSchema.shape);

export const databaseViewCreateTool: AnyToolDefinition = defineTool({
  name: 'exo_database_view_create',
  description: 'Legt eine neue Ansicht (Tabelle, Board, Galerie oder Kalender) für eine Datenbank an.',
  inputSchema: databaseViewCreateInputSchema,
  surfaces: ['mcp', 'ai'],
  mutating: true,
  target: (input) => `document:${input.documentId}`,
  async execute(client, input) {
    const { documentId, ...body } = input;
    const result = await client.request({
      method: 'POST',
      path: `/api/documents/${documentId}/views`,
      body,
      responseSchema: databaseViewSchema,
    });
    return { text: `Ansicht erstellt: ${result.name} (${result.type}, id: ${result.id})`, data: result };
  },
});

/** See the comment on `databasePropertyUpdateInputSchema` about re-applying the refine. */
const databaseViewUpdateInputSchema = z
  .object({ documentId: idSchema, viewId: idSchema })
  .extend(updateDatabaseViewRequestSchema.shape)
  .refine(
    (value) =>
      value.name !== undefined ||
      value.filters !== undefined ||
      value.sorts !== undefined ||
      value.groupByPropertyId !== undefined ||
      value.config !== undefined,
    { message: 'At least one field must be provided' },
  );

export const databaseViewUpdateTool: AnyToolDefinition = defineTool({
  name: 'exo_database_view_update',
  description: 'Ändert Name, Filter, Sortierung oder Konfiguration einer Ansicht.',
  inputSchema: databaseViewUpdateInputSchema,
  surfaces: ['mcp', 'ai'],
  mutating: true,
  target: (input) => `document:${input.documentId}`,
  async execute(client, input) {
    const { documentId, viewId, ...body } = input;
    const result = await client.request({
      method: 'PATCH',
      path: `/api/documents/${documentId}/views/${viewId}`,
      body,
      responseSchema: databaseViewSchema,
    });
    return { text: `Ansicht aktualisiert: ${result.name} (id: ${result.id})`, data: result };
  },
});

export const databaseViewDeleteTool: AnyToolDefinition = defineTool({
  name: 'exo_database_view_delete',
  description: 'Löscht eine Ansicht einer Datenbank.',
  inputSchema: z.object({ documentId: idSchema, viewId: idSchema }),
  surfaces: ['mcp', 'ai'],
  mutating: true,
  target: (input) => `document:${input.documentId}`,
  async execute(client, input) {
    const result = await client.request({
      method: 'DELETE',
      path: `/api/documents/${input.documentId}/views/${input.viewId}`,
      responseSchema: deletedResultSchema,
    });
    return { text: `Ansicht ${input.viewId} gelöscht.`, data: result };
  },
});

const MAX_QUERY_ROWS = 50;

function formatRow(row: DatabaseRow): string[] {
  return [row.document.title, ...row.values.map((v) => (v.value === null ? '' : String(v.value)))];
}

function propertyLabelsFor(rows: readonly DatabaseRow[]): string[] {
  return rows[0]?.values.map((v) => v.propertyId) ?? [];
}

const databaseQueryInputSchema = z
  .object({ documentId: idSchema })
  .extend(queryDatabaseRowsRequestSchema.shape);

export const databaseQueryTool: AnyToolDefinition = defineTool({
  name: 'exo_database_query',
  description: 'Fragt Zeilen einer Datenbank ab, optional über eine gespeicherte Ansicht oder ad-hoc-Filter.',
  inputSchema: databaseQueryInputSchema,
  surfaces: ['mcp', 'ai'],
  mutating: false,
  async execute(client, input) {
    const { documentId, ...body } = input;
    const result = await client.request({
      method: 'POST',
      path: `/api/documents/${documentId}/rows/query`,
      body,
      responseSchema: queryDatabaseRowsResponseSchema,
    });
    const capped = result.rows.slice(0, MAX_QUERY_ROWS);
    const headers = ['Titel', ...propertyLabelsFor(capped)];
    const text =
      capped.length === 0
        ? 'Keine Zeilen gefunden.'
        : renderMarkdownTable(headers, capped.map(formatRow)) +
          (result.rows.length > MAX_QUERY_ROWS
            ? `\n\n… ${result.rows.length - MAX_QUERY_ROWS} weitere Zeile(n) nicht angezeigt (gekürzt).`
            : '');
    return { text, data: result };
  },
});

const databaseRowCreateInputSchema = z
  .object({ documentId: idSchema })
  .extend(createDatabaseRowRequestSchema.shape);

export const databaseRowCreateTool: AnyToolDefinition = defineTool({
  name: 'exo_database_row_create',
  description: 'Legt eine neue Zeile in einer Datenbank an.',
  inputSchema: databaseRowCreateInputSchema,
  surfaces: ['mcp', 'ai'],
  mutating: true,
  target: (input) => `document:${input.documentId}`,
  async execute(client, input) {
    const { documentId, ...body } = input;
    const result = await client.request({
      method: 'POST',
      path: `/api/documents/${documentId}/rows`,
      body,
      responseSchema: databaseRowSchema,
    });
    return { text: `Zeile erstellt: ${result.document.title} (id: ${result.document.id})`, data: result };
  },
});

const databaseRowUpdateInputSchema = z
  .object({ rowId: idSchema })
  .extend(updateDatabaseRowValuesRequestSchema.shape);

export const databaseRowUpdateTool: AnyToolDefinition = defineTool({
  name: 'exo_database_row_update',
  description: 'Aktualisiert einzelne Spaltenwerte einer Zeile.',
  inputSchema: databaseRowUpdateInputSchema,
  surfaces: ['mcp', 'ai'],
  mutating: true,
  target: (input) => `document:${input.rowId}`,
  async execute(client, input) {
    const { rowId, ...body } = input;
    const result = await client.request({
      method: 'PATCH',
      path: `/api/documents/${rowId}/values`,
      body,
      responseSchema: databaseRowSchema,
    });
    return { text: `Zeile aktualisiert: ${result.document.title} (id: ${result.document.id})`, data: result };
  },
});

export const DATABASE_TOOLS: readonly AnyToolDefinition[] = [
  databaseCreateTool,
  databaseSchemaTool,
  databasePropertyCreateTool,
  databasePropertyUpdateTool,
  databasePropertyDeleteTool,
  databaseOptionCreateTool,
  databaseViewCreateTool,
  databaseViewUpdateTool,
  databaseViewDeleteTool,
  databaseQueryTool,
  databaseRowCreateTool,
  databaseRowUpdateTool,
];
