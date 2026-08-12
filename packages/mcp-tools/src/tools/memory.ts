import { z } from 'zod';

import { memoryRecallResponseSchema, memoryRememberResponseSchema } from '@exocortex/contracts';

import { type AnyToolDefinition, defineTool } from '../tool.js';

/**
 * The memory surface for chat clients (issue #34, AP3).
 *
 * Three tools where the full catalogue has forty-six, for the same reason the
 * research surface has two: a chat model handed dozens of tools picks the wrong
 * one, and the thing it should reach for here is always one of "what do we know
 * already", "keep this" and "show me that page in full".
 *
 * They are not a second implementation of anything. `recall` is
 * `GET /api/memory/recall`, `remember` is `POST /api/memory/remember`, and
 * `fetch` is the research surface's own tool, shared rather than copied. What
 * differs from `exo_search` is the answer, not the query: a handful of
 * distilled lines with an id, never a raw index dump a chat window then has to
 * carry for the rest of the conversation.
 *
 * The names carry no `exo_` prefix, unlike every tool on the full catalogue.
 * That prefix exists so a coding agent running several MCP servers side by side
 * cannot get them confused; this surface is configured on its own URL by
 * somebody who wants exactly a memory, and `recall` is the word the model
 * reaches for.
 */

/** Where a memory lands when the client has no project of its own. */
const DEFAULT_PROJECT = 'Allgemein';

export const recallTool: AnyToolDefinition = defineTool({
  name: 'recall',
  description:
    'Durchsucht das Gedächtnis: frühere Arbeitssitzungen der Agenten und das gepflegte Wissen ' +
    'in eXocortex. Liefert wenige, kurze Treffer mit id. Vor einer Antwort aufrufen, wenn die ' +
    'Frage sich auf frühere Arbeit, Entscheidungen, Zugänge oder Einrichtungen bezieht. ' +
    'Den vollen Text einer interessanten Seite lädt anschließend fetch mit derselben id.',
  inputSchema: z.object({
    query: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .optional()
      .describe('Wonach gesucht wird. Weglassen liefert die neuesten Notizen zum Projekt.'),
    project: z
      .string()
      .trim()
      .min(1)
      .max(300)
      .optional()
      .describe('Projekt oder Arbeitsverzeichnis, falls bekannt. Gewichtet passende Treffer höher.'),
    limit: z.number().int().min(1).max(20).optional().describe('Höchstzahl der Treffer'),
  }),
  surfaces: ['memory'],
  mutating: false,
  async execute(client, input) {
    const response = await client.request({
      method: 'GET',
      path: '/api/memory/recall',
      query: {
        ...(input.query === undefined ? {} : { q: input.query }),
        ...(input.project === undefined ? {} : { project: input.project }),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      },
      responseSchema: memoryRecallResponseSchema,
    });
    return { text: response.text, data: response };
  },
});

export const rememberTool: AnyToolDefinition = defineTool({
  name: 'remember',
  description:
    'Legt eine Erinnerung im Gedächtnis der Agenten ab, damit eine spätere Sitzung sie ' +
    'wiederfindet. Für Entscheidungen, Fakten, Zugänge und offene Punkte, nicht für den ' +
    'Gesprächsverlauf. Kurz und in Stichpunkten schreiben.',
  inputSchema: z.object({
    text: z.string().trim().min(1).max(20_000).describe('Die Erinnerung selbst, als Markdown'),
    title: z.string().trim().min(1).max(200).optional().describe('Überschrift der Notiz'),
    project: z
      .string()
      .trim()
      .min(1)
      .max(300)
      .optional()
      .describe('Projekt oder Arbeitsverzeichnis. Weglassen legt unter „Allgemein“ ab.'),
    tags: z.array(z.string().trim().min(1).max(40)).max(10).optional().describe('Schlagworte'),
  }),
  surfaces: ['memory'],
  mutating: true,
  // The project page, not the note: a chat client writes several memories per
  // conversation, and the destination it is being asked to confirm is where
  // they land, not the day-page that does not exist yet.
  target: (input) => `memory:${input.project ?? DEFAULT_PROJECT}`,
  async execute(client, input) {
    const response = await client.request({
      method: 'POST',
      path: '/api/memory/remember',
      body: {
        project: input.project ?? DEFAULT_PROJECT,
        text: input.text,
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.tags === undefined ? {} : { tags: input.tags }),
        // Several small memories from one conversation belong on one page; a
        // page per thought would bury the project page in stubs.
        appendToday: true,
      },
      responseSchema: memoryRememberResponseSchema,
    });
    return {
      text: response.appended
        ? `Zur Notiz „${response.title}“ hinzugefügt.`
        : `Als „${response.title}“ gemerkt.`,
      data: response,
    };
  },
});

export const MEMORY_TOOLS: readonly AnyToolDefinition[] = [recallTool, rememberTool];
