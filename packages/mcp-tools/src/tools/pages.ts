import { z } from 'zod';

import {
  aiRuleModeSchema,
  coverPositionSchema,
  DOCUMENT_ICON_COLORS,
  DOCUMENT_ICON_NAMES,
  documentActivityResponseSchema,
  documentContentWriteRequestSchema,
  documentContentWriteResponseSchema,
  documentIconColorSchema,
  documentIconSchema,
  documentLayoutSchema,
  documentSnapshotListResponseSchema,
  type DocumentSummary,
  documentSummarySchema,
  documentTitleSchema,
  type DocumentTreeNode,
  documentTreeResponseSchema,
  documentTypeSchema,
  generateDocumentCoverResponseSchema,
  idSchema,
  markdownExportResponseSchema,
  type markdownImportRequestSchema,
  markdownImportResponseSchema,
  moveDocumentRequestSchema,
  resolveDocumentLinkRequestSchema,
  resolveDocumentLinkResponseSchema,
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

/**
 * How many pages the tree renders before it stops counting them out.
 *
 * A workspace can hold thousands, and a tool result is not a place to put all
 * of them: the reader is a model with a context window. The Second Brain holds
 * 721 pages, so this cap is reached in practice, and what gets dropped matters
 * more than how much.
 */
const MAX_TREE_LINES = 300;

/**
 * Renders the hierarchy as indented lines, one page per line, each with the id
 * a follow-up call needs.
 *
 * This used to answer with the two counts alone and leave the pages themselves
 * in `structuredContent`. That is invisible to any client that reads the text
 * content, which is most of them: ChatGPT called this tool four times in a row,
 * learned "3 Wurzelseiten" each time, and then guessed a workspace. A tool
 * result has to carry its answer in the text.
 *
 * The cap is spent breadth-first, level by level, and only then rendered in
 * tree order. Cutting depth-first instead would spend the whole budget inside
 * whichever section happens to sort first and leave the later top-level
 * sections out entirely — a reader looking for "Technik" would conclude it does
 * not exist, which is a worse answer than an incomplete one. Losing the deepest
 * level only costs detail: every page that disappears still has a visible
 * parent to ask about.
 */
function renderTree(nodes: readonly DocumentTreeNode[]): { lines: string[]; omitted: number } {
  const total = countNodes(nodes);

  // Widen level by level for as long as the whole level fits.
  let budget = MAX_TREE_LINES;
  let maxDepth = -1;
  for (let depth = 0; ; depth += 1) {
    const width = countNodesAtDepth(nodes, depth);
    if (width === 0 || width > budget) break;
    budget -= width;
    maxDepth = depth;
  }

  // Not even the root level fits. Show as much of it as there is room for
  // rather than nothing: a truncated list of sections is still a map.
  if (maxDepth < 0) {
    const lines = nodes
      .slice(0, MAX_TREE_LINES)
      .map((node) => `- ${formatDocumentSummary(node)}`);
    return { lines, omitted: total - lines.length };
  }

  const lines: string[] = [];
  const walk = (node: DocumentTreeNode, depth: number): void => {
    if (depth > maxDepth) return;
    lines.push(`${'  '.repeat(depth)}- ${formatDocumentSummary(node)}`);
    for (const child of node.children) walk(child, depth + 1);
  };
  for (const node of nodes) walk(node, 0);

  return { lines, omitted: total - lines.length };
}

function countNodes(nodes: readonly DocumentTreeNode[]): number {
  return nodes.reduce((sum, node) => sum + 1 + countNodes(node.children), 0);
}

function countNodesAtDepth(nodes: readonly DocumentTreeNode[], depth: number): number {
  if (depth === 0) return nodes.length;
  return nodes.reduce((sum, node) => sum + countNodesAtDepth(node.children, depth - 1), 0);
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
    const { lines, omitted } = renderTree(result.nodes);
    const parts = [
      lines.length === 0 ? 'Keine Seiten vorhanden.' : lines.join('\n'),
      ...(omitted === 0
        ? []
        : [
            `… ${omitted} weitere Seite(n) auf tieferen Ebenen nicht angezeigt (gekürzt). ` +
              'Jede davon hängt unter einer der Seiten oben; frag sie über ihre Elternseite ab.',
          ]),
      // Archived pages stay out of the tree and behind a count: they are not
      // somewhere to file a new page, and listing them invites writing into
      // the trash.
      ...(result.archived.length === 0
        ? []
        : [
            `\n${result.archived.length} archivierte Seite(n), nicht aufgelistet. ` +
              'exo_page_restore holt eine davon zurück.',
          ]),
    ];
    return { text: parts.join('\n'), data: result };
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

const WRITE_MODE_DESCRIPTION =
  'Was mit dem bisherigen Seiteninhalt passiert. ' +
  '"append" hängt hinten an und lässt alles Bestehende stehen: der Normalfall, wenn du etwas ' +
  'ergänzen willst. "prepend" stellt voran, ebenfalls ohne Verlust. ' +
  '"replace" löscht den kompletten bisherigen Inhalt und ersetzt ihn durch dein Markdown; ' +
  'schick dort immer den vollständigen neuen Seitentext, nie nur den neuen Abschnitt. ' +
  'Fehlt das Feld, gilt "replace", die Seite wird also überschrieben.';

const WRITE_MARKDOWN_DESCRIPTION =
  'Der zu schreibende Markdown-Text. Bei mode "append" oder "prepend" nur der neue Abschnitt, ' +
  'bei mode "replace" der gesamte Inhalt, den die Seite danach haben soll. ' +
  'Seitenlinks als [[Seitentitel]] schreiben: Exocortex bindet sie beim Schreiben an die Seite ' +
  'mit diesem Titel, sodass der Verweis ein späteres Umbenennen dieser Seite übersteht. ' +
  'Ein Titel, den es noch nicht gibt, bleibt als unaufgelöster Verweis stehen und bietet in ' +
  'der Oberfläche an, die Seite anzulegen.';

const pageWriteInputSchema = z
  .object({ documentId: idSchema })
  .extend(documentContentWriteRequestSchema.shape)
  .extend({
    markdown: documentContentWriteRequestSchema.shape.markdown.describe(WRITE_MARKDOWN_DESCRIPTION),
    mode: documentContentWriteRequestSchema.shape.mode.describe(WRITE_MODE_DESCRIPTION),
  });

export const pageWriteTool: AnyToolDefinition = defineTool({
  name: 'exo_page_write',
  description:
    'Schreibt Markdown in eine bestehende Seite. Der Modus entscheidet über den bisherigen ' +
    'Inhalt: "append" hängt an (zum Ergänzen fast immer richtig), "prepend" stellt voran, ' +
    '"replace" ersetzt die GANZE Seite und gilt auch dann, wenn mode ganz fehlt. ' +
    'Vor einem "replace" erst exo_page_read aufrufen und den vollständigen neuen Seitentext ' +
    'schicken, sonst löscht der Aufruf alles, was nicht mitgeschickt wurde. ' +
    'Der bisherige Zustand wird vorher als Snapshot gesichert und kann mit exo_page_snapshots ' +
    'und exo_page_restore_snapshot wiederhergestellt werden. ' +
    'Lange Inhalte in mehreren Aufrufen schreiben: den ersten mit mode "replace", die weiteren ' +
    'mit mode "append". Ein einzelner Aufruf mit sehr viel Markdown kann am Ausgabelimit ' +
    'abgeschnitten werden und wird dann gar nicht ausgeführt. ' +
    'Der Aufruf verändert Daten: der erste Aufruf fragt zurück, erst der identisch wiederholte ' +
    'schreibt. Umformulieren zwischen den beiden Aufrufen startet die Rückfrage von vorn. ' +
    'Hat jemand die Seite gerade geöffnet, erscheint die Änderung dort sofort.',
  inputSchema: pageWriteInputSchema,
  surfaces: ['mcp', 'ai'],
  mutating: true,
  destructive: true,
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
  destructive: true,
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
  description:
    'Verschiebt eine Seite zu einem neuen übergeordneten Element oder einer neuen Position. Mit ' +
    'workspaceId wandert der gesamte Unterbaum (samt Anhängen und eingebetteten Datenbanken) in ' +
    'einen anderen Arbeitsbereich; das braucht Schreibrecht in beiden Arbeitsbereichen.',
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
  destructive: true,
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
  destructive: true,
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

/** One-line German summary of an activity entry, for the model's text response. */
function formatActivityEntry(entry: z.infer<typeof documentActivityResponseSchema>['entries'][number]): string {
  const who = entry.actorName ?? 'Unbekannt';
  switch (entry.type) {
    case 'created':
      return `${entry.occurredAt}: Seite angelegt von ${who}`;
    case 'renamed':
      return `${entry.occurredAt}: umbenannt von ${who} ("${entry.previousTitle ?? '?'}" → "${entry.nextTitle ?? '?'}")`;
    case 'moved':
      return `${entry.occurredAt}: verschoben von ${who}${entry.acrossWorkspace ? ' (anderer Workspace)' : ''}`;
    case 'archived':
      return `${entry.occurredAt}: archiviert von ${who}`;
    case 'restored':
      return `${entry.occurredAt}: wiederhergestellt von ${who}`;
    case 'snapshotRestored':
      return `${entry.occurredAt}: auf Snapshot ${entry.restoredFromSnapshotId} zurückgesetzt von ${who}`;
    case 'snapshot':
      return `${entry.occurredAt}: Snapshot ${entry.id} (${entry.reason}) von ${who}`;
    case 'editingSession':
      return entry.startedAt === entry.endedAt
        ? `${entry.endedAt}: bearbeitet von ${who}`
        : `${entry.startedAt} – ${entry.endedAt}: bearbeitet von ${who}`;
  }
}

export const pageActivityTool: AnyToolDefinition = defineTool({
  name: 'exo_page_activity',
  description:
    'Liest den Verlauf einer Seite: angelegt, umbenannt, verschoben, archiviert, wiederhergestellt, ' +
    'Snapshots (mit exo_page_restore_snapshot wiederherstellbar) und verdichtete Bearbeitungssitzungen. ' +
    'Das ist der Seitenverlauf, kein Prüfprotokoll für die Verwaltung.',
  inputSchema: z.object({ documentId: idSchema }),
  surfaces: ['mcp', 'ai'],
  mutating: false,
  async execute(client, input) {
    const result = await client.request({
      method: 'GET',
      path: `/api/documents/${input.documentId}/activity`,
      responseSchema: documentActivityResponseSchema,
    });
    if (result.entries.length === 0) {
      return { text: 'Kein Verlauf vorhanden.', data: result };
    }
    return { text: result.entries.map(formatActivityEntry).join('\n'), data: result };
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

const resolveLinkInputSchema = z
  .object({ workspaceId: idSchema })
  .extend(resolveDocumentLinkRequestSchema.shape)
  .refine((value) => value.title !== undefined || value.documentId !== undefined, {
    message: 'Entweder "title" oder "documentId" muss angegeben werden.',
  });

export const pageResolveLinkTool: AnyToolDefinition = defineTool({
  name: 'exo_page_resolve_link',
  description:
    'Löst einen internen Seitenverweis auf und liefert die Seite, die er meint. Sowohl der ' +
    'Seitenlink-Block als auch ein [[Titel]] im Fließtext führen die "documentId" der ' +
    'Zielseite mit; nur ein von Hand getippter Titel, dem noch keine Seite zugeordnet ist, ' +
    'führt allein den Titel. Beides darf angegeben werden: die Identität gewinnt, deshalb ' +
    'überlebt ein Verweis das Umbenennen seiner Zielseite. Der Titel dient als Rückfall, ' +
    'wenn es die Identität nicht mehr gibt. "resolvedBy" sagt, was gegriffen hat. Mehrere ' +
    'gleichnamige Seiten werden alle mit ihrem Pfad zurückgegeben.',
  inputSchema: resolveLinkInputSchema,
  surfaces: ['mcp', 'ai'],
  mutating: false,
  async execute(client, input) {
    const { workspaceId, ...query } = input;
    const result = await client.request({
      method: 'GET',
      path: `/api/workspaces/${workspaceId}/documents/resolve`,
      query,
      responseSchema: resolveDocumentLinkResponseSchema,
    });
    if (result.matches.length === 0) {
      return {
        text:
          query.documentId === undefined
            ? `Keine Seite mit dem Titel "${result.title}".`
            : `Der Verweis ist unaufgelöst: die Seite ${query.documentId} gibt es nicht mehr, ` +
              `und keine Seite trägt den Titel "${result.title}".`,
        data: result,
      };
    }
    const lines = result.matches.map(
      (match) =>
        `${match.title} (id: ${match.id}${
          match.path.length > 0 ? `, Pfad: ${match.path.map((entry) => entry.title).join(' / ')}` : ''
        }${match.archivedAt === null ? '' : ', archiviert'})`,
    );
    const note =
      result.resolvedBy === 'title' && query.documentId !== undefined
        ? '\n(Über den Titel aufgelöst: die mitgegebene Identität gibt es nicht mehr.)'
        : '';
    return { text: `${lines.join('\n')}${note}`, data: result };
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
  pageActivityTool,
  pageSetAiRuleTool,
  pageSetLayoutTool,
  pageSetCoverTool,
  pageGenerateCoverTool,
  pageResolveLinkTool,
];
