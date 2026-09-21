import { z } from 'zod';

import {
  blockIdSchema,
  documentBlockWriteRequestSchema,
  type DocumentGranularWriteResponse,
  documentGranularWriteResponseSchema,
  documentPatchRequestSchema,
  documentSectionWriteRequestSchema,
  extractSectionRequestSchema,
  extractSectionResponseSchema,
  idSchema,
} from '@exocortex/contracts';

import { type AnyToolDefinition, defineTool } from '../tool.js';

/**
 * Editing part of a page instead of rewriting it (issue #111).
 *
 * `exo_page_write` has one shape: here is what the page should say. For a page
 * of thirty thousand characters that is the wrong shape for almost everything
 * an agent does to it -- correcting a line, adding a paragraph under a heading,
 * refreshing one section -- because it costs the whole page twice in tokens,
 * gives every block on the page a new identifier on the way through, and
 * silently discards whatever somebody else wrote while the agent was thinking.
 *
 * These three do the same work through the addressing the page already has.
 * `exo_page_block_read` lists a page's block identifiers, and `exo_page_read`
 * with includeBlockIds writes them into the Markdown, so the address is always
 * one read away.
 */

/** The one sentence that says where the addresses come from. */
const WHERE_BLOCK_IDS_COME_FROM =
  'Blockkennungen kommen aus exo_page_block_read (ohne blockId listet es alle Blöcke der Seite) ' +
  'oder aus exo_page_read mit includeBlockIds: true, das sie als "^kennung" hinter jeden Block ' +
  'schreibt.';

/** Turns the shared response into the sentence all three answer with. */
function writtenText(documentId: string, result: DocumentGranularWriteResponse): string {
  const live = result.appliedToLiveSession
    ? ' Die Seite war geöffnet; die Änderung ist dort sofort sichtbar.'
    : '';
  const warnings = result.warnings.length > 0 ? ` Warnungen: ${result.warnings.join('; ')}` : '';
  const blocks = result.blockIds.length === 0 ? '' : ` Neue Blöcke: ${result.blockIds.join(', ')}.`;
  return (
    `Seite ${documentId} an Ort und Stelle geändert (Snapshot ${result.snapshotId} zum ` +
    `Zurückrollen).${blocks}${live}${warnings}`
  );
}

export const pageBlockWriteTool: AnyToolDefinition = defineTool({
  name: 'exo_page_block_update',
  description:
    'Ersetzt genau einen Block einer Seite, oder setzt etwas davor oder dahinter. Der Rest der ' +
    'Seite bleibt unangetastet: gleiche Blockkennungen, gleiche Reihenfolge, und was jemand ' +
    'anderes in der Zwischenzeit geschrieben hat, bleibt stehen. Das ist der richtige Weg für ' +
    'eine kleine Änderung an einer langen Seite; exo_page_write mit "replace" schreibt dafür die ' +
    'ganze Seite neu. ' +
    'mode "replace" tauscht den Block aus, "append" setzt den neuen Inhalt dahinter, "prepend" ' +
    'davor. Eine Überschrift meint hier nur sich selbst, nicht ihren Abschnitt; dafür gibt es ' +
    'exo_page_section_write. ' +
    'Mit expectedYjsUpdatedAt (aus exo_page_read) schlägt der Aufruf fehl, statt eine ' +
    'zwischenzeitliche Änderung zu überschreiben. ' +
    WHERE_BLOCK_IDS_COME_FROM,
  inputSchema: z
    .object({ documentId: idSchema })
    .extend(documentBlockWriteRequestSchema.shape)
    .extend({ blockId: blockIdSchema }),
  surfaces: ['mcp', 'ai'],
  mutating: true,
  // Not `destructive`: this replaces one block a caller named, where
  // `exo_page_write` replaces a page a caller may not have read. The
  // confirmation gate exists for the second kind (docs/mcp.md).
  target: (input) => `document:${input.documentId}`,
  async execute(client, input) {
    const { documentId, ...body } = input;
    const result = await client.request({
      method: 'POST',
      path: `/api/documents/${documentId}/content/block`,
      body,
      responseSchema: documentGranularWriteResponseSchema,
    });
    return { text: writtenText(documentId, result), data: result };
  },
});

export const pagePatchTool: AnyToolDefinition = defineTool({
  name: 'exo_page_patch',
  description:
    'Ersetzt eine Textstelle auf einer Seite, ohne den Rest anzufassen. oldText wird im Markdown ' +
    'der Seite gesucht, also genau in dem Text, den exo_page_read ausgibt: eine Zeile von dort ' +
    'kopieren und hier einsetzen. ' +
    'Kommt oldText gar nicht oder mehrfach vor, wird NICHTS geschrieben und der Aufruf meldet, ' +
    'wie oft er den Text gefunden hat. Mehrfach ersetzen geht nur mit replaceAll: true, und das ' +
    'ist eine bewusste Entscheidung, keine Bequemlichkeit. ' +
    'Für eine Änderung, die sich nicht als eindeutige Textstelle sagen lässt, ist ' +
    'exo_page_block_update der genauere Weg.',
  inputSchema: z.object({ documentId: idSchema }).extend(documentPatchRequestSchema.shape),
  surfaces: ['mcp', 'ai'],
  mutating: true,
  target: (input) => `document:${input.documentId}`,
  async execute(client, input) {
    const { documentId, ...body } = input;
    const result = await client.request({
      method: 'POST',
      path: `/api/documents/${documentId}/content/patch`,
      body,
      responseSchema: documentGranularWriteResponseSchema,
    });
    const count = result.replacements === 1 ? '' : ` ${result.replacements} Fundstellen ersetzt.`;
    return { text: `${writtenText(documentId, result)}${count}`, data: result };
  },
});

export const pageSectionWriteTool: AnyToolDefinition = defineTool({
  name: 'exo_page_section_write',
  description:
    'Schreibt unter eine Überschrift, ohne den Rest der Seite anzufassen. Der Abschnitt ist die ' +
    'Überschrift und alles darunter bis zur nächsten Überschrift derselben oder einer höheren ' +
    'Ebene. ' +
    'mode "replace" ersetzt den Inhalt des Abschnitts und lässt die Überschrift stehen (sie ist ' +
    'die Adresse), "append" hängt ans Ende des Abschnitts an, "prepend" setzt direkt unter die ' +
    'Überschrift. ' +
    'Der Text der Überschrift wird ohne Rücksicht auf Groß- und Kleinschreibung verglichen. ' +
    'Kommt er mehrfach vor, wird nichts geschrieben und der Aufruf nennt die Blockkennungen der ' +
    'Kandidaten; dann ist exo_page_block_update mit einer davon der eindeutige Weg.',
  inputSchema: z.object({ documentId: idSchema }).extend(documentSectionWriteRequestSchema.shape),
  surfaces: ['mcp', 'ai'],
  mutating: true,
  target: (input) => `document:${input.documentId}`,
  async execute(client, input) {
    const { documentId, ...body } = input;
    const result = await client.request({
      method: 'POST',
      path: `/api/documents/${documentId}/content/section`,
      body,
      responseSchema: documentGranularWriteResponseSchema,
    });
    return { text: writtenText(documentId, result), data: result };
  },
});

export const pageExtractSectionTool: AnyToolDefinition = defineTool({
  name: 'exo_page_extract_section',
  description:
    'Verschiebt einen Abschnitt einer Seite auf eine eigene Seite: legt die neue Seite an, ' +
    'nimmt den Inhalt aus der alten heraus und hinterlässt dort einen Verweis. Ein Aufruf statt ' +
    'sechs, und die Seiteninhalte laufen dabei nicht durch den Kontext. ' +
    'blockId ist die Kennung der Überschrift, die den Abschnitt benennt; sie adressiert alles ' +
    'darunter bis zur nächsten Überschrift derselben oder einer höheren Ebene. Für ein Stück ohne ' +
    'Überschrift zusätzlich toBlockId angeben, dann werden genau diese Blöcke verschoben. Beide ' +
    'Kennungen stehen in der Karte, die exo_page_block_read ausgibt. ' +
    'Die Überschrift bleibt auf der alten Seite stehen und trägt darunter den Verweis, damit die ' +
    'Gliederung erhalten bleibt. replacement "link" hinterlässt einen Seitenverweis (Standard), ' +
    '"transclusion" bettet die neue Seite ein, sodass Lesende denselben Text weiter an derselben ' +
    'Stelle sehen, "remove" nimmt Abschnitt und Überschrift ersatzlos heraus. ' +
    'Ohne title heißt die neue Seite wie die Überschrift; ohne parentId hängt sie unter der ' +
    'Seite, aus der der Abschnitt stammt. Mit targetDocumentId wandert der Abschnitt stattdessen ' +
    'ans Ende einer vorhandenen Seite. ' +
    'Vor dem Schreiben wird ein Snapshot der Quellseite angelegt; der Aufruf nennt ihn.',
  inputSchema: z.object({ documentId: idSchema }).extend(extractSectionRequestSchema.shape),
  surfaces: ['mcp', 'ai'],
  mutating: true,
  target: (input) => `document:${input.documentId}`,
  async execute(client, input) {
    const { documentId, ...body } = input;
    const result = await client.request({
      method: 'POST',
      path: `/api/documents/${documentId}/content/extract-section`,
      body,
      responseSchema: extractSectionResponseSchema,
    });
    const where = result.created
      ? `Neue Seite „${result.document.title}“ (${result.document.id})`
      : `An Seite „${result.document.title}“ (${result.document.id}) angehängt`;
    const left =
      result.replacement === 'remove'
        ? 'Auf der Quellseite steht an der Stelle nichts mehr.'
        : result.replacement === 'transclusion'
          ? 'Die Quellseite bindet den Abschnitt jetzt von dort ein.'
          : 'Die Quellseite verweist jetzt dorthin.';
    const warnings = result.warnings.length > 0 ? ` Warnungen: ${result.warnings.join('; ')}` : '';
    return {
      text:
        `${where}: ${result.movedBlocks} Blöcke, ${result.movedChars} Zeichen. ${left} ` +
        `Snapshot ${result.snapshotId} rollt die Quellseite zurück.${warnings}`,
      data: result,
    };
  },
});

export const PAGE_EDIT_TOOLS: readonly AnyToolDefinition[] = [
  pageBlockWriteTool,
  pagePatchTool,
  pageSectionWriteTool,
  pageExtractSectionTool,
];
