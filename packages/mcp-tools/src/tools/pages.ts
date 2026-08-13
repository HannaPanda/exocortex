import { z } from 'zod';

import {
  aiRuleModeSchema,
  archiveDocumentResponseSchema,
  coverPositionSchema,
  deleteDocumentsResponseSchema,
  DOCUMENT_ICON_COLORS,
  DOCUMENT_ICON_NAMES,
  documentActivityResponseSchema,
  documentContentWriteRequestSchema,
  documentContentWriteResponseSchema,
  documentDeletionPreviewSchema,
  documentIconColorSchema,
  documentIconSchema,
  documentLayoutSchema,
  documentSnapshotListResponseSchema,
  type DocumentSummary,
  documentSummarySchema,
  documentTitleSchema,
  type DocumentTreeNode,
  documentTreeRequestSchema,
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
  type TrashEntry,
  trashResponseSchema,
} from '@exocortex/contracts';

import { truncateText } from '../format.js';
import { restoreSnapshotResultSchema } from '../local-schemas.js';
import { type AnyToolDefinition, defineTool } from '../tool.js';

const MAX_PAGE_READ_CHARS = 60_000;

/**
 * Every Lucide name is accepted, but naming all 1,756 of them would cost more
 * prompt than it buys. The curated shortlist is built from the contract instead,
 * so a name added to it reaches the model in the same commit, and the sentence
 * before it tells a caller that the shortlist is not the limit.
 */
const ICON_DESCRIPTION =
  'Symbol der Seite: entweder ein Emoji als Zeichen ("🧠") oder ein gezeichnetes Symbol ' +
  'als "lucide:<name>", wobei jeder Icon-Name von lucide.dev erlaubt ist ' +
  '(kebab-case, z. B. "lucide:rocket"). Gebräuchlich sind: ' +
  `${DOCUMENT_ICON_NAMES.join(', ')}. null entfernt das Symbol.`;

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
 * Which pages the cap keeps is the whole design, and two obvious rules are both
 * wrong. Depth-first spends the budget inside whichever section sorts first and
 * leaves the later ones out entirely, so a reader looking for "Technik"
 * concludes it does not exist. Whole-levels-only is honest but starves: the
 * Second Brain's second level is 700 pages wide, so the answer collapses to
 * eighteen section names and nothing else.
 *
 * So every root section is always listed, and what is left of the budget is
 * shared out among them evenly, one line at a time, with anything a small
 * section does not need flowing to the larger ones. Inside a section the share
 * is spent breadth-first, nearest pages first. Nothing dropped is unreachable:
 * every omitted page still has a visible ancestor to ask about.
 */
function renderTree(nodes: readonly DocumentTreeNode[]): RenderedTree {
  const total = countNodes(nodes);

  // Not even the root level fits. Show as much of it as there is room for
  // rather than nothing: a truncated list of sections is still a map.
  if (nodes.length >= MAX_TREE_LINES) {
    const shown = nodes.slice(0, MAX_TREE_LINES);
    return {
      lines: shown.map((node) => `- ${formatDocumentSummary(node)}`),
      // Their children were not rendered, so they are not in the structured
      // half either; the section keeps its own line and its `omitted` count.
      structured: shown.map((node) => ({ ...summarize(node), children: [] })),
      omitted: total - shown.length,
      truncated: shown
        .filter((node) => node.children.length > 0)
        .map((node) => ({ id: node.id, title: node.title, omitted: countNodes(node.children) })),
    };
  }

  const demands = nodes.map((node) => countNodes(node.children));
  const shares = shareEvenly(demands, MAX_TREE_LINES - nodes.length);
  const kept = new Set<string>();
  nodes.forEach((node, index) => {
    for (const id of nearestDescendants(node, shares[index] ?? 0)) kept.add(id);
  });

  const lines: string[] = [];
  const walk = (node: DocumentTreeNode, depth: number): TreeNodeSummary => {
    lines.push(`${'  '.repeat(depth)}- ${formatDocumentSummary(node)}`);
    return {
      ...summarize(node),
      children: node.children
        .filter((child) => kept.has(child.id))
        .map((child) => walk(child, depth + 1)),
    };
  };
  const structured = nodes.map((node) => walk(node, 0));

  return {
    lines,
    structured,
    omitted: total - lines.length,
    // Named, with their ids, because "ask via the parent page" is only an
    // instruction a caller can follow if it is told which parents those are.
    truncated: nodes
      .map((node, index) => ({
        id: node.id,
        title: node.title,
        omitted: (demands[index] ?? 0) - (shares[index] ?? 0),
      }))
      .filter((section) => section.omitted > 0),
  };
}

interface RenderedTree {
  lines: string[];
  /** The same pages the lines name, for the clients that read the structure. */
  structured: TreeNodeSummary[];
  omitted: number;
  /** Sections that lost pages to the cap, largest loss first when rendered. */
  truncated: { id: string; title: string; omitted: number }[];
}

/**
 * A page in the structured tree, carrying what the rendered line carries and
 * nothing else.
 *
 * The full `DocumentSummary` is sixteen fields, and cover positions and order
 * keys are of no use to a reader that is deciding where a page belongs: 737
 * pages of them are 400 KB, against 26 KB for the same pages as text. ChatGPT's
 * connector reads this half, and answered three capped trees in a row with
 * "Sicherheitsstatus der Anfrage konnte nicht bestimmt werden" before it gave
 * up on the write it was asked for. Whatever else that check weighs, a tool
 * result that costs fifteen times its own text is not worth sending.
 */
interface TreeNodeSummary {
  id: string;
  title: string;
  type: DocumentSummary['type'];
  children: TreeNodeSummary[];
}

function summarize(document: DocumentSummary): Omit<TreeNodeSummary, 'children'> {
  return { id: document.id, title: document.title, type: document.type };
}

/** How many archived pages the tool names before it falls back to a count. */
const MAX_ARCHIVED_LINES = 40;

/**
 * Hands out `budget` one unit at a time, skipping anyone already satisfied, so
 * a section that wants three lines takes three and the rest goes to the ones
 * that can use it. Equal shares with the leftovers redistributed, without the
 * rounding arguments a proportional split invites.
 */
function shareEvenly(demands: readonly number[], budget: number): number[] {
  const grants = demands.map(() => 0);
  let left = budget;
  let progress = true;
  while (left > 0 && progress) {
    progress = false;
    for (const [index, demand] of demands.entries()) {
      if (left === 0) break;
      if ((grants[index] ?? 0) >= demand) continue;
      grants[index] = (grants[index] ?? 0) + 1;
      left -= 1;
      progress = true;
    }
  }
  return grants;
}

/** The `limit` descendants closest to `node`, breadth-first, as a set of ids. */
function nearestDescendants(node: DocumentTreeNode, limit: number): string[] {
  const chosen: string[] = [];
  let level: readonly DocumentTreeNode[] = node.children;
  while (level.length > 0 && chosen.length < limit) {
    const next: DocumentTreeNode[] = [];
    for (const child of level) {
      if (chosen.length >= limit) break;
      chosen.push(child.id);
      next.push(...child.children);
    }
    level = next;
  }
  return chosen;
}

function countNodes(nodes: readonly DocumentTreeNode[]): number {
  return nodes.reduce((sum, node) => sum + 1 + countNodes(node.children), 0);
}

export const pageTreeTool: AnyToolDefinition = defineTool({
  name: 'exo_page_tree',
  description:
    'Liest die Seitenhierarchie als Baum. Ohne parentId den ganzen Workspace (bei vielen Seiten ' +
    'gekürzt), mit parentId nur den Zweig unter dieser Seite. Ein gekürzter Baum ist keine ' +
    'vollständige Liste: um sicher zu wissen, was unter einer Seite hängt, ruf das Tool mit ' +
    'deren parentId auf.',
  inputSchema: z.object({ workspaceId: idSchema }).extend(documentTreeRequestSchema.shape),
  surfaces: ['mcp', 'ai'],
  mutating: false,
  async execute(client, input) {
    const { workspaceId, ...query } = input;
    const result = await client.request({
      method: 'GET',
      path: `/api/workspaces/${workspaceId}/documents/tree`,
      query,
      responseSchema: documentTreeResponseSchema,
    });
    const { lines, structured, omitted, truncated } = renderTree(result.nodes);
    const scope =
      result.path.length === 0
        ? []
        : [`Zweig unter: ${result.path.map((entry) => entry.title).join(' > ')}\n`];
    const sections = truncated.slice().sort((a, b) => b.omitted - a.omitted);
    // The caveat goes before the list it qualifies, not after it. A reader that
    // stops somewhere inside 300 lines of tree never reaches a footer, and a
    // client that shows only the first lines of a tool result hides one.
    const notice =
      omitted === 0
        ? []
        : [
            `… ${omitted} von ${result.totalCount} Seite(n) hier nicht angezeigt (gekürzt). ` +
              'Diese Liste ist keine vollständige Antwort. Ruf exo_page_tree mit parentId der ' +
              'jeweiligen Seite auf, um darunter vollständig zu lesen. Am meisten gekürzt: ' +
              sections
                .slice(0, 5)
                .map((section) => `${section.title} (parentId: ${section.id}, ${section.omitted})`)
                .join(', ') +
              '\n',
          ];
    const parts = [
      ...scope,
      ...notice,
      lines.length === 0
        ? result.path.length === 0
          ? 'Keine Seiten vorhanden.'
          : 'Keine Unterseiten.'
        : lines.join('\n'),
      // Named, not just counted: a caller that has to judge whether a page it
      // is looking for was archived cannot do that from a number, and a caller
      // that just archived something has no other way to see what went along.
      // Still separated from the tree, because the trash is not a place to
      // file a new page into.
      ...(result.archived.length === 0
        ? []
        : [
            `\n${result.archived.length} archivierte Seite(n) (Papierkorb, nicht Teil des Baums, ` +
              'exo_page_restore holt eine zurück):\n' +
              result.archived
                .slice(0, MAX_ARCHIVED_LINES)
                .map((document) => `- ${formatDocumentSummary(document)}`)
                .join('\n') +
              (result.archived.length > MAX_ARCHIVED_LINES
                ? `\n… und ${result.archived.length - MAX_ARCHIVED_LINES} weitere.`
                : ''),
          ]),
    ];
    return {
      text: parts.join('\n'),
      // Both halves of the result answer the same question, so both are capped
      // the same way: the pages the text names, the archived pages it names,
      // and the caveat that says the list is not everything. A client that
      // renders the structured payload instead of the text -- ChatGPT's
      // connector does, and collapses it to `nodes: Array(20)` -- would
      // otherwise see a tree with no sign that the rendered answer was capped
      // and conclude it read everything, at fifteen times the size.
      //
      // Written out field by field rather than spread from `result`, so a field
      // added to the tree response later cannot quietly grow this payload back.
      data: {
        nodes: structured,
        archived: result.archived.slice(0, MAX_ARCHIVED_LINES).map(summarize),
        /** All of them, including the ones the cap above left out. */
        archivedTotalCount: result.archived.length,
        path: result.path,
        totalCount: result.totalCount,
        ...(omitted === 0
          ? {}
          : {
              truncation: {
                omitted,
                shown: lines.length,
                totalCount: result.totalCount,
                /** Every section that lost lines, not just the five the text names. */
                sections,
                hint:
                  'Die gerenderte Liste ist gekürzt und beantwortet nicht, was unter einer ' +
                  'Seite hängt. Ruf exo_page_tree mit deren parentId auf.',
              },
            }),
      },
    };
  },
});

export const pageReadTool: AnyToolDefinition = defineTool({
  name: 'exo_page_read',
  description:
    'Exportiert den Inhalt einer Seite als Markdown, mit ihrem Pfad und ihren direkten ' +
    'Unterseiten. Der Fließtext einer Übersichtsseite ist nicht die Struktur: was wirklich unter ' +
    'ihr hängt, steht in der Liste der Unterseiten.',
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
    const header = [
      ...(result.path.length === 0
        ? []
        : [`Pfad: ${result.path.map((entry) => entry.title).join(' > ')}`]),
      result.children.length === 0
        ? 'Unterseiten: keine'
        : `Unterseiten (${result.children.length}):\n` +
          result.children.map((child) => `- ${formatDocumentSummary(child)}`).join('\n'),
    ].join('\n');
    return {
      text: `${header}\n\n---\n\n${text}`,
      data: { ...result, fullLength: result.markdown.length },
    };
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
  description:
    'Verschiebt eine Seite in den Papierkorb (archivieren). Achtung: alle Unterseiten wandern ' +
    'mit. Wer nur die Seite selbst wegräumen will, verschiebt die Unterseiten vorher mit ' +
    'exo_page_move woanders hin.',
  inputSchema: z.object({ documentId: idSchema }),
  surfaces: ['mcp', 'ai'],
  mutating: true,
  destructive: true,
  target: (input) => `document:${input.documentId}`,
  async execute(client, input) {
    const result = await client.request({
      method: 'POST',
      path: `/api/documents/${input.documentId}/archive`,
      responseSchema: archiveDocumentResponseSchema,
    });
    const cascade =
      result.archivedDescendants.length === 0
        ? []
        : [
            `Mit archiviert wurden ${result.archivedDescendants.length} Unterseite(n):`,
            ...result.archivedDescendants.map((child) => `- ${formatDocumentSummary(child)}`),
            'Falls das nicht gewollt war: exo_page_restore holt jede einzeln zurück.',
          ];
    return {
      text: [`Seite archiviert: ${formatDocumentSummary(result)}`, ...cascade].join('\n'),
      data: result,
    };
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

/** Enough to read a trash of a few hundred pages, short of pasting a workspace. */
const MAX_TRASH_LINES = 200;

/** `2026-08-11T19:22:36.000Z` → `2026-08-11 19:22`. Unambiguous, and short. */
function formatArchivedAt(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

function renderTrashEntries(
  entries: readonly TrashEntry[],
  depth: number,
  budget: { left: number },
): string[] {
  const lines: string[] = [];
  for (const entry of entries) {
    if (budget.left <= 0) break;
    budget.left -= 1;
    const cascade = entry.reason === 'cascade' ? ', mit archiviert' : '';
    const below =
      entry.descendantCount === 0
        ? ''
        : `, ${entry.descendantCount} archivierte Seite(n) darunter`;
    lines.push(
      `${'  '.repeat(depth)}- ${entry.title} (id: ${entry.id}, type: ${entry.type}, ` +
        `archiviert ${formatArchivedAt(entry.archivedAt)}${cascade}${below})`,
    );
    lines.push(...renderTrashEntries(entry.children, depth + 1, budget));
  }
  return lines;
}

export const pageTrashTool: AnyToolDefinition = defineTool({
  name: 'exo_page_trash',
  description:
    'Liest den Papierkorb eines Arbeitsbereichs als Baum: was archiviert wurde, was dabei ' +
    'mitgegangen ist und wann. Eingerückte Einträge hingen unter dem Eintrag darüber. ' +
    '"mit archiviert" heißt: diese Seite wurde nie selbst gewählt, sie kam mit ihrer ' +
    'Elternseite mit. exo_page_restore holt eine Seite zurück, exo_page_delete löscht sie ' +
    'endgültig.',
  inputSchema: z.object({ workspaceId: idSchema }),
  surfaces: ['mcp', 'ai'],
  mutating: false,
  async execute(client, input) {
    const result = await client.request({
      method: 'GET',
      path: `/api/workspaces/${input.workspaceId}/trash`,
      responseSchema: trashResponseSchema,
    });
    if (result.totalCount === 0) {
      return { text: 'Der Papierkorb ist leer.', data: result };
    }
    const budget = { left: MAX_TRASH_LINES };
    const lines = renderTrashEntries(result.entries, 0, budget);
    const omitted = result.totalCount - lines.length;
    const notice =
      omitted <= 0
        ? ''
        : `\n… ${omitted} weitere archivierte Seite(n) hier nicht angezeigt (gekürzt).`;
    return {
      text:
        `${result.totalCount} archivierte Seite(n), davon ${result.entries.length} eigenständig ` +
        `archiviert:\n${lines.join('\n')}${notice}`,
      data: result,
    };
  },
});

export const pageDeleteTool: AnyToolDefinition = defineTool({
  name: 'exo_page_delete',
  description:
    'Löscht eine archivierte Seite endgültig, mit allem, was unter ihr hängt: Inhalt, ' +
    'Versionsstände, Kommentare, Anhänge und Dateien. Das ist der einzige Vorgang in ' +
    'eXocortex, den nichts rückgängig macht, auch kein Snapshot. Die Seite muss vorher im ' +
    'Papierkorb liegen (exo_page_archive), und es braucht Adminrechte im Arbeitsbereich. ' +
    'Verweise anderer Seiten auf sie bleiben stehen und werden zu unaufgelösten Verweisen. ' +
    'Der Aufruf verändert Daten: der erste Aufruf sagt, wie viele Seiten mitgehen, und führt ' +
    'nichts aus; erst der identisch wiederholte löscht.',
  inputSchema: z.object({ documentId: idSchema }),
  // `mcp` only, deliberately. The built-in AI's tool loop has no confirmation
  // gate -- it is governed by the `ai.mutatingToolsEnabled` switch, which is one
  // decision for every write there is. The single operation nothing can undo
  // does not belong behind a switch somebody flipped once, so it stays with the
  // surfaces that ask twice.
  surfaces: ['mcp'],
  mutating: true,
  destructive: true,
  target: (input) => `document:${input.documentId}`,
  async preview(client, input) {
    const preview = await client.request({
      method: 'GET',
      path: `/api/documents/${input.documentId}/deletion-preview`,
      responseSchema: documentDeletionPreviewSchema,
    });
    const names = preview.documents
      .slice(1, 11)
      .map((document) => `- ${formatDocumentSummary(document)}`);
    return [
      `Endgültig gelöscht würden ${preview.documents.length} Seite(n): „${preview.title}“` +
        (preview.descendantCount === 0
          ? ' (keine Unterseiten).'
          : ` und ${preview.descendantCount} Seite(n) darunter.`),
      ...(names.length === 0 ? [] : names),
      ...(preview.descendantCount > names.length
        ? [`… und ${preview.descendantCount - names.length} weitere.`]
        : []),
      ...(preview.attachmentCount === 0
        ? []
        : [`Dazu ${preview.attachmentCount} Anhang/Anhänge samt Dateien.`]),
      ...(preview.incomingLinkCount === 0
        ? []
        : [
            `${preview.incomingLinkCount} Verweis(e) anderer Seiten zeigen darauf und werden ` +
              'unaufgelöst.',
          ]),
      'Das ist nicht rückgängig zu machen.',
    ].join('\n');
  },
  async execute(client, input) {
    const result = await client.request({
      method: 'DELETE',
      path: `/api/documents/${input.documentId}`,
      responseSchema: deleteDocumentsResponseSchema,
    });
    const extras = [
      result.attachmentCount === 0 ? null : `${result.attachmentCount} Anhang/Anhänge`,
      result.unresolvedLinkCount === 0
        ? null
        : `${result.unresolvedLinkCount} Verweis(e) sind jetzt unaufgelöst`,
    ].filter((part): part is string => part !== null);
    return {
      text:
        `${result.deletedCount} Seite(n) endgültig gelöscht.` +
        (extras.length === 0 ? '' : ` ${extras.join(', ')}.`),
      data: result,
    };
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
  pageTrashTool,
  pageDeleteTool,
  pageSnapshotsTool,
  pageRestoreSnapshotTool,
  pageActivityTool,
  pageSetAiRuleTool,
  pageSetLayoutTool,
  pageSetCoverTool,
  pageGenerateCoverTool,
  pageResolveLinkTool,
];
