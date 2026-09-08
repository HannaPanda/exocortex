import { z } from 'zod';

import {
  memoryFactListResponseSchema,
  memoryFactPromoteResponseSchema,
} from '@exocortex/contracts';

import { type AnyToolDefinition, defineTool } from '../tool.js';

/**
 * The distilled layer of the memory, as a tool (issue #46).
 *
 * `recall` already puts the current facts of a project in front of its hits, so
 * an agent that only wants "what is true here" needs nothing new. These two are
 * for the other two questions: reading the bookkeeping behind a fact (how often
 * it was confirmed, what it replaced, whether it is contradicted), and moving a
 * fact that has proven itself out of the agents' area into the curated brain.
 *
 * Applying verdicts is deliberately *not* a tool. That endpoint rewrites what
 * the memory believes in one call, and it exists for the nightly job that has
 * read the notes to judge them; a model able to call it directly could rewrite
 * its own past without any note ever saying so.
 */

export const memoryFactsTool: AnyToolDefinition = defineTool({
  name: 'exo_memory_facts',
  description:
    'Listet die verdichteten Fakten, die das Gedächtnis für ein Projekt hält: Aussagen, die ' +
    'gelten, bis eine spätere Notiz sie ersetzt. Mit Gewicht, Zahl der Bestätigungen und ' +
    'Status. Nützlich, um zu prüfen, was das Gedächtnis über ein Projekt annimmt, und um ' +
    'Widersprüche zu finden, die jemand auflösen muss.',
  inputSchema: z.object({
    project: z
      .string()
      .trim()
      .min(1)
      .max(300)
      .optional()
      .describe('Projekt oder Arbeitsverzeichnis. Weglassen listet über alle Projekte.'),
    status: z
      .enum(['current', 'superseded', 'conflicted'])
      .optional()
      .describe(
        'Welcher Zustand. Standard: current. conflicted zeigt, wo sich Notizen widersprechen, ' +
          'superseded, was einmal galt.',
      ),
    limit: z.number().int().min(1).max(100).optional().describe('Höchstzahl der Fakten'),
  }),
  surfaces: ['mcp', 'ai'],
  mutating: false,
  async execute(client, input) {
    const response = await client.request({
      method: 'GET',
      path: '/api/memory/facts',
      query: {
        ...(input.project === undefined ? {} : { project: input.project }),
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      },
      responseSchema: memoryFactListResponseSchema,
    });

    if (response.facts.length === 0) {
      return { text: 'Keine verdichteten Fakten für dieses Projekt.', data: response };
    }

    const lines = response.facts.map((fact) => {
      const marks = [
        `${Math.round(fact.confidence * 100)} %`,
        `${fact.confirmations}× bestätigt`,
        fact.status === 'current' ? null : fact.status === 'superseded' ? 'überholt' : 'Widerspruch',
      ].filter((mark): mark is string => mark !== null);
      return `- ${fact.statement} (${marks.join(', ')}, id: ${fact.id})`;
    });
    return { text: lines.join('\n'), data: response };
  },
});

export const memoryFactPromoteTool: AnyToolDefinition = defineTool({
  name: 'exo_memory_fact_promote',
  description:
    'Übernimmt einen verdichteten Fakt aus dem Gedächtnis der Agenten als Seite in einen ' +
    'gepflegten Arbeitsbereich. Für Fakten, die sich als dauerhaft erwiesen haben. Der ' +
    'Gedächtnisbereich darf aufgeräumt werden, ein gepflegter Bereich nicht: diesen Schritt ' +
    'nur gehen, wenn der Fakt das wert ist.',
  inputSchema: z.object({
    factId: z.string().trim().min(1).max(64).describe('Id des Fakts aus exo_memory_facts'),
    workspaceId: z.string().trim().min(1).max(64).describe('Zielarbeitsbereich'),
    parentId: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .optional()
      .describe('Seite, unter die der Fakt gehängt wird. Weglassen legt ihn oben ab.'),
  }),
  surfaces: ['mcp', 'ai'],
  mutating: true,
  target: (input) => `memory-fact:${input.factId}`,
  async execute(client, input) {
    const response = await client.request({
      method: 'POST',
      path: `/api/memory/facts/${encodeURIComponent(input.factId)}/promote`,
      body: {
        workspaceId: input.workspaceId,
        parentId: input.parentId ?? null,
      },
      responseSchema: memoryFactPromoteResponseSchema,
    });
    return {
      text: response.alreadyPromoted
        ? `Der Fakt war schon übernommen: „${response.title}“.`
        : `Als „${response.title}“ übernommen.`,
      data: response,
    };
  },
});

export const MEMORY_FACT_TOOLS: readonly AnyToolDefinition[] = [
  memoryFactsTool,
  memoryFactPromoteTool,
];
