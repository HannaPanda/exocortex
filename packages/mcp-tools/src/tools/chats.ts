import { z } from 'zod';

import {
  aiConversationDetailResponseSchema,
  aiConversationListResponseSchema,
  aiConversationSearchResponseSchema,
  idSchema,
} from '@exocortex/contracts';

import { renderMarkdownTable } from '../format.js';
import { type AnyToolDefinition, defineTool } from '../tool.js';

/**
 * Finding one's own chat history again (issue #69).
 *
 * The catalogue used to exempt the whole `/api/ai/conversations` family with
 * one reason: the caller of a tool is itself the assistant in a conversation.
 * That is true of *writing* -- starting a run from inside a run is a loop, and
 * posting a message into a transcript from inside that transcript is worse --
 * and it was never true of reading. An agent that cannot look up what was
 * decided three weeks ago asks the person to repeat it, which is exactly the
 * problem the `/chats` area exists to solve.
 *
 * Read-only, all three of them. The exemption for the writing half stands.
 */

const MAX_LISTED = 40;
const MAX_TRANSCRIPT_MESSAGES = 200;

const archivedDescription =
  'Welche Hälfte: open (Standard, nur offene), archived (nur archivierte), all.';

export const chatListTool: AnyToolDefinition = defineTool({
  name: 'exo_chat_list',
  description:
    'Listet die eigenen KI-Unterhaltungen über alle Arbeitsbereiche hinweg: Titel, erste Frage, ' +
    'Arbeitsbereich, Seite, Modell und Zeitpunkt. Ohne workspaceId kommen sie aus allen ' +
    'Arbeitsbereichen, in denen der Aufrufer Mitglied ist.',
  inputSchema: z.object({
    workspaceId: idSchema.optional().describe('Nur Unterhaltungen dieses Arbeitsbereichs.'),
    documentId: idSchema.optional().describe('Nur Unterhaltungen zu dieser Seite.'),
    archived: z.enum(['open', 'archived', 'all']).optional().describe(archivedDescription),
    limit: z.number().int().min(1).max(100).optional().describe('Höchstzahl der Einträge'),
    cursor: z.string().min(1).max(200).optional().describe('Weiterblättern: nextCursor von zuvor.'),
  }),
  surfaces: ['mcp', 'ai'],
  mutating: false,
  async execute(client, input) {
    const result = await client.request({
      method: 'GET',
      path: '/api/ai/conversations',
      query: {
        ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
        ...(input.documentId === undefined ? {} : { documentId: input.documentId }),
        ...(input.archived === undefined ? {} : { archived: input.archived }),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      },
      responseSchema: aiConversationListResponseSchema,
    });
    if (result.conversations.length === 0) {
      return { text: 'Keine Unterhaltungen gefunden.', data: result };
    }
    const table = renderMarkdownTable(
      ['id', 'Titel', 'Erste Frage', 'Seite', 'Modell', 'Zuletzt', 'Nachrichten'],
      result.conversations
        .slice(0, MAX_LISTED)
        .map((conversation) => [
          conversation.id,
          conversation.title,
          conversation.preview,
          conversation.documentTitle ?? '—',
          conversation.modelSlug ?? '—',
          conversation.lastMessageAt,
          String(conversation.messageCount),
        ]),
    );
    const more =
      result.nextCursor === null ? '' : `\n\nWeitere Seiten: cursor=${result.nextCursor}`;
    return { text: `${table}${more}`, data: result };
  },
});

export const chatSearchTool: AnyToolDefinition = defineTool({
  name: 'exo_chat_search',
  description:
    'Durchsucht den Verlauf der eigenen KI-Unterhaltungen im Volltext und antwortet je ' +
    'Unterhaltung mit der passendsten Stelle. Damit lässt sich ein Chat von vor Wochen über ' +
    'ein Stichwort wiederfinden, statt die Frage neu zu stellen.',
  inputSchema: z.object({
    query: z.string().trim().min(1).max(200).describe('Suchbegriffe'),
    workspaceId: idSchema.optional().describe('Nur in diesem Arbeitsbereich suchen.'),
    archived: z
      .enum(['open', 'archived', 'all'])
      .optional()
      .describe(
        'Welche Hälfte; Standard hier: all, archivierte Chats sind oft genau die gesuchten.',
      ),
    limit: z.number().int().min(1).max(100).optional().describe('Höchstzahl der Treffer'),
  }),
  surfaces: ['mcp', 'ai'],
  mutating: false,
  async execute(client, input) {
    const result = await client.request({
      method: 'GET',
      path: '/api/ai/conversations/search',
      query: {
        q: input.query,
        ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
        ...(input.archived === undefined ? {} : { archived: input.archived }),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      },
      responseSchema: aiConversationSearchResponseSchema,
    });
    if (result.hits.length === 0) {
      return { text: `Keine Unterhaltung enthält „${input.query}“.`, data: result };
    }
    const table = renderMarkdownTable(
      ['id', 'Titel', 'Stelle', 'Treffer', 'Zuletzt'],
      result.hits.map((hit) => [
        hit.conversation.id,
        hit.conversation.title,
        hit.snippet.replace(/\s+/g, ' '),
        String(hit.matchCount),
        hit.conversation.lastMessageAt,
      ]),
    );
    return { text: table, data: result };
  },
});

export const chatReadTool: AnyToolDefinition = defineTool({
  name: 'exo_chat_read',
  description:
    'Liest den Verlauf einer eigenen KI-Unterhaltung: alle Nachrichten in ihrer Reihenfolge, ' +
    'inklusive der Nachrichten, die eine Verdichtung aus dem Kontext genommen hat.',
  inputSchema: z.object({
    conversationId: idSchema,
  }),
  surfaces: ['mcp', 'ai'],
  mutating: false,
  async execute(client, input) {
    const result = await client.request({
      method: 'GET',
      path: `/api/ai/conversations/${input.conversationId}`,
      responseSchema: aiConversationDetailResponseSchema,
    });
    const header =
      `**${result.conversation.title}** · ${String(result.conversation.messageCount)} Nachrichten · ` +
      `zuletzt ${result.conversation.lastMessageAt}`;
    const body = result.messages
      .slice(0, MAX_TRANSCRIPT_MESSAGES)
      .map((message) => {
        const retired = message.superseded ? ' (nicht mehr im Kontext)' : '';
        const tool = message.toolName === null ? '' : ` ${message.toolName}`;
        return `**${message.role}${tool}**${retired}\n${message.content}`;
      })
      .join('\n\n');
    const cut =
      result.messages.length > MAX_TRANSCRIPT_MESSAGES
        ? `\n\n_${String(result.messages.length - MAX_TRANSCRIPT_MESSAGES)} weitere Nachrichten nicht gezeigt._`
        : '';
    return { text: `${header}\n\n${body}${cut}`, data: result };
  },
});

export const CHAT_TOOLS: readonly AnyToolDefinition[] = [
  chatListTool,
  chatSearchTool,
  chatReadTool,
];
