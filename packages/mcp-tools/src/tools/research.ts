import { z } from 'zod';

import {
  documentDetailSchema,
  idSchema,
  markdownExportResponseSchema,
  searchResponseSchema,
  workspaceListResponseSchema,
} from '@exocortex/contracts';

import { type ExocortexApiClient } from '../client.js';
import { type AnyToolDefinition, defineTool } from '../tool.js';

/**
 * The two tools ChatGPT's deep research connector requires.
 *
 * They are not a second implementation of anything: `search` fans out over the
 * same `/search` endpoint `exo_search` uses and `fetch` reads the same
 * Markdown export `exo_page_read` reads. What differs is the contract with the
 * caller, and it is not negotiable on ChatGPT's side:
 *
 *  - the names must be exactly `search` and `fetch`
 *  - `search` takes a single `query` string and nothing else
 *  - both answer with a JSON document in the text content, not prose
 *
 * Every other surface keeps the `exo_`-prefixed tools, which say what they
 * operate on and take the ids a real workflow needs.
 */

/** How many results one `search` call may return, across all workspaces. */
const MAX_RESULTS = 20;
/** Per-workspace fan-out limit, before merging and re-ranking. */
const PER_WORKSPACE_LIMIT = 20;
/** ChatGPT reads the whole document; this is the ceiling before truncation. */
const MAX_FETCH_CHARS = 200_000;

/**
 * The page a human would open for this document. Returns `null` when the
 * client was built without a public origin, in which case the caller omits the
 * field rather than inventing a URL that leads nowhere.
 */
function documentUrl(
  client: ExocortexApiClient,
  workspaceId: string,
  documentId: string,
): string | null {
  if (client.appUrl === undefined) return null;
  return new URL(
    `/arbeitsbereich/${workspaceId}/seite/${documentId}`,
    client.appUrl,
  ).toString();
}

/**
 * Deep research reads the *text* of the content block and expects JSON in it.
 * `structuredContent` is filled with the same object, so a client that reads
 * the typed field gets it too.
 */
function jsonResult(payload: unknown): { text: string; data: unknown } {
  return { text: JSON.stringify(payload), data: payload };
}

export const researchSearchTool: AnyToolDefinition = defineTool({
  name: 'search',
  description:
    'Durchsucht alle eXocortex-Arbeitsbereiche, auf die der verbundene Account Zugriff hat, ' +
    'und liefert passende Seiten mit id, Titel und URL. Die id wird an fetch übergeben, ' +
    'um den vollständigen Text der Seite zu laden.',
  inputSchema: z.object({
    query: z.string().trim().min(1).max(200).describe('Suchbegriff in natürlicher Sprache'),
  }),
  surfaces: ['research'],
  mutating: false,
  async execute(client, input) {
    const workspaces = await client.request({
      method: 'GET',
      path: '/api/workspaces',
      responseSchema: workspaceListResponseSchema,
    });

    // One search per workspace: the search endpoint is workspace-scoped, and
    // deep research hands over a bare query with nothing to scope it by. A
    // deployment has a handful of workspaces, so the fan-out is bounded by
    // what a person actually joined, not by anything the caller controls.
    const perWorkspace = await Promise.all(
      workspaces.workspaces.map(async (workspace) =>
        client.request({
          method: 'GET',
          path: `/api/workspaces/${workspace.id}/search`,
          query: { q: input.query, limit: PER_WORKSPACE_LIMIT },
          responseSchema: searchResponseSchema,
        }),
      ),
    );

    const results = perWorkspace
      .flatMap((response) => response.results)
      .sort((a, b) => b.rank - a.rank)
      .slice(0, MAX_RESULTS)
      .map((result) => {
        const url = documentUrl(client, result.workspaceId, result.documentId);
        return {
          id: result.documentId,
          title: result.title,
          ...(url === null ? {} : { url }),
        };
      });

    return jsonResult({ results });
  },
});

export const researchFetchTool: AnyToolDefinition = defineTool({
  name: 'fetch',
  description:
    'Lädt den vollständigen Text einer eXocortex-Seite als Markdown. ' +
    'Die id stammt aus einem search-Ergebnis.',
  inputSchema: z.object({
    id: idSchema.describe('documentId aus einem search-Ergebnis'),
  }),
  surfaces: ['research'],
  mutating: false,
  async execute(client, input) {
    // Two reads, because neither endpoint alone carries both halves: the
    // export has the text but no title or workspace, the detail has the
    // metadata but not the Markdown.
    const [detail, exported] = await Promise.all([
      client.request({
        method: 'GET',
        path: `/api/documents/${input.id}`,
        responseSchema: documentDetailSchema,
      }),
      client.request({
        method: 'GET',
        path: `/api/documents/${input.id}/export/markdown`,
        responseSchema: markdownExportResponseSchema,
      }),
    ]);

    const truncated = exported.markdown.length > MAX_FETCH_CHARS;
    const text = truncated ? exported.markdown.slice(0, MAX_FETCH_CHARS) : exported.markdown;
    const url = documentUrl(client, detail.workspaceId, detail.id);

    return jsonResult({
      id: detail.id,
      title: detail.title,
      text,
      ...(url === null ? {} : { url }),
      metadata: {
        workspaceId: detail.workspaceId,
        type: detail.type,
        updatedAt: detail.updatedAt,
        archived: detail.archivedAt !== null,
        truncated,
        fullLength: exported.markdown.length,
      },
    });
  },
});

export const RESEARCH_TOOLS: readonly AnyToolDefinition[] = [researchSearchTool, researchFetchTool];
