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
  documentSummarySchema,
  documentTitleSchema,
  documentTreeRequestSchema,
  documentTreeResponseSchema,
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
import { type AnyToolDefinition, defineTool } from '../tool.js';

import {
  pageActivityTool,
  pageArchiveTool,
  pageDeleteTool,
  pageRestoreSnapshotTool,
  pageRestoreTool,
  pageSnapshotsTool,
  pageTrashTool,
} from './page-lifecycle.js';
import { formatDocumentSummary, renderTree, summarize } from './page-render.js';
import { filingHint } from './placement.js';

const MAX_PAGE_READ_CHARS = 60_000;

/**
 * Every Lucide name is accepted, but naming all 1,756 of them would cost more
 * prompt than it buys. The curated shortlist is built from the contract instead,
 * so a name added to it reaches the model in the same commit, and the sentence
 * before it tells a caller that the shortlist is not the limit.
 */
export const ICON_DESCRIPTION =
  'Symbol der Seite: entweder ein Emoji als Zeichen ("🧠") oder ein gezeichnetes Symbol ' +
  'als "lucide:<name>", wobei jeder Icon-Name von lucide.dev erlaubt ist ' +
  '(kebab-case, z. B. "lucide:rocket"). Gebräuchlich sind: ' +
  `${DOCUMENT_ICON_NAMES.join(', ')}. null entfernt das Symbol.`;

export const ICON_COLOR_DESCRIPTION =
  `Farbe eines gezeichneten Symbols: ${DOCUMENT_ICON_COLORS.join(', ')}. ` +
  'Wirkt nur auf "lucide:"-Symbole, ein Emoji bringt seine eigenen Farben mit. ' +
  'null bedeutet die Standardfarbe.';

/** How many archived pages the tool names before it falls back to a count. */
const MAX_ARCHIVED_LINES = 40;
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

/**
 * Strict on purpose, and the one tool in the catalogue that is (issue #41).
 *
 * This tool used to take a `type`, which the Markdown branch below then dropped
 * on the floor: the call reported success and made an ordinary page where a
 * database was asked for. Deleting the field alone would not have ended that,
 * it would only have moved it one layer up -- zod strips a key it does not
 * know, so `type: 'COLLECTION'` would still have produced a page without a
 * word. Refusing unknown keys is what actually makes the loss impossible, and
 * it catches the same silence for every field a caller invents: `content`,
 * `body`, `emoji`. Those create an empty page today.
 *
 * Databases are created by `exo_database_create`, which also gives them their
 * first columns -- a bare `COLLECTION` document is only half a database.
 */
const pageCreateInputSchema = z.strictObject({
  workspaceId: idSchema,
  title: documentTitleSchema.optional(),
  parentId: idSchema.nullable().optional(),
  icon: documentIconSchema.describe(ICON_DESCRIPTION),
  iconColor: documentIconColorSchema.describe(ICON_COLOR_DESCRIPTION),
  /** When given, the page is created from Markdown via the import path. */
  markdown: z.string().min(1).max(2_000_000).optional(),
});

export const pageCreateTool: AnyToolDefinition = defineTool({
  name: 'exo_page_create',
  description:
    'Legt eine neue Seite in einem Workspace an, optional mit initialem Markdown-Inhalt. ' +
    'Der Titel steht über der Seite: das Markdown nicht mit einer Überschrift beginnen, die ' +
    'den Titel wiederholt, sonst steht er auf der Seite zweimal. ' +
    'Nur gewöhnliche Seiten: eine Datenbank (Notion-artige Tabelle) legt exo_database_create an, ' +
    'samt Startspalten. ' +
    'Legst du eine Sammelseite an, die vor allem Unterseiten bündeln soll, dann markiere sie mit ' +
    'exo_page_set_overview als Übersichtsseite und schreib keinen eigenen Fließtext hinein: ' +
    'eXocortex hält die Beschreibung der Unterseiten dort selbst aktuell. ' +
    'Weißt du nicht sicher, wohin die Seite gehört, frag vorher exo_page_suggest_parent: ' +
    'eine Seite landet sonst leicht eine Ebene zu hoch, über den Unterbereich, in den sie gehört.',
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
          icon: input.icon,
          iconColor: input.iconColor,
        } satisfies z.infer<typeof markdownImportRequestSchema>,
        responseSchema: markdownImportResponseSchema,
      });
      const importHint = await filingHint(client, input.workspaceId, input.parentId);
      return {
        text: `Seite erstellt: ${formatDocumentSummary(result.document)}.${importHint}`,
        data: result,
      };
    }

    const result = await client.request({
      method: 'POST',
      path: `/api/workspaces/${input.workspaceId}/documents`,
      body: {
        title: input.title,
        parentId: input.parentId,
        type: 'PAGE',
        icon: input.icon,
        iconColor: input.iconColor,
      },
      responseSchema: documentSummarySchema,
    });
    const hint = await filingHint(client, input.workspaceId, input.parentId);
    return { text: `Seite erstellt: ${formatDocumentSummary(result)}.${hint}`, data: result };
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
  'Seitenlinks als [[Seitentitel]] schreiben: eXocortex bindet sie beim Schreiben an die Seite ' +
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
    'Der Seitentitel steht über der Seite und gehört nicht in den Text: keine erste ' +
    'Überschrift schreiben, die den Titel wiederholt. Eine solche Überschrift wird beim ' +
    'Schreiben entfernt. ' +
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
    const warningsText =
      result.warnings.length > 0 ? ` Warnungen: ${result.warnings.join('; ')}` : '';
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
    return {
      text: `Layout auf ${input.layout} gesetzt: ${formatDocumentSummary(result)}`,
      data: result,
    };
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
          match.path.length > 0
            ? `, Pfad: ${match.path.map((entry) => entry.title).join(' / ')}`
            : ''
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
