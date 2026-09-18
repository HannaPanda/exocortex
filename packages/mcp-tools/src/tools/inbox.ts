import { z } from 'zod';

import {
  captureRequestSchema,
  captureResponseSchema,
  idSchema,
  inboxResponseSchema,
} from '@exocortex/contracts';

import { truncateText } from '../format.js';
import { type AnyToolDefinition, defineTool } from '../tool.js';

import { formatDocumentSummary } from './page-render.js';

/** How many waiting entries the answer names before it falls back to the count. */
const MAX_LISTED_ITEMS = 25;

export const captureTool: AnyToolDefinition = defineTool({
  name: 'exo_capture',
  description:
    'Erfasst einen Gedanken, einen Textschnipsel oder einen Link, ohne vorher zu entscheiden, ' +
    'wohin er gehört: der Eintrag landet im Eingang des Arbeitsbereichs und wird später ' +
    'einsortiert. Genau dafür ist das Werkzeug da, wenn der Ort unklar ist oder es schnell ' +
    'gehen soll. Weißt du dagegen, wo etwas hingehört, nimm exo_page_create mit parentId, und ' +
    'für längere ausgearbeitete Seiten ohnehin. Die erste Zeile des Textes wird zum Titel, ' +
    'sofern du keinen mitgibst. Es entsteht eine gewöhnliche Seite: durchsuchbar, verlinkbar, ' +
    'mit exo_page_move verschiebbar.',
  inputSchema: z.object({ workspaceId: idSchema }).extend(captureRequestSchema.shape),
  surfaces: ['mcp', 'ai'],
  mutating: true,
  target: (input) => `workspace:${input.workspaceId}`,
  async execute(client, input) {
    const { workspaceId, ...body } = input;
    const result = await client.request({
      method: 'POST',
      path: `/api/workspaces/${workspaceId}/capture`,
      body,
      responseSchema: captureResponseSchema,
    });
    const where =
      result.parent === null
        ? 'auf oberster Ebene'
        : `im Eingang "${result.parent.title}" (parentId: ${result.parent.id})`;
    const created = result.inboxCreated ? ' Der Eingang wurde dabei neu angelegt.' : '';
    return {
      text:
        `Erfasst ${where}: ${formatDocumentSummary(result.document)}.${created} ` +
        'Einsortieren später mit exo_page_suggest_parent und exo_page_move.',
      data: result,
    };
  },
});

export const inboxTool: AnyToolDefinition = defineTool({
  name: 'exo_inbox',
  description:
    'Zeigt den Eingang eines Arbeitsbereichs: die mit exo_capture oder im Browser erfassten ' +
    'Notizen, die noch nicht einsortiert sind, neueste zuerst. Gibt es keinen Eingang, wurde ' +
    'in diesem Arbeitsbereich noch nie etwas erfasst. Zum Aufräumen: exo_page_read liest einen ' +
    'Eintrag, exo_page_suggest_parent schlägt den Ort vor, exo_page_move verschiebt ihn dorthin.',
  inputSchema: z.object({
    workspaceId: idSchema,
    limit: z.number().int().min(1).max(100).optional(),
  }),
  surfaces: ['mcp', 'ai'],
  mutating: false,
  async execute(client, input) {
    const result = await client.request({
      method: 'GET',
      path: `/api/workspaces/${input.workspaceId}/inbox`,
      query: { limit: input.limit ?? MAX_LISTED_ITEMS },
      responseSchema: inboxResponseSchema,
    });
    if (result.inbox === null) {
      return {
        text:
          'Dieser Arbeitsbereich hat keinen Eingang: hier wurde noch nichts erfasst. ' +
          'Der erste exo_capture legt ihn an.',
        data: result,
      };
    }
    if (result.items.length === 0) {
      return {
        text: `Der Eingang "${result.inbox.title}" (id: ${result.inbox.id}) ist leer.`,
        data: result,
      };
    }
    const lines = result.items.map(
      (item) =>
        `- ${truncateText(item.title, 120).text} (id: ${item.id}, erfasst: ${item.createdAt})`,
    );
    const omitted = result.itemCount - result.items.length;
    const more = omitted > 0 ? `\n… und ${omitted} weitere.` : '';
    return {
      text:
        `Eingang "${result.inbox.title}" (id: ${result.inbox.id}), ` +
        `${result.itemCount} Eintrag/Einträge:\n${lines.join('\n')}${more}`,
      data: result,
    };
  },
});

export const INBOX_TOOLS: readonly AnyToolDefinition[] = [captureTool, inboxTool];
