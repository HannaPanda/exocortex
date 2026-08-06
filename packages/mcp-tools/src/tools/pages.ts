import { z } from 'zod';

import {
  aiRuleModeSchema,
  documentContentWriteRequestSchema,
  documentContentWriteResponseSchema,
  documentIconSchema,
  documentSnapshotListResponseSchema,
  type DocumentSummary,
  documentSummarySchema,
  documentTitleSchema,
  documentTreeResponseSchema,
  documentTypeSchema,
  idSchema,
  markdownExportResponseSchema,
  type markdownImportRequestSchema,
  markdownImportResponseSchema,
  moveDocumentRequestSchema,
} from '@exocortex/contracts';

import { truncateText } from '../format.js';
import { restoreSnapshotResultSchema } from '../local-schemas.js';
import { type AnyToolDefinition, defineTool } from '../tool.js';

const MAX_PAGE_READ_CHARS = 60_000;

function formatDocumentSummary(document: DocumentSummary): string {
  return `${document.title} (id: ${document.id}, type: ${document.type})`;
}

export const pageTreeTool: AnyToolDefinition = defineTool({
  name: 'exo_page_tree',
  description: 'Liest die Seitenhierarchie eines Workspace als Baum, inklusive archivierter Seiten.',
  inputSchema: z.object({ workspaceId: idSchema }),
  surfaces: ['mcp', 'ai'],
  mutating: false,
  async execute(client, input) {
    const result = await client.request({
      method: 'GET',
      path: `/api/workspaces/${input.workspaceId}/documents/tree`,
      responseSchema: documentTreeResponseSchema,
    });
    return { text: `${result.nodes.length} Wurzelseiten, ${result.archived.length} archivierte Seiten.`, data: result };
  },
});

export const pageReadTool: AnyToolDefinition = defineTool({
  name: 'exo_page_read',
  description: 'Exportiert den Inhalt einer Seite als Markdown.',
  inputSchema: z.object({ documentId: idSchema }),
  surfaces: ['mcp', 'ai'],
  mutating: false,
  async execute(client, input) {
    const result = await client.request({
      method: 'GET',
      path: `/api/documents/${input.documentId}/export/markdown`,
      responseSchema: markdownExportResponseSchema,
    });
    const { text } = truncateText(result.markdown, MAX_PAGE_READ_CHARS);
    return { text, data: { ...result, fullLength: result.markdown.length } };
  },
});

const pageCreateInputSchema = z.object({
  workspaceId: idSchema,
  title: documentTitleSchema.optional(),
  parentId: idSchema.nullable().optional(),
  type: documentTypeSchema.default('PAGE'),
  icon: documentIconSchema,
  /** When given, the page is created from Markdown via the import path. */
  markdown: z.string().min(1).max(2_000_000).optional(),
});

export const pageCreateTool: AnyToolDefinition = defineTool({
  name: 'exo_page_create',
  description: 'Legt eine neue Seite in einem Workspace an, optional mit initialem Markdown-Inhalt.',
  inputSchema: pageCreateInputSchema,
  surfaces: ['mcp', 'ai'],
  mutating: true,
  target: (input) => `workspace:${input.workspaceId}`,
  async execute(client, input) {
    if (input.markdown !== undefined) {
      const result = await client.request({
        method: 'POST',
        path: `/api/workspaces/${input.workspaceId}/import/markdown`,
        body: {
          markdown: input.markdown,
          parentId: input.parentId,
          title: input.title,
        } satisfies z.infer<typeof markdownImportRequestSchema>,
        responseSchema: markdownImportResponseSchema,
      });
      return {
        text: `Seite erstellt: ${formatDocumentSummary(result.document)}`,
        data: result,
      };
    }

    const result = await client.request({
      method: 'POST',
      path: `/api/workspaces/${input.workspaceId}/documents`,
      body: {
        title: input.title,
        parentId: input.parentId,
        type: input.type,
        icon: input.icon,
      },
      responseSchema: documentSummarySchema,
    });
    return { text: `Seite erstellt: ${formatDocumentSummary(result)}`, data: result };
  },
});

export const pageWriteTool: AnyToolDefinition = defineTool({
  name: 'exo_page_write',
  description:
    'Schreibt Markdown in eine bestehende Seite (ersetzen, anhängen oder voranstellen). ' +
    'Der bisherige Zustand wird vorher als Snapshot gesichert und kann mit exo_page_snapshots ' +
    'und exo_page_restore_snapshot wiederhergestellt werden. ' +
    'Lange Inhalte in mehreren Aufrufen schreiben: den ersten mit mode "replace", die weiteren ' +
    'mit mode "append". Ein einzelner Aufruf mit sehr viel Markdown kann am Ausgabelimit ' +
    'abgeschnitten werden und wird dann gar nicht ausgeführt.',
  inputSchema: z.object({ documentId: idSchema }).extend(documentContentWriteRequestSchema.shape),
  surfaces: ['mcp', 'ai'],
  mutating: true,
  target: (input) => `document:${input.documentId}`,
  async execute(client, input) {
    const { documentId, ...body } = input;
    const result = await client.request({
      method: 'POST',
      path: `/api/documents/${documentId}/content`,
      body,
      responseSchema: documentContentWriteResponseSchema,
    });
    const warningsText = result.warnings.length > 0 ? ` Warnungen: ${result.warnings.join('; ')}` : '';
    return {
      text: `Seite ${documentId} geschrieben (Snapshot ${result.snapshotId} zum Zurückrollen).${warningsText}`,
      data: result,
    };
  },
});

const pageRenameInputSchema = z.object({
  documentId: idSchema,
  title: documentTitleSchema.optional(),
  icon: documentIconSchema,
});

export const pageRenameTool: AnyToolDefinition = defineTool({
  name: 'exo_page_rename',
  description: 'Benennt eine Seite um und/oder ändert ihr Icon.',
  inputSchema: pageRenameInputSchema,
  surfaces: ['mcp', 'ai'],
  mutating: true,
  target: (input) => `document:${input.documentId}`,
  async execute(client, input) {
    const { documentId, ...body } = input;
    const result = await client.request({
      method: 'PATCH',
      path: `/api/documents/${documentId}`,
      body,
      responseSchema: documentSummarySchema,
    });
    return { text: `Seite umbenannt: ${formatDocumentSummary(result)}`, data: result };
  },
});

export const pageMoveTool: AnyToolDefinition = defineTool({
  name: 'exo_page_move',
  description: 'Verschiebt eine Seite zu einem neuen übergeordneten Element oder einer neuen Position.',
  inputSchema: z.object({ documentId: idSchema }).extend(moveDocumentRequestSchema.shape),
  surfaces: ['mcp', 'ai'],
  mutating: true,
  target: (input) => `document:${input.documentId}`,
  async execute(client, input) {
    const { documentId, ...body } = input;
    const result = await client.request({
      method: 'POST',
      path: `/api/documents/${documentId}/move`,
      body,
      responseSchema: documentSummarySchema,
    });
    return { text: `Seite verschoben: ${formatDocumentSummary(result)}`, data: result };
  },
});

export const pageArchiveTool: AnyToolDefinition = defineTool({
  name: 'exo_page_archive',
  description: 'Verschiebt eine Seite in den Papierkorb (archivieren).',
  inputSchema: z.object({ documentId: idSchema }),
  surfaces: ['mcp', 'ai'],
  mutating: true,
  target: (input) => `document:${input.documentId}`,
  async execute(client, input) {
    const result = await client.request({
      method: 'POST',
      path: `/api/documents/${input.documentId}/archive`,
      responseSchema: documentSummarySchema,
    });
    return { text: `Seite archiviert: ${formatDocumentSummary(result)}`, data: result };
  },
});

export const pageRestoreTool: AnyToolDefinition = defineTool({
  name: 'exo_page_restore',
  description: 'Stellt eine archivierte Seite aus dem Papierkorb wieder her.',
  inputSchema: z.object({ documentId: idSchema }),
  surfaces: ['mcp', 'ai'],
  mutating: true,
  target: (input) => `document:${input.documentId}`,
  async execute(client, input) {
    const result = await client.request({
      method: 'POST',
      path: `/api/documents/${input.documentId}/restore`,
      responseSchema: documentSummarySchema,
    });
    return { text: `Seite wiederhergestellt: ${formatDocumentSummary(result)}`, data: result };
  },
});

export const pageSnapshotsTool: AnyToolDefinition = defineTool({
  name: 'exo_page_snapshots',
  description: 'Listet die gespeicherten Snapshots einer Seite (für Wiederherstellung nach einem Schreibvorgang).',
  inputSchema: z.object({ documentId: idSchema }),
  surfaces: ['mcp', 'ai'],
  mutating: false,
  async execute(client, input) {
    const result = await client.request({
      method: 'GET',
      path: `/api/documents/${input.documentId}/snapshots`,
      responseSchema: documentSnapshotListResponseSchema,
    });
    if (result.snapshots.length === 0) {
      return { text: 'Keine Snapshots vorhanden.', data: result };
    }
    const text = result.snapshots
      .map((snapshot, i) => `${i + 1}. ${snapshot.id} (${snapshot.reason}, ${snapshot.createdAt})`)
      .join('\n');
    return { text, data: result };
  },
});

export const pageRestoreSnapshotTool: AnyToolDefinition = defineTool({
  name: 'exo_page_restore_snapshot',
  description: 'Stellt eine Seite auf den Stand eines früheren Snapshots zurück.',
  inputSchema: z.object({ documentId: idSchema, snapshotId: idSchema }),
  surfaces: ['mcp', 'ai'],
  mutating: true,
  target: (input) => `document:${input.documentId}`,
  async execute(client, input) {
    const result = await client.request({
      method: 'POST',
      path: `/api/documents/${input.documentId}/snapshots/${input.snapshotId}/restore`,
      responseSchema: restoreSnapshotResultSchema,
    });
    return { text: `Seite ${result.documentId} auf Snapshot ${result.restoredFrom} zurückgesetzt.`, data: result };
  },
});

const pageSetAiRuleInputSchema = z.object({
  documentId: idSchema,
  aiRuleMode: aiRuleModeSchema,
  aiRuleTrigger: z.string().trim().max(300).nullable().optional(),
  aiRulePriority: z.number().int().optional(),
});

export const pageSetAiRuleTool: AnyToolDefinition = defineTool({
  name: 'exo_page_set_ai_rule',
  description:
    'Markiert eine Seite als KI-Regelseite (immer aktiv oder auf Anfrage geladen) oder hebt diese Markierung auf.',
  inputSchema: pageSetAiRuleInputSchema,
  surfaces: ['mcp', 'ai'],
  mutating: true,
  target: (input) => `document:${input.documentId}`,
  async execute(client, input) {
    const { documentId, ...body } = input;
    const result = await client.request({
      method: 'PATCH',
      path: `/api/documents/${documentId}`,
      body,
      responseSchema: documentSummarySchema,
    });
    return { text: `KI-Regel aktualisiert für: ${formatDocumentSummary(result)}`, data: result };
  },
});

export const PAGE_TOOLS: readonly AnyToolDefinition[] = [
  pageTreeTool,
  pageReadTool,
  pageCreateTool,
  pageWriteTool,
  pageRenameTool,
  pageMoveTool,
  pageArchiveTool,
  pageRestoreTool,
  pageSnapshotsTool,
  pageRestoreSnapshotTool,
  pageSetAiRuleTool,
];
