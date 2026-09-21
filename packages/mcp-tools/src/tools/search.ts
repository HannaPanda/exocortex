import { z } from 'zod';

import {
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

export const SEARCH_TOOLS: readonly AnyToolDefinition[] = [searchTool];
