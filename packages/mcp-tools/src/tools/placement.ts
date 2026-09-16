import { z } from 'zod';

import {
  type DocumentTreeNode,
  documentTreeResponseSchema,
  idSchema,
  suggestParentRequestSchema,
  suggestParentResponseSchema,
} from '@exocortex/contracts';

import { type ExocortexApiClient } from '../client.js';
import { type AnyToolDefinition, defineTool } from '../tool.js';

/** How many sibling sections a filing hint names before it stops. */
const MAX_HINTED_SECTIONS = 8;

/** A section worth naming holds at least this many pages. */
const MIN_SECTION_CHILDREN = 1;

export const pageSuggestParentTool: AnyToolDefinition = defineTool({
  name: 'exo_page_suggest_parent',
  description:
    'Schlägt vor, unter welche Seite eine neue oder bestehende Seite gehört. Antwortet mit ' +
    'Kandidaten samt Pfad und Begründung: genannt werden die bereits vorhandenen Seiten, die ' +
    'inhaltlich am nächsten liegen und dort hängen. ' +
    'Ruf das Werkzeug VOR exo_page_create auf, wenn du nicht sicher weißt, wohin die Seite ' +
    'gehört, und übernimm die parentId des besten Vorschlags. Für eine Seite, die es schon ' +
    'gibt, reicht documentId; für eine geplante Seite title und (hilfreich) summary. ' +
    'Es wird nichts geschrieben und nichts verschoben; verschieben tut exo_page_move.',
  inputSchema: z.object({ workspaceId: idSchema }).extend(suggestParentRequestSchema.shape),
  surfaces: ['mcp', 'ai'],
  mutating: false,
  async execute(client, input) {
    const { workspaceId, ...body } = input;
    const result = await client.request({
      method: 'POST',
      path: `/api/workspaces/${workspaceId}/documents/suggest-parent`,
      body,
      responseSchema: suggestParentResponseSchema,
    });
    if (result.suggestions.length === 0) {
      return {
        text:
          'Kein Vorschlag: es gibt keine inhaltlich nahen Seiten in diesem Arbeitsbereich. ' +
          'Sieh dir mit exo_page_tree die vorhandene Struktur an und entscheide selbst.',
        data: result,
      };
    }
    const lines = result.suggestions.map((suggestion, index) => {
      const location =
        suggestion.path.length === 0
          ? 'oberste Ebene'
          : suggestion.path.map((entry) => entry.title).join(' > ');
      const matches = suggestion.matches.map((match) => match.title).join(', ');
      return (
        `${index + 1}. ${suggestion.title} (parentId: ${suggestion.parentId ?? 'null'}, ` +
        `in: ${location}, ${suggestion.childCount} Unterseite(n))\n` +
        `   Dort liegen bereits: ${matches}`
      );
    });
    return {
      text: [
        `Vorschläge für die Ablage (Suche: "${result.query.slice(0, 120)}"):`,
        ...lines,
        'parentId des besten Vorschlags an exo_page_create oder exo_page_move übergeben.',
      ].join('\n'),
      data: result,
    };
  },
});

/**
 * The sentence a freshly created page gets when its parent has sections under
 * it.
 *
 * This is the other half of the filing problem, and the half a suggestion tool
 * does not solve: a caller that never doubted its choice never asks for a
 * suggestion. "Lokale Musik-KI-Modelle" was filed directly under "AI & Tools"
 * while "Creative & Media" sat one level below with fifteen pages of that exact
 * kind in it, and nothing in the answer said so. The hint travels in the result
 * of the write itself, which is the one place every caller reads.
 *
 * It never fails a creation: a page that exists must not be reported as an
 * error because the hint could not be assembled.
 */
export async function filingHint(
  client: ExocortexApiClient,
  workspaceId: string,
  parentId: string | null | undefined,
): Promise<string> {
  try {
    const result = await client.request({
      method: 'GET',
      path: `/api/workspaces/${workspaceId}/documents/tree`,
      query: parentId == null ? { depth: 2 } : { parentId, depth: 2 },
      responseSchema: documentTreeResponseSchema,
    });
    const sections = result.nodes
      .filter((node: DocumentTreeNode) => node.children.length >= MIN_SECTION_CHILDREN)
      .sort((a, b) => b.children.length - a.children.length)
      .slice(0, MAX_HINTED_SECTIONS);
    if (sections.length === 0) return '';

    const where = parentId == null ? 'auf der obersten Ebene' : 'unter der gewählten Elternseite';
    const named = sections
      .map((section) => `${section.title} (${section.children.length}, id: ${section.id})`)
      .join(', ');
    return (
      ` Hinweis: ${where} gibt es bereits Unterbereiche: ${named}. ` +
      'Passt einer davon besser, verschieb die Seite mit exo_page_move dorthin; ' +
      'exo_page_suggest_parent nennt den wahrscheinlichsten.'
    );
  } catch {
    // A hint is a courtesy. The page was created either way, and saying so is
    // more important than explaining why the courtesy failed.
    return '';
  }
}

export const PLACEMENT_TOOLS: readonly AnyToolDefinition[] = [pageSuggestParentTool];
