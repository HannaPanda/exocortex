import { z } from 'zod';

import { blockIdSchema, documentFragmentResponseSchema, idSchema } from '@exocortex/contracts';

import {
  PAGE_CONTENT_BUDGET_CHARS,
  PAGE_MAP_MAX_ENTRIES,
  renderDocumentMap,
  truncateText,
} from '../format.js';
import { type AnyToolDefinition, defineTool } from '../tool.js';

/**
 * Reading part of a page (issue #78, ADR-045; extended by issue #118).
 *
 * The same endpoint the browser calls to render a placed transclusion, so an
 * agent sees exactly what a reader sees, and it is useful well beyond
 * transclusion: it is how a page of any size is read at all.
 *
 * Three answers, one tool, because they are three depths of one question:
 * without a block it is the page's map, with a block it is that section, and
 * with a section too large for the budget it is that section's map. The
 * recursion has a floor in `buildDocumentMap`: a part without inner headings
 * is mapped as block ranges, which is what `toBlockId` reads back.
 *
 * Writing a transclusion is not a tool of its own. It is a block on a page, so
 * it is written the way every other block is written: `exo_page_write` with
 * `:::transclusion Titel^blockid` in the Markdown. A second way in would be a
 * second definition of what a transclusion is.
 */

/** Blocks of the flat list a single answer names before it says how many more. */
const MAX_OUTLINE_LINES = 60;

/** Characters of a fragment an answer carries. A block, not a page. */
const MAX_FRAGMENT_CHARS = 20_000;

export const pageBlockReadTool: AnyToolDefinition = defineTool({
  name: 'exo_page_block_read',
  description:
    'Liest einen Teil einer Seite statt der ganzen Seite. Ohne blockId antwortet das Werkzeug ' +
    'mit der Karte der Seite: ihre Abschnitte mit Überschrift, Größe und Blockkennung. Mit ' +
    'blockId liefert es den Inhalt dieses Abschnitts als Markdown, und wenn der selbst zu groß ' +
    'ist, wieder eine Karte davon. Hat ein Teil keine Überschriften mehr, nennt die Karte ' +
    'Blockfenster: die liest man mit blockId und toBlockId zusammen. ' +
    'Eine Überschrift adressiert ihren ganzen Abschnitt: die Überschrift und alles darunter bis ' +
    'zur nächsten Überschrift derselben oder einer höheren Ebene. ' +
    'Mit blocks: true kommt statt der Karte die flache Liste aller adressierbaren Blöcke mit ' +
    'Vorschau, was für eine lange Seite viel und meistens zu viel ist. ' +
    'Das ist auch die Adresse, mit der sich Inhalt einbetten lässt: ein Block ' +
    '":::transclusion <Seitentitel>^<blockId>" auf einer anderen Seite zeigt genau diesen ' +
    'Inhalt, ohne ihn zu kopieren, und ändert sich mit der Quelle mit.',
  inputSchema: z.object({
    documentId: idSchema,
    blockId: blockIdSchema.optional(),
    toBlockId: blockIdSchema.optional(),
    blocks: z.boolean().optional(),
  }),
  surfaces: ['mcp', 'ai'],
  mutating: false,
  async execute(client, input) {
    const wantsFlatList = input.blocks === true && input.blockId === undefined;
    const result = await client.request({
      method: 'GET',
      path: `/api/documents/${input.documentId}/fragment`,
      query: {
        ...(input.blockId === undefined ? {} : { blockId: input.blockId }),
        ...(input.toBlockId === undefined ? {} : { toBlockId: input.toBlockId }),
        // Without a block the caller is navigating, so the structure is the
        // answer whatever the page weighs. With one it wants the content, and
        // only its size decides.
        ...(input.blockId === undefined && !wantsFlatList ? { want: 'map' } : {}),
        ...(wantsFlatList ? { outline: 'true' } : {}),
        maxChars: String(PAGE_CONTENT_BUDGET_CHARS),
        maxEntries: String(PAGE_MAP_MAX_ENTRIES),
      },
      responseSchema: documentFragmentResponseSchema,
    });

    if (input.blockId !== undefined && !result.resolved) {
      return {
        text:
          `Die Seite „${result.title}“ hat keinen Block mit der Kennung ${input.blockId} mehr` +
          (input.toBlockId === undefined ? '' : ` (oder ${input.toBlockId} liegt nicht daneben)`) +
          '. Ohne blockId nennt dieser Aufruf die Karte der Seite mit den gültigen Kennungen.',
        data: result,
      };
    }

    if (wantsFlatList) {
      const lines = result.blocks
        .slice(0, MAX_OUTLINE_LINES)
        .map((block) => {
          const kind = block.level === null ? block.type : `heading${block.level}`;
          return `- ${block.blockId} (${kind}): ${block.preview}`;
        })
        .join('\n');
      const more =
        result.blocks.length > MAX_OUTLINE_LINES
          ? `\n… und ${result.blocks.length - MAX_OUTLINE_LINES} weitere Blöcke. Die Karte ` +
            '(derselbe Aufruf ohne blocks) ist vollständig und kürzer.'
          : '';
      return {
        text:
          result.blocks.length === 0
            ? `Die Seite „${result.title}“ hat keine adressierbaren Blöcke.`
            : `Blöcke der Seite „${result.title}“:\n${lines}${more}`,
        data: result,
      };
    }

    if (result.view === 'map' && result.map !== null) {
      const lead =
        input.blockId === undefined
          ? `Karte der Seite „${result.title}“`
          : `Der Teil ${input.blockId} der Seite „${result.title}“ ist groß`;
      return { text: renderDocumentMap(result.map, lead), data: result };
    }

    const nested =
      result.nested === 0
        ? ''
        : `\n\n(Enthält ${result.nested} weitere Einbettung(en), die hier nicht aufgelöst werden.)`;
    const { text } = truncateText(result.markdown, MAX_FRAGMENT_CHARS);
    const what =
      input.blockId === undefined
        ? `Seite „${result.title}“`
        : `Block ${input.blockId} der Seite „${result.title}“`;
    return { text: `${what}:\n\n${text}${nested}`, data: result };
  },
});

export const TRANSCLUSION_TOOLS: readonly AnyToolDefinition[] = [pageBlockReadTool];
