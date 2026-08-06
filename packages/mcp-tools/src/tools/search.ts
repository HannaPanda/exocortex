import { z } from 'zod';

import { idSchema, searchRequestSchema, searchResponseSchema } from '@exocortex/contracts';

import { type AnyToolDefinition, defineTool } from '../tool.js';

const searchInputSchema = z.object({ workspaceId: idSchema }).extend(searchRequestSchema.shape);

export const searchTool: AnyToolDefinition = defineTool({
  name: 'exo_search',
  description:
    'Durchsucht Titel und Inhalt eines Workspace nach einem Suchbegriff. ' +
    'Ergebnisse enthalten die documentId, mit der exo_page_read den vollen Inhalt lädt.',
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
    const text = result.results
      .map((item, i) => `${i + 1}. ${item.title} (id: ${item.documentId}) — ${item.snippet}`)
      .join('\n');
    return { text, data: result };
  },
});

export const SEARCH_TOOLS: readonly AnyToolDefinition[] = [searchTool];
