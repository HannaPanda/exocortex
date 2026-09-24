import { z } from 'zod';

import {
  CONTEXT_MAX_CHARS,
  contextCompileResponseSchema,
  idSchema,
  searchRequestSchema,
  searchResponseSchema,
  type SearchResult,
} from '@exocortex/contracts';

import { type AnyToolDefinition, defineTool } from '../tool.js';

const searchInputSchema = z.object({ workspaceId: idSchema }).extend(searchRequestSchema.shape);

export const searchTool: AnyToolDefinition = defineTool({
  name: 'exo_search',
  description:
    'Durchsucht Titel und Inhalt eines Workspace nach einem Suchbegriff. ' +
    'Ergebnisse enthalten die documentId, mit der exo_page_read den vollen Inhalt lädt, und ' +
    'den Pfad, unter dem der Treffer hängt. Wurde ein Treffer über die Bedeutung gefunden, ' +
    'nennt er zusätzlich den Abschnitt samt Blockkennung: damit liest exo_page_block_read ' +
    'genau diesen Abschnitt statt der ganzen Seite. ' +
    'Eine Suche zeigt nur Treffer zum Begriff, nie die ' +
    'Struktur: was unter einer Seite hängt, beantwortet exo_page_tree mit deren parentId.',
  inputSchema: searchInputSchema,
  surfaces: ['mcp', 'ai'],
  domain: 'core',
  mutating: false,
  async execute(client, input) {
    const { workspaceId, ...query } = input;
    const result = await client.request({
      method: 'GET',
      path: `/api/workspaces/${workspaceId}/search`,
      query,
      responseSchema: searchResponseSchema,
    });
    if (result.results.length === 0) {
      return { text: `Keine Treffer für "${result.query}".`, data: result };
    }
    // The path travels with every hit: a title alone is not an address, and a
    // caller that has to decide whether the "Rezepte" it found is the one it
    // means cannot do that from a title and a snippet.
    const text = result.results
      .map((item, i) => {
        const location =
          item.path.length === 0
            ? 'oberste Ebene'
            : item.path.map((entry) => entry.title).join(' > ');
        return `${i + 1}. ${item.title} (id: ${item.documentId}, in: ${location})${sectionOf(item)} — ${item.snippet}`;
      })
      .join('\n');
    return { text, data: result };
  },
});

/**
 * Where on the page the hit sits, when the answer knows (issue #118).
 *
 * The block identifier is what makes the line worth printing: without it a
 * caller is back to reading the whole page to find the paragraph it was just
 * shown. A section that carries none is still named, because knowing the
 * heading is worth more than nothing even when it cannot be opened directly.
 */
function sectionOf(hit: SearchResult): string {
  if (hit.section === null) return '';
  const path = hit.section.path.join(' > ');
  return hit.section.blockId === null
    ? `, Abschnitt: ${path}`
    : `, Abschnitt: ${path} (^${hit.section.blockId})`;
}

/**
 * The context compiler (issue #110, ADR-061).
 *
 * The third of three reading tools, and the one that does not ask the caller
 * to know where to look: `exo_search` finds pages, `exo_page_read` loads a
 * named one, and this answers a question with the passages out of several
 * pages that bear on it, under a budget the caller chose. The text is the
 * answer the model reads; the structured sources are in `data`.
 */
export const contextCompileTool: AnyToolDefinition = defineTool({
  name: 'exo_context_compile',
  description:
    'Stellt zu einer Frage den Arbeitskontext zusammen: sucht in allen lesbaren Arbeitsbereichen ' +
    '(oder den genannten) die passenden Seiten, wählt daraus die relevanten Abschnitte und liefert ' +
    'sie wörtlich, mit Titel, Pfad, Stand und Blockkennung, innerhalb von maxChars Zeichen. ' +
    'Der richtige erste Schritt bei Wissensfragen ("was wissen wir über X"): ein Aufruf statt ' +
    'exo_search und mehrerer exo_page_read. Es wird nichts zusammengefasst, jede Passage steht so ' +
    'auf ihrer Seite. Eine Seite im Ganzen lädt weiter exo_page_read, einen genannten Abschnitt ' +
    'exo_page_block_read. Der Gedächtnisbereich der Agenten wird nur durchsucht, wenn er in ' +
    'workspaceIds steht.',
  inputSchema: z.object({
    q: z.string().trim().min(1).max(500).describe('Die Frage oder das Thema, in eigenen Worten.'),
    workspaceIds: z
      .array(idSchema)
      .min(1)
      .max(20)
      .optional()
      .describe('Nur in diesen Arbeitsbereichen suchen. Weglassen: alle, außer dem Gedächtnis.'),
    maxChars: z
      .number()
      .int()
      .min(500)
      .max(CONTEXT_MAX_CHARS)
      .optional()
      .describe('Obergrenze für den gesamten Text. Standard 12000.'),
    maxSources: z
      .number()
      .int()
      .min(1)
      .max(30)
      .optional()
      .describe('Höchstzahl verschiedener Seiten. Standard 12.'),
    perSourceMaxChars: z
      .number()
      .int()
      .min(200)
      .max(CONTEXT_MAX_CHARS)
      .optional()
      .describe('Wie viel eine einzelne Seite höchstens beitragen darf. Standard ein Drittel.'),
  }),
  surfaces: ['mcp', 'ai'],
  domain: 'core',
  mutating: false,
  async execute(client, input) {
    const result = await client.request({
      method: 'GET',
      path: '/api/context',
      query: {
        q: input.q,
        ...(input.workspaceIds === undefined ? {} : { workspaceIds: input.workspaceIds.join(',') }),
        ...(input.maxChars === undefined ? {} : { maxChars: input.maxChars }),
        ...(input.maxSources === undefined ? {} : { maxSources: input.maxSources }),
        ...(input.perSourceMaxChars === undefined
          ? {}
          : { perSourceMaxChars: input.perSourceMaxChars }),
      },
      responseSchema: contextCompileResponseSchema,
    });
    if (result.sources.length === 0) {
      return { text: `Kein passender Kontext zu "${result.query}".`, data: result };
    }
    const stages = result.stages.includes('semantic')
      ? ''
      : ' Nur Volltext: die Bedeutungssuche war nicht verfügbar.';
    const footer = result.truncated
      ? `\n\n(${result.selected} von ${result.candidates} Passagen aus ${result.sources.length} Seiten; weitere passten nicht ins Budget.${stages})`
      : `\n\n(${result.selected} Passagen aus ${result.sources.length} Seiten.${stages})`;
    return { text: `${result.text}${footer}`, data: result };
  },
});

export const SEARCH_TOOLS: readonly AnyToolDefinition[] = [searchTool, contextCompileTool];
