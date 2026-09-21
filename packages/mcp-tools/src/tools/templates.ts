import { z } from 'zod';

import {
  createTemplateRequestSchema,
  deleteTemplateResponseSchema,
  idSchema,
  instantiateTemplateRequestSchema,
  instantiateTemplateResponseSchema,
  TEMPLATE_TITLE_PLACEHOLDERS,
  templateListResponseSchema,
  templateResponseSchema,
  updateTemplateRequestSchema,
} from '@exocortex/contracts';

import { type AnyToolDefinition, defineTool } from '../tool.js';

import { formatDocumentSummary } from './page-render.js';

/**
 * Page templates (issue #79, ADR-039).
 *
 * Every tool here addresses a template by `documentId`, because a template is
 * a page and has no id of its own. The descriptions say so: a model that
 * believes there is a template object will go looking for a list of ids that
 * does not exist.
 */

const PLACEHOLDER_HELP = Object.entries(TEMPLATE_TITLE_PLACEHOLDERS)
  .map(([name, meaning]) => `{{${name}}} = ${meaning}`)
  .join('; ');

export const templateListTool: AnyToolDefinition = defineTool({
  name: 'exo_template_list',
  description:
    'Listet die Seitenvorlagen eines Arbeitsbereichs, zuletzt benutzte zuerst. Eine Vorlage ist ' +
    'eine gewöhnliche Seite, die als Vorlage markiert wurde; ihre documentId ist die einzige Id, ' +
    'die sie hat. Mit exo_template_use entsteht daraus eine neue, unabhängige Seite. Nicht zu ' +
    'verwechseln mit exo_render_template_list: das sind die Vorlagen für PDF-Ausgaben.',
  inputSchema: z.object({ workspaceId: idSchema }),
  surfaces: ['mcp', 'ai'],
  domain: 'templates',
  mutating: false,
  async execute(client, input) {
    const result = await client.request({
      method: 'GET',
      path: `/api/workspaces/${input.workspaceId}/templates`,
      responseSchema: templateListResponseSchema,
    });
    if (result.templates.length === 0) {
      return {
        text:
          'Dieser Arbeitsbereich hat keine Seitenvorlagen. Mit exo_template_create wird eine ' +
          'vorhandene Seite zu einer.',
        data: result,
      };
    }
    const lines = result.templates.map((template) => {
      const parts = [`- ${formatDocumentSummary(template.document)}`];
      if (template.description !== null) parts.push(template.description);
      if (template.titlePattern !== null) parts.push(`Titelmuster: ${template.titlePattern}`);
      if (template.targetParent !== null) {
        parts.push(`Ziel: ${template.targetParent.title} (${template.targetParent.id})`);
      }
      parts.push(`${template.useCount}× benutzt`);
      return parts.join(' · ');
    });
    return {
      text: `${result.templates.length} Vorlage(n):\n${lines.join('\n')}`,
      data: result,
    };
  },
});

export const templateCreateTool: AnyToolDefinition = defineTool({
  name: 'exo_template_create',
  description:
    'Markiert eine vorhandene Seite als Vorlage. Die Seite bleibt, wo sie ist, und bleibt eine ' +
    'gewöhnliche Seite: Inhalt, Symbol und (bei Datenbankzeilen) Eigenschaften werden später ' +
    'kopiert. Zuerst also die Seite mit exo_page_create und exo_page_write bauen, dann hier ' +
    `markieren. Im Titelmuster erlaubt: ${PLACEHOLDER_HELP}.`,
  inputSchema: z.object({ workspaceId: idSchema }).extend(createTemplateRequestSchema.shape),
  surfaces: ['mcp', 'ai'],
  domain: 'templates',
  mutating: true,
  target: (input) => `document:${input.documentId}`,
  async execute(client, input) {
    const { workspaceId, ...body } = input;
    const result = await client.request({
      method: 'POST',
      path: `/api/workspaces/${workspaceId}/templates`,
      body,
      responseSchema: templateResponseSchema,
    });
    return {
      text:
        `"${result.template.document.title}" ist jetzt eine Vorlage ` +
        `(documentId: ${result.template.document.id}). Benutzen mit exo_template_use.`,
      data: result,
    };
  },
});

export const templateUpdateTool: AnyToolDefinition = defineTool({
  name: 'exo_template_update',
  description:
    'Ändert Beschreibung, Titelmuster oder Zielort einer Vorlage. Nur die mitgegebenen Felder ' +
    'werden geändert; null löscht eines. Der Inhalt der Vorlage wird wie bei jeder Seite mit ' +
    'exo_page_write bearbeitet.',
  inputSchema: z.object({ documentId: idSchema }).extend(updateTemplateRequestSchema.shape),
  surfaces: ['mcp', 'ai'],
  domain: 'templates',
  mutating: true,
  target: (input) => `document:${input.documentId}`,
  async execute(client, input) {
    const { documentId, ...body } = input;
    const result = await client.request({
      method: 'PATCH',
      path: `/api/templates/${documentId}`,
      body,
      responseSchema: templateResponseSchema,
    });
    return { text: `Vorlage "${result.template.document.title}" geändert.`, data: result };
  },
});

export const templateDeleteTool: AnyToolDefinition = defineTool({
  name: 'exo_template_delete',
  description:
    'Hebt die Markierung als Vorlage wieder auf. Die Seite selbst bleibt unverändert bestehen; ' +
    'soll auch sie weg, danach exo_page_trash.',
  inputSchema: z.object({ documentId: idSchema }),
  surfaces: ['mcp', 'ai'],
  domain: 'templates',
  mutating: true,
  target: (input) => `document:${input.documentId}`,
  async execute(client, input) {
    const result = await client.request({
      method: 'DELETE',
      path: `/api/templates/${input.documentId}`,
      responseSchema: deleteTemplateResponseSchema,
    });
    return {
      text: 'Die Seite ist keine Vorlage mehr. Sie selbst ist unverändert vorhanden.',
      data: result,
    };
  },
});

export const templateUseTool: AnyToolDefinition = defineTool({
  name: 'exo_template_use',
  description:
    'Legt eine neue Seite aus einer Vorlage an: Inhalt, Symbol, Titelbild und, innerhalb ' +
    'derselben Datenbank, die Eigenschaften werden kopiert. Danach gibt es keine Verbindung ' +
    'mehr zur Vorlage, die neue Seite ist eine gewöhnliche Seite. Ohne parentId landet sie am ' +
    'hinterlegten Zielort der Vorlage, sonst auf oberster Ebene.',
  inputSchema: z
    .object({ documentId: idSchema })
    .extend(instantiateTemplateRequestSchema.shape)
    .describe('documentId ist die Vorlage, parentId der Ort für die neue Seite.'),
  surfaces: ['mcp', 'ai'],
  domain: 'templates',
  mutating: true,
  target: (input) => `document:${input.documentId}`,
  async execute(client, input) {
    const { documentId, ...body } = input;
    const result = await client.request({
      method: 'POST',
      path: `/api/templates/${documentId}/pages`,
      body,
      responseSchema: instantiateTemplateResponseSchema,
    });
    const where =
      result.parent === null
        ? 'auf oberster Ebene'
        : `unter "${result.parent.title}" (parentId: ${result.parent.id})`;
    const properties =
      result.copiedProperties > 0 ? ` ${result.copiedProperties} Eigenschaft(en) übernommen.` : '';
    const warnings = result.warnings.length > 0 ? `\nHinweis: ${result.warnings.join(' ')}` : '';
    return {
      text: `Aus der Vorlage angelegt ${where}: ${formatDocumentSummary(result.document)}.${properties}${warnings}`,
      data: result,
    };
  },
});

export const TEMPLATE_TOOLS: readonly AnyToolDefinition[] = [
  templateListTool,
  templateCreateTool,
  templateUpdateTool,
  templateDeleteTool,
  templateUseTool,
];
