import { z } from 'zod';

import {
  agentSessionDetailResponseSchema,
  agentSessionListResponseSchema,
  idSchema,
} from '@exocortex/contracts';

import { renderMarkdownTable } from '../format.js';
import { type AnyToolDefinition, defineTool } from '../tool.js';

/**
 * What an agent can find out about its own work (issue #49, ADR-022).
 *
 * Read-only on purpose, and the bulk revert is deliberately absent from the
 * catalogue: an agent that can take back a whole afternoon in one call is a
 * new way to lose work, and the question the revert answers -- "was this a
 * mistake" -- is not one the agent that made it is in a position to judge. A
 * person presses that button in the admin area.
 */

const MAX_LISTED_WRITES = 50;

export const agentSessionListTool: AnyToolDefinition = defineTool({
  name: 'exo_agent_session_list',
  description:
    'Listet die eigenen Agenten-Sitzungen mit Umfang und Zeitraum: welcher Client, ' +
    'wie viele Schreibvorgänge, wie viele Seiten. Als Administrator alle Sitzungen der Installation.',
  inputSchema: z.object({}),
  surfaces: ['mcp', 'ai'],
  mutating: false,
  async execute(client) {
    const result = await client.request({
      method: 'GET',
      path: '/api/agent-sessions',
      responseSchema: agentSessionListResponseSchema,
    });
    if (result.sessions.length === 0) {
      return { text: 'Keine Agenten-Sitzungen aufgezeichnet.', data: result };
    }
    const text = renderMarkdownTable(
      ['id', 'Client', 'Zuletzt', 'Schreibvorgänge', 'Seiten'],
      result.sessions.map((session) => [
        session.id,
        session.clientLabel ?? session.externalId,
        session.lastSeenAt,
        String(session.writeCount),
        String(session.documentCount),
      ]),
    );
    return { text, data: result };
  },
});

export const agentSessionGetTool: AnyToolDefinition = defineTool({
  name: 'exo_agent_session_get',
  description:
    'Zeigt, welche Seiten eine Agenten-Sitzung angefasst hat, in welcher Reihenfolge ' +
    'und ob es zu jedem Schreibvorgang einen Stand davor gibt.',
  inputSchema: z.object({ sessionId: idSchema }),
  surfaces: ['mcp', 'ai'],
  mutating: false,
  async execute(client, input) {
    const result = await client.request({
      method: 'GET',
      path: `/api/agent-sessions/${input.sessionId}`,
      responseSchema: agentSessionDetailResponseSchema,
    });
    const header =
      `${result.session.clientLabel ?? result.session.externalId}: ` +
      `${String(result.session.writeCount)} Schreibvorgänge auf ${String(result.session.documentCount)} Seiten, ` +
      `zuletzt ${result.session.lastSeenAt}.`;
    if (result.writes.length === 0) {
      return { text: `${header}\n\nKeine Schreibvorgänge aufgezeichnet.`, data: result };
    }
    const table = renderMarkdownTable(
      ['Zeitpunkt', 'Seite', 'documentId', 'Vorgang', 'Stand davor'],
      result.writes
        .slice(0, MAX_LISTED_WRITES)
        .map((write) => [
          write.createdAt,
          write.documentTitle ?? '(gelöscht)',
          write.documentId,
          write.action,
          write.snapshotBeforeId === null ? 'nein' : 'ja',
        ]),
    );
    return { text: `${header}\n\n${table}`, data: result };
  },
});

export const AGENT_SESSION_TOOLS: readonly AnyToolDefinition[] = [
  agentSessionListTool,
  agentSessionGetTool,
];
