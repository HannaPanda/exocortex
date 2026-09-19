import { z } from 'zod';

import { blockIdSchema, documentFragmentResponseSchema, idSchema } from '@exocortex/contracts';

import { truncateText } from '../format.js';
import { type AnyToolDefinition, defineTool } from '../tool.js';

/**
 * Reading part of a page (issue #78, ADR-045).
 *
 * The same endpoint the browser calls to render a placed transclusion, so an
 * agent sees exactly what a reader sees, and it is useful well beyond
 * transclusion: a long page can be read one section at a time instead of in one
 * 60,000 character answer.
 *
 * Writing a transclusion is not a tool of its own. It is a block on a page, so
 * it is written the way every other block is written: `exo_page_write` with
 * `:::transclusion Titel^blockid` in the Markdown. A second way in would be a
 * second definition of what a transclusion is.
 */

/** Blocks of the outline a single answer names before it says how many more. */
const MAX_OUTLINE_LINES = 60;

/** Characters of a fragment an answer carries. A block, not a page. */
const MAX_FRAGMENT_CHARS = 20_000;

export const pageBlockReadTool: AnyToolDefinition = defineTool({
  name: 'exo_page_block_read',
  description:
    'Liest einen einzelnen Block einer Seite statt der ganzen Seite. Ohne blockId listet das ' +
    'Werkzeug die adressierbaren Blöcke der Seite mit ihrer Kennung und einer Vorschau; mit ' +
    'blockId liefert es den Inhalt dieses Blocks als Markdown. ' +
    'Eine Überschrift adressiert ihren ganzen Abschnitt: die Überschrift und alles darunter bis ' +
    'zur nächsten Überschrift derselben oder einer höheren Ebene. ' +
    'Das ist auch die Adresse, mit der sich Inhalt einbetten lässt: ein Block ' +
    '":::transclusion <Seitentitel>^<blockId>" auf einer anderen Seite zeigt genau diesen ' +
    'Inhalt, ohne ihn zu kopieren, und ändert sich mit der Quelle mit.',
  inputSchema: z.object({
    documentId: idSchema,
    blockId: blockIdSchema.optional(),
  }),
  surfaces: ['mcp', 'ai'],
  mutating: false,
  async execute(client, input) {
    const result = await client.request({
      method: 'GET',
      path: `/api/documents/${input.documentId}/fragment`,
      query: { ...(input.blockId === undefined ? {} : { blockId: input.blockId }), outline: true },
      responseSchema: documentFragmentResponseSchema,
    });

    if (input.blockId !== undefined && !result.resolved) {
      return {
        text:
          `Die Seite „${result.title}“ hat keinen Block mit der Kennung ${input.blockId} mehr. ` +
          'Die Liste der vorhandenen Blöcke steht in den Daten dieses Aufrufs.',
        data: result,
      };
    }

    const nested =
      result.nested === 0
        ? ''
        : `\n\n(Enthält ${result.nested} weitere Einbettung(en), die hier nicht aufgelöst werden.)`;

    if (input.blockId === undefined) {
      const lines = result.blocks
        .slice(0, MAX_OUTLINE_LINES)
        .map((block) => {
          const kind = block.level === null ? block.type : `heading${block.level}`;
          return `- ${block.blockId} (${kind}): ${block.preview}`;
        })
        .join('\n');
      const more =
        result.blocks.length > MAX_OUTLINE_LINES
          ? `\n… und ${result.blocks.length - MAX_OUTLINE_LINES} weitere Blöcke`
          : '';
      return {
        text:
          result.blocks.length === 0
            ? `Die Seite „${result.title}“ hat keine adressierbaren Blöcke.`
            : `Blöcke der Seite „${result.title}“:\n${lines}${more}`,
        data: result,
      };
    }

    const { text } = truncateText(result.markdown, MAX_FRAGMENT_CHARS);
    return {
      text: `Block ${input.blockId} der Seite „${result.title}“:\n\n${text}${nested}`,
      data: result,
    };
  },
});

export const TRANSCLUSION_TOOLS: readonly AnyToolDefinition[] = [pageBlockReadTool];
