import { z } from 'zod';

import {
  type DocumentCoverContext,
  generateDocumentCoverResponseSchema,
  idSchema,
} from '@exocortex/contracts';

import { type AnyToolDefinition, defineTool } from '../tool.js';

/**
 * Drawing a page cover (ADR-090), split from `pages.ts` when the page context
 * of issue #224 made it a tool with a sentence of its own to say.
 */

const pageGenerateCoverInputSchema = z
  .object({
    documentId: idSchema,
    /** What to draw, in the user's own words. Any language. */
    prompt: z.string().trim().max(1_000).optional(),
    /** The same choice as "Kontext aus der Seite" in the browser (issue #224). */
    pageContext: z.boolean().optional(),
  })
  .refine((value) => value.pageContext === true || (value.prompt ?? '').length >= 3, {
    message: 'Entweder "prompt" (mindestens drei Zeichen) oder "pageContext": true angeben.',
    path: ['prompt'],
  });

/** What of the page went to the image model, in one sentence (issue #224). */
function coverContextLine(context: DocumentCoverContext | null): string {
  if (context === null) return '';
  const parts = ['der Titel'];
  if (context.topics.length > 0) parts.push(`die Hauptthemen ${context.topics.join(', ')}`);
  if (context.source === 'summary') parts.push('ihre Zusammenfassung');
  if (context.source === 'opening') parts.push('ihr Anfang');
  const last = parts.pop() as string;
  const list = parts.length === 0 ? last : `${parts.join(', ')} und ${last}`;
  return ` Aus der Seite gingen mit: ${list}.`;
}

export const pageGenerateCoverTool: AnyToolDefinition = defineTool({
  name: 'exo_page_generate_cover',
  description:
    'Lässt die KI ein Titelbild für eine Seite malen und setzt es. Das Bild entsteht im ' +
    'Hintergrund und ist nicht sofort fertig: der Aufruf bestätigt nur den Auftrag. ' +
    'Braucht ein eingerichtetes Bildmodell, sonst antwortet die API mit ai_image_unavailable. ' +
    'Es zahlt der Arbeitsbereich der Seite; auf einer nur geteilten Seite dein eigener (im Chat ' +
    'der des Chats, sonst dein erster; ohne einen: ai_image_no_own_workspace). Geteilt reicht ' +
    'eine Freigabe zum Bearbeiten, auch für die Seite allein. Mit pageContext: true geht ' +
    'zusätzlich gekürzt mit, worum es auf der Seite geht (Titel, Überschriften als ' +
    'Hauptthemen, Zusammenfassung oder Anfang; nie Code und nie Anhänge); dann darf prompt ' +
    'fehlen. Die Antwort nennt, was davon an das Bildmodell ging.',
  inputSchema: pageGenerateCoverInputSchema,
  surfaces: ['mcp', 'ai'],
  domain: 'appearance',
  mutating: true,
  target: (input) => `document:${input.documentId}`,
  async execute(client, input) {
    const result = await client.request({
      method: 'POST',
      path: `/api/documents/${input.documentId}/cover/generate`,
      body: { prompt: input.prompt ?? '', pageContext: input.pageContext ?? false },
      responseSchema: generateDocumentCoverResponseSchema,
    });
    return {
      text:
        `Titelbild wird erzeugt für Seite ${result.documentId}. Es erscheint, sobald es fertig ist.` +
        coverContextLine(result.pageContext),
      data: result,
    };
  },
});
