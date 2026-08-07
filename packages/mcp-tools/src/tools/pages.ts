import { z } from 'zod';

import {
  aiRuleModeSchema,
  coverPositionSchema,
  DOCUMENT_ICON_COLORS,
  DOCUMENT_ICON_NAMES,
  documentContentWriteRequestSchema,
  documentContentWriteResponseSchema,
  documentIconColorSchema,
  documentIconSchema,
  documentLayoutSchema,
  documentSnapshotListResponseSchema,
  type DocumentSummary,
  documentSummarySchema,
  documentTitleSchema,
  documentTreeResponseSchema,
  documentTypeSchema,
  generateDocumentCoverResponseSchema,
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

/**
 * Built from the contract rather than written out, so a name added to the
 * curated set reaches the model in the same commit that adds it. Without the
 * list a caller can only guess, and every guess outside the set is rejected.
 */
const ICON_DESCRIPTION =
  'Symbol der Seite: entweder ein Emoji als Zeichen ("🧠") oder ein gezeichnetes Symbol ' +
  `als "lucide:<name>". Erlaubte Namen: ${DOCUMENT_ICON_NAMES.join(', ')}. ` +
  'null entfernt das Symbol.';

const ICON_COLOR_DESCRIPTION =
  `Farbe eines gezeichneten Symbols: ${DOCUMENT_ICON_COLORS.join(', ')}. ` +
  'Wirkt nur auf "lucide:"-Symbole, ein Emoji bringt seine eigenen Farben mit. ' +
  'null bedeutet die Standardfarbe.';

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
  icon: documentIconSchema.describe(ICON_DESCRIPTION),
  iconColor: documentIconColorSchema.describe(ICON_COLOR_DESCRIPTION),
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
        iconColor: input.iconColor,
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
    'abgeschnitten werden und wird dann gar nicht ausgeführt. ' +
    'Hat jemand die Seite gerade geöffnet, erscheint die Änderung dort sofort.',
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
    const liveText = result.appliedToLiveSession
      ? ' Die Seite war geöffnet; die Änderung ist dort sofort sichtbar.'
      : '';
    return {
      text: `Seite ${documentId} geschrieben (Snapshot ${result.snapshotId} zum Zurückrollen).${liveText}${warningsText}`,
      data: result,
    };
  },
});

const pageRenameInputSchema = z.object({
  documentId: idSchema,
  title: documentTitleSchema.optional(),
  icon: documentIconSchema.describe(ICON_DESCRIPTION),
  iconColor: documentIconColorSchema.describe(ICON_COLOR_DESCRIPTION),
});

export const pageRenameTool: AnyToolDefinition = defineTool({
  name: 'exo_page_rename',
  description: 'Benennt eine Seite um und/oder ändert ihr Symbol und dessen Farbe.',
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

export const pageSetLayoutTool: AnyToolDefinition = defineTool({
  name: 'exo_page_set_layout',
  description:
    'Setzt die Breite des Seitenkörpers: "narrow" (Lesebreite), "wide" (Text mit Tabellen) oder "full" (volle Breite, sinnvoll für Datenbanken).',
  inputSchema: z.object({ documentId: idSchema, layout: documentLayoutSchema }),
  surfaces: ['mcp', 'ai'],
  mutating: true,
  target: (input) => `document:${input.documentId}`,
  async execute(client, input) {
    const result = await client.request({
      method: 'PATCH',
      path: `/api/documents/${input.documentId}`,
      body: { layout: input.layout },
      responseSchema: documentSummarySchema,
    });
    return { text: `Layout auf ${input.layout} gesetzt: ${formatDocumentSummary(result)}`, data: result };
  },
});

const pageSetCoverInputSchema = z.object({
  documentId: idSchema,
  /**
   * An image attachment of the same workspace — upload one with
   * `exo_attachment_upload` first — or `null` to remove the cover.
   */
  attachmentId: idSchema.nullable(),
  position: coverPositionSchema.optional(),
});

export const pageSetCoverTool: AnyToolDefinition = defineTool({
  name: 'exo_page_set_cover',
  description:
    'Setzt das Titelbild einer Seite oder entfernt es (attachmentId null). Das Bild muss ein ' +
    'Bild-Anhang desselben Workspace sein, hochzuladen mit exo_attachment_upload. ' +
    'position ist der senkrechte Bildausschnitt in Prozent: 0 zeigt die Oberkante, 100 die ' +
    'Unterkante, 50 die Mitte.',
  inputSchema: pageSetCoverInputSchema,
  surfaces: ['mcp', 'ai'],
  mutating: true,
  target: (input) => `document:${input.documentId}`,
  async execute(client, input) {
    const result = await client.request({
      method: 'PATCH',
      path: `/api/documents/${input.documentId}`,
      body: {
        coverAttachmentId: input.attachmentId,
        // Removing the cover leaves the crop alone: it means nothing without an
        // image, and the next one starts in the middle anyway.
        ...(input.attachmentId === null || input.position === undefined
          ? {}
          : { coverPosition: input.position }),
      },
      responseSchema: documentSummarySchema,
    });
    const text =
      input.attachmentId === null
        ? `Titelbild entfernt: ${formatDocumentSummary(result)}`
        : `Titelbild gesetzt: ${formatDocumentSummary(result)}`;
    return { text, data: result };
  },
});

const pageGenerateCoverInputSchema = z.object({
  documentId: idSchema,
  /** What to draw, in the user's own words. Any language. */
  prompt: z.string().trim().min(3).max(1_000),
});

export const pageGenerateCoverTool: AnyToolDefinition = defineTool({
  name: 'exo_page_generate_cover',
  description:
    'Lässt die KI ein Titelbild für eine Seite malen und setzt es. Das Bild entsteht im ' +
    'Hintergrund und ist nicht sofort fertig: der Aufruf bestätigt nur den Auftrag. ' +
    'Braucht ein eingerichtetes Bildmodell, sonst antwortet die API mit ai_image_unavailable.',
  inputSchema: pageGenerateCoverInputSchema,
  surfaces: ['mcp', 'ai'],
  mutating: true,
  target: (input) => `document:${input.documentId}`,
  async execute(client, input) {
    const result = await client.request({
      method: 'POST',
      path: `/api/documents/${input.documentId}/cover/generate`,
      body: { prompt: input.prompt },
      responseSchema: generateDocumentCoverResponseSchema,
    });
    return {
      text: `Titelbild wird erzeugt für Seite ${result.documentId}. Es erscheint, sobald es fertig ist.`,
      data: result,
    };
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
  pageSetLayoutTool,
  pageSetCoverTool,
  pageGenerateCoverTool,
];
