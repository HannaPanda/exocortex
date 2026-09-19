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
  type DatabaseRowPropertyValue,
  databaseRowSchema,
  databaseViewSchema,
  documentDetailSchema,
  documentIconColorSchema,
  documentIconSchema,
  type DocumentRowResponse,
  documentRowResponseSchema,
  documentSummarySchema,
  documentTitleSchema,
  idSchema,
  IMPLEMENTED_PROPERTY_TYPES,
  queryDatabaseRowsRequestSchema,
  queryDatabaseRowsResponseSchema,
  reorderDatabasePropertyRequestSchema,
  reorderDatabaseViewRequestSchema,
  updateDatabasePropertyOptionRequestSchema,
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

import { ICON_COLOR_DESCRIPTION, ICON_DESCRIPTION } from './pages.js';

/**
 * Every property type the query engine and the property-write endpoint
 * implement. Built from `IMPLEMENTED_PROPERTY_TYPES` rather than from the
 * enum, so a type reserved in the contract can never be offered to a model as
 * something it can create.
 */
const implementedPropertyTypeSchema = z.enum(
  IMPLEMENTED_PROPERTY_TYPES as unknown as readonly [
    DatabasePropertyType,
    ...DatabasePropertyType[],
  ],
);

/**
 * What the three linked types need in `config`, written out because a model
 * cannot guess the shape from the type name and a wrong bag is a refused call.
 */
const PROPERTY_CONFIG_DESCRIPTION = [
  'Typabhängige Konfiguration.',
  'RELATION: { "targetCollectionId": "<id der Ziel-Datenbank>", "allowMultiple": true }.',
  'ROLLUP: { "relationPropertyId": "<id der Verknüpfungsspalte>", "targetPropertyId": "<id einer Spalte der Ziel-Datenbank oder null>", "aggregate": "count|count_unique|count_not_empty|sum|average|min|max|earliest|latest" }.',
  "FORMULA: { \"expression\": \"if(prop('Menge') > 0; prop('Preis') * prop('Menge'); 0)\" }.",
  'DATE: { "includeTime": false, "isRange": false, "timeZone": null }.',
  'Bei allen anderen Typen weglassen.',
].join(' ');

const propertyConfigSchema = z
  .record(z.string(), z.unknown())
  .nullable()
  .optional()
  .describe(PROPERTY_CONFIG_DESCRIPTION);

const createDatabaseRequestPropertySchema = z.object({
  type: implementedPropertyTypeSchema,
  name: z.string().trim().min(1).max(100),
  config: propertyConfigSchema,
});

const databaseCreateInputSchema = z.object({
  workspaceId: idSchema,
  title: documentTitleSchema.optional(),
  parentId: idSchema.nullable().optional(),
  /**
   * A database carries a symbol like any other page. It is here because
   * `exo_page_create` stopped taking a `type` (issue #41): a caller that used
   * to reach a database through that tool would otherwise have lost the symbol
   * on the way over, and would need a second call to `exo_page_rename` to put
   * it back.
   */
  icon: documentIconSchema.describe(ICON_DESCRIPTION),
  iconColor: documentIconColorSchema.describe(ICON_COLOR_DESCRIPTION),
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
      body: {
        title: input.title,
        parentId: input.parentId,
        type: 'COLLECTION',
        icon: input.icon,
        iconColor: input.iconColor,
      },
      responseSchema: documentSummarySchema,
    });

    const properties: DatabaseProperty[] = [];
    for (const property of input.properties) {
      const created = await client.request({
        method: 'POST',
        path: `/api/documents/${document.id}/properties`,
        body: { type: property.type, name: property.name, config: property.config },
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
  description: 'Liest Zeilenanzahl, Spalten und Ansichten einer Datenbank.',
  inputSchema: z.object({ documentId: idSchema }),
  surfaces: ['mcp', 'ai'],
  mutating: false,
  async execute(client, input) {
    const [detail, properties, views] = await Promise.all([
      client.request({
        method: 'GET',
        path: `/api/documents/${input.documentId}`,
        responseSchema: documentDetailSchema,
      }),
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
      `Zeilen: ${detail.rowCount ?? 0}`,
      `Spalten (${properties.properties.length}):`,
      ...propertyLines,
      `Ansichten (${views.views.length}):`,
      ...viewLines,
    ].join('\n');
    return {
      text,
      data: { rowCount: detail.rowCount, properties: properties.properties, views: views.views },
    };
  },
});

const databasePropertyCreateInputSchema = z
  .object({ documentId: idSchema })
  .extend(createDatabasePropertyRequestSchema.shape)
  .extend({ type: implementedPropertyTypeSchema, config: propertyConfigSchema });

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
    return {
      text: `Spalte erstellt: ${result.name} (${result.type}, id: ${result.id})`,
      data: result,
    };
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
  .extend({ config: propertyConfigSchema })
  .refine((value) => value.name !== undefined || value.config !== undefined, {
    message: 'At least one of "name" or "config" must be provided',
  });

export const databasePropertyUpdateTool: AnyToolDefinition = defineTool({
  name: 'exo_database_property_update',
  description: 'Ändert Name oder Konfiguration einer Datenbankspalte.',
  inputSchema: databasePropertyUpdateInputSchema,
  surfaces: ['mcp', 'ai'],
  mutating: true,
  destructive: true,
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
  description:
    'Löscht eine Datenbankspalte unwiderruflich, inklusive aller darin gespeicherten Werte.',
  inputSchema: z.object({ documentId: idSchema, propertyId: idSchema }),
  surfaces: ['mcp', 'ai'],
  mutating: true,
  destructive: true,
  irreversible: true,
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

/** See the comment on `databasePropertyUpdateInputSchema` about re-applying the refine. */
const databaseOptionUpdateInputSchema = z
  .object({ documentId: idSchema, propertyId: idSchema, optionId: idSchema })
  .extend(updateDatabasePropertyOptionRequestSchema.shape)
  .refine((value) => value.label !== undefined || value.color !== undefined, {
    message: 'At least one of "label" or "color" must be provided',
  });

export const databaseOptionUpdateTool: AnyToolDefinition = defineTool({
  name: 'exo_database_option_update',
  description:
    'Benennt eine Option einer Auswahl-Spalte um oder färbt sie neu. Zeilen, die die Option ' +
    'gesetzt haben, behalten sie: die Option bleibt dieselbe, nur ihre Beschriftung ändert sich.',
  inputSchema: databaseOptionUpdateInputSchema,
  surfaces: ['mcp', 'ai'],
  mutating: true,
  destructive: true,
  target: (input) => `document:${input.documentId}`,
  async execute(client, input) {
    const { documentId, propertyId, optionId, ...body } = input;
    const result = await client.request({
      method: 'PATCH',
      path: `/api/documents/${documentId}/properties/${propertyId}/options/${optionId}`,
      body,
      responseSchema: databasePropertyOptionSchema,
    });
    return { text: `Option aktualisiert: ${result.label} (id: ${result.id})`, data: result };
  },
});

export const databaseOptionDeleteTool: AnyToolDefinition = defineTool({
  name: 'exo_database_option_delete',
  description:
    'Entfernt eine Option aus einer Auswahl-Spalte. Zeilen, die sie gesetzt hatten, verlieren ' +
    'den Wert. Vorher exo_database_schema lesen, um zu sehen, welche Option gemeint ist.',
  inputSchema: z.object({ documentId: idSchema, propertyId: idSchema, optionId: idSchema }),
  surfaces: ['mcp', 'ai'],
  mutating: true,
  destructive: true,
  // Same standing as deleting the column it belongs to. Creating the option
  // again gives it a new id, so the rows that pointed at the old one stay empty;
  // a document snapshot holds the page's Yjs state and not these rows, so there
  // is nothing that brings the values back.
  irreversible: true,
  target: (input) => `document:${input.documentId}`,
  async execute(client, input) {
    const result = await client.request({
      method: 'DELETE',
      path: `/api/documents/${input.documentId}/properties/${input.propertyId}/options/${input.optionId}`,
      responseSchema: deletedResultSchema,
    });
    return { text: `Option ${input.optionId} entfernt.`, data: result };
  },
});

/**
 * Moving a column, which the browser does by dragging its header.
 *
 * The gesture is not the capability (ADR-025): what a person does with the
 * mouse, an agent has to be able to do with a call, and the position of a
 * column is part of how a database reads.
 */
const databasePropertyReorderInputSchema = z
  .object({ documentId: idSchema, propertyId: idSchema })
  .extend(reorderDatabasePropertyRequestSchema.shape);

export const databasePropertyReorderTool: AnyToolDefinition = defineTool({
  name: 'exo_database_property_reorder',
  description:
    'Verschiebt eine Spalte an eine andere Stelle. afterPropertyId ist die Spalte, hinter die ' +
    'sie rutscht, oder null für ganz nach vorne; beforePropertyId ist optional und macht die ' +
    'Position eindeutig, wenn parallel jemand anders sortiert.',
  inputSchema: databasePropertyReorderInputSchema,
  surfaces: ['mcp', 'ai'],
  mutating: true,
  target: (input) => `document:${input.documentId}`,
  async execute(client, input) {
    const { documentId, propertyId, ...body } = input;
    const result = await client.request({
      method: 'POST',
      path: `/api/documents/${documentId}/properties/${propertyId}/reorder`,
      body,
      responseSchema: databasePropertySchema,
    });
    return { text: `Spalte verschoben: ${result.name} (id: ${result.id})`, data: result };
  },
});

const databaseViewCreateInputSchema = z
  .object({ documentId: idSchema })
  .extend(createDatabaseViewRequestSchema.shape);

export const databaseViewCreateTool: AnyToolDefinition = defineTool({
  name: 'exo_database_view_create',
  description:
    'Legt eine neue Ansicht (Tabelle, Board, Galerie oder Kalender) für eine Datenbank an.',
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
    return {
      text: `Ansicht erstellt: ${result.name} (${result.type}, id: ${result.id})`,
      data: result,
    };
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
  destructive: true,
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

const databaseViewReorderInputSchema = z
  .object({ documentId: idSchema, viewId: idSchema })
  .extend(reorderDatabaseViewRequestSchema.shape);

export const databaseViewReorderTool: AnyToolDefinition = defineTool({
  name: 'exo_database_view_reorder',
  description:
    'Verschiebt eine Ansicht in der Leiste über der Datenbank. afterViewId ist die Ansicht, ' +
    'hinter die sie rutscht, oder null für ganz nach vorne. Die erste Ansicht ist die, die ' +
    'beim Öffnen der Datenbank gezeigt wird.',
  inputSchema: databaseViewReorderInputSchema,
  surfaces: ['mcp', 'ai'],
  mutating: true,
  target: (input) => `document:${input.documentId}`,
  async execute(client, input) {
    const { documentId, viewId, ...body } = input;
    const result = await client.request({
      method: 'POST',
      path: `/api/documents/${documentId}/views/${viewId}/reorder`,
      body,
      responseSchema: databaseViewSchema,
    });
    return { text: `Ansicht verschoben: ${result.name} (id: ${result.id})`, data: result };
  },
});

export const databaseViewDeleteTool: AnyToolDefinition = defineTool({
  name: 'exo_database_view_delete',
  description: 'Löscht eine Ansicht einer Datenbank.',
  inputSchema: z.object({ documentId: idSchema, viewId: idSchema }),
  surfaces: ['mcp', 'ai'],
  mutating: true,
  destructive: true,
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

/**
 * One cell as table text. A date span is an object, so `String()` alone would
 * put "[object Object]" in front of the model where an appointment belongs.
 */
function formatCell(value: DatabaseRowPropertyValue['value']): string {
  if (value === null) return '';
  if (typeof value === 'object' && !Array.isArray(value) && 'start' in value) {
    return value.end === null ? value.start : `${value.start} bis ${value.end}`;
  }
  return String(value);
}

function formatRow(row: DatabaseRow): string[] {
  return [row.document.title, ...row.values.map((v) => formatCell(v.value))];
}

function propertyLabelsFor(rows: readonly DatabaseRow[]): string[] {
  return rows[0]?.values.map((v) => v.propertyId) ?? [];
}

const databaseQueryInputSchema = z
  .object({ documentId: idSchema })
  .extend(queryDatabaseRowsRequestSchema.shape);

export const databaseQueryTool: AnyToolDefinition = defineTool({
  name: 'exo_database_query',
  description:
    'Fragt Zeilen einer Datenbank ab, optional über eine gespeicherte Ansicht oder ad-hoc-Filter.',
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

const databaseRowGetInputSchema = z.object({ documentId: idSchema });

export const databaseRowGetTool: AnyToolDefinition = defineTool({
  name: 'exo_database_row_get',
  description:
    'Liest die Spaltenwerte einer Seite, falls sie eine Zeile in einer Datenbank ist (ADR-011: eine Zeile ist eine ' +
    'gewöhnliche Seite mit einer Datenbank als übergeordnetem Element). Antwortet mit row: null, wenn die Seite ' +
    'keine Zeile ist -- eine gewöhnliche Seite, eine Datenbank selbst oder eine Seite auf oberster Ebene.',
  inputSchema: databaseRowGetInputSchema,
  surfaces: ['mcp', 'ai'],
  mutating: false,
  async execute(client, input) {
    const result: DocumentRowResponse = await client.request({
      method: 'GET',
      path: `/api/documents/${input.documentId}/row`,
      responseSchema: documentRowResponseSchema,
    });
    if (result.row === null) {
      return { text: `Seite ${input.documentId} ist keine Datenbankzeile.`, data: result };
    }
    const lines = result.row.values.map(
      (value) => `- ${value.propertyId}: ${formatCell(value.value)}`,
    );
    return {
      text: `${result.row.document.title} (id: ${result.row.document.id})\n${lines.join('\n')}`,
      data: result,
    };
  },
});

const databaseRowCreateInputSchema = z
  .object({ documentId: idSchema })
  .extend(createDatabaseRowRequestSchema.shape);

export const databaseRowCreateTool: AnyToolDefinition = defineTool({
  name: 'exo_database_row_create',
  description:
    'Legt eine neue Zeile in einer Datenbank an. Ein Datumswert ist normalerweise ein ISO-String; ist die Eigenschaft ein Zeitraum (isRange), dann { start, end, allDay }.',
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
    return {
      text: `Zeile erstellt: ${result.document.title} (id: ${result.document.id})`,
      data: result,
    };
  },
});

const databaseRowUpdateInputSchema = z
  .object({ rowId: idSchema })
  .extend(updateDatabaseRowValuesRequestSchema.shape);

export const databaseRowUpdateTool: AnyToolDefinition = defineTool({
  name: 'exo_database_row_update',
  description:
    'Aktualisiert einzelne Spaltenwerte einer Zeile. Ein Datumswert ist normalerweise ein ISO-String; ist die Eigenschaft ein Zeitraum (isRange), dann { start, end, allDay }.',
  inputSchema: databaseRowUpdateInputSchema,
  surfaces: ['mcp', 'ai'],
  mutating: true,
  destructive: true,
  target: (input) => `document:${input.rowId}`,
  async execute(client, input) {
    const { rowId, ...body } = input;
    const result = await client.request({
      method: 'PATCH',
      path: `/api/documents/${rowId}/values`,
      body,
      responseSchema: databaseRowSchema,
    });
    return {
      text: `Zeile aktualisiert: ${result.document.title} (id: ${result.document.id})`,
      data: result,
    };
  },
});

export const DATABASE_TOOLS: readonly AnyToolDefinition[] = [
  databaseCreateTool,
  databaseSchemaTool,
  databasePropertyCreateTool,
  databasePropertyUpdateTool,
  databasePropertyDeleteTool,
  databasePropertyReorderTool,
  databaseOptionCreateTool,
  databaseOptionUpdateTool,
  databaseOptionDeleteTool,
  databaseViewCreateTool,
  databaseViewUpdateTool,
  databaseViewReorderTool,
  databaseViewDeleteTool,
  databaseQueryTool,
  databaseRowGetTool,
  databaseRowCreateTool,
  databaseRowUpdateTool,
];
