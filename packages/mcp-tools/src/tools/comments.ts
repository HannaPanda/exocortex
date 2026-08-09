import { z } from 'zod';

import {
  type Comment,
  commentBlockIdSchema,
  commentBodySchema,
  commentListResponseSchema,
  commentResponseSchema,
  type CommentThread,
  deleteCommentResponseSchema,
  idSchema,
} from '@exocortex/contracts';

import { truncateText } from '../format.js';
import { type AnyToolDefinition, defineTool } from '../tool.js';

/**
 * Comment tools (issue #18).
 *
 * The point of these, and the reason they belong in the catalogue rather than
 * being a UI-only feature: an assistant that can leave a remark can review a
 * page without rewriting it. `exo_page_write` changes what the page says;
 * `exo_comment_create` says something *about* what the page says, and the
 * author keeps the decision.
 */

/** Cap on a rendered thread list, so a heavily discussed page cannot flood a tool loop. */
const MAX_COMMENTS_TEXT_CHARS = 8_000;

function describeAnchor(comment: Comment): string {
  if (comment.blockId === null) return 'ganze Seite';
  if (comment.orphaned) {
    return comment.anchorText === null
      ? `Block ${comment.blockId} (verwaist: der Block existiert nicht mehr)`
      : `verwaist, ursprünglich: „${comment.anchorText}"`;
  }
  return comment.anchorText === null
    ? `Block ${comment.blockId}`
    : `Block ${comment.blockId}: „${comment.anchorText}"`;
}

function renderThread(thread: CommentThread): string {
  const { root } = thread;
  const state =
    root.resolvedAt === null
      ? 'offen'
      : `erledigt von ${root.resolvedBy?.name ?? 'unbekannt'}`;
  const lines = [
    `- [${state}] ${root.createdBy.name} (${describeAnchor(root)}, id: ${root.id}): ${root.body}`,
  ];
  for (const reply of thread.replies) {
    lines.push(`    ↳ ${reply.createdBy.name} (id: ${reply.id}): ${reply.body}`);
  }
  return lines.join('\n');
}

export const commentListTool: AnyToolDefinition = defineTool({
  name: 'exo_comment_list',
  description:
    'Listet die Kommentarfäden einer Seite: offene zuerst, erledigte danach, jeweils mit ' +
    'Antworten. Zeigt an, ob ein Faden an der ganzen Seite oder an einem Block hängt und ob ' +
    'sein Block inzwischen gelöscht wurde (verwaist).',
  inputSchema: z.object({
    documentId: idSchema,
    includeResolved: z
      .boolean()
      .default(true)
      .describe('false blendet erledigte Fäden aus; die Zählung nennt sie trotzdem.'),
  }),
  surfaces: ['mcp', 'ai'],
  mutating: false,
  async execute(client, input) {
    const result = await client.request({
      method: 'GET',
      path: `/api/documents/${input.documentId}/comments`,
      query: { includeResolved: input.includeResolved },
      responseSchema: commentListResponseSchema,
    });

    const header = `Kommentare: ${result.openCount} offen, ${result.resolvedCount} erledigt.`;
    const body =
      result.threads.length === 0
        ? 'Kein anzuzeigender Faden.'
        : result.threads.map(renderThread).join('\n');
    const rendered = truncateText(`${header}\n${body}`, MAX_COMMENTS_TEXT_CHARS);
    return { text: rendered.text, data: result };
  },
});

export const commentCreateTool: AnyToolDefinition = defineTool({
  name: 'exo_comment_create',
  description:
    'Hinterlässt eine Anmerkung an einer Seite, ohne die Seite zu verändern. Ohne "blockId" ' +
    'gilt sie für die ganze Seite, mit "blockId" für genau diesen Block (die Kennungen ' +
    'liefert exo_page_read mit). Mit "parentId" wird daraus eine Antwort auf einen ' +
    'bestehenden Faden.',
  inputSchema: z.object({
    documentId: idSchema,
    body: commentBodySchema.describe('Der Kommentartext. Deutsch, wie die Oberfläche.'),
    blockId: commentBlockIdSchema
      .nullable()
      .default(null)
      .describe('Blockkennung aus exo_page_read. Wird bei einer Antwort ignoriert.'),
    anchorText: z
      .string()
      .max(240)
      .nullable()
      .default(null)
      .describe('Zitat der kommentierten Stelle, damit der Faden lesbar bleibt, wenn der Block verschwindet.'),
    parentId: idSchema
      .nullable()
      .default(null)
      .describe('Erster Kommentar des Fadens, auf den geantwortet wird.'),
  }),
  surfaces: ['mcp', 'ai'],
  mutating: true,
  target: (input) => `document:${input.documentId}`,
  async execute(client, input) {
    const result = await client.request({
      method: 'POST',
      path: `/api/documents/${input.documentId}/comments`,
      body: {
        body: input.body,
        blockId: input.blockId,
        anchorText: input.anchorText,
        parentId: input.parentId,
      },
      responseSchema: commentResponseSchema,
    });
    const kind = result.comment.parentId === null ? 'Kommentar' : 'Antwort';
    return {
      text: `${kind} angelegt (id: ${result.comment.id}, ${describeAnchor(result.comment)}).`,
      data: result,
    };
  },
});

export const commentUpdateTool: AnyToolDefinition = defineTool({
  name: 'exo_comment_update',
  description:
    'Schreibt den Text eines eigenen Kommentars neu. Fremde Kommentare lassen sich nicht ' +
    'bearbeiten, auch nicht mit Adminrechten.',
  inputSchema: z.object({
    commentId: idSchema,
    body: commentBodySchema,
  }),
  surfaces: ['mcp', 'ai'],
  mutating: true,
  target: (input) => `comment:${input.commentId}`,
  async execute(client, input) {
    const result = await client.request({
      method: 'PATCH',
      path: `/api/comments/${input.commentId}`,
      body: { body: input.body },
      responseSchema: commentResponseSchema,
    });
    return { text: `Kommentar ${result.comment.id} überarbeitet.`, data: result };
  },
});

export const commentResolveTool: AnyToolDefinition = defineTool({
  name: 'exo_comment_resolve',
  description:
    'Erklärt einen Kommentarfaden für erledigt oder öffnet ihn wieder. Gilt nur für den ' +
    'ersten Kommentar eines Fadens; erledigte Fäden bleiben erhalten und werden nur eingeklappt.',
  inputSchema: z.object({
    commentId: idSchema.describe('Der erste Kommentar des Fadens.'),
    resolved: z.boolean().default(true).describe('false öffnet den Faden wieder.'),
  }),
  surfaces: ['mcp', 'ai'],
  mutating: true,
  target: (input) => `comment:${input.commentId}`,
  async execute(client, input) {
    const result = await client.request({
      method: 'POST',
      path: `/api/comments/${input.commentId}/resolve`,
      body: { resolved: input.resolved },
      responseSchema: commentResponseSchema,
    });
    return {
      text: input.resolved
        ? `Faden ${result.comment.id} erledigt.`
        : `Faden ${result.comment.id} wieder geöffnet.`,
      data: result,
    };
  },
});

export const commentDeleteTool: AnyToolDefinition = defineTool({
  name: 'exo_comment_delete',
  description:
    'Löscht einen Kommentar. Beim ersten Kommentar eines Fadens verschwinden seine Antworten ' +
    'mit. Erledigen ist fast immer die bessere Wahl: es hält fest, dass etwas besprochen wurde.',
  inputSchema: z.object({
    commentId: idSchema,
  }),
  surfaces: ['mcp', 'ai'],
  mutating: true,
  target: (input) => `comment:${input.commentId}`,
  async execute(client, input) {
    const result = await client.request({
      method: 'DELETE',
      path: `/api/comments/${input.commentId}`,
      responseSchema: deleteCommentResponseSchema,
    });
    return {
      text:
        result.removedReplies === 0
          ? 'Kommentar gelöscht.'
          : `Kommentar gelöscht, dazu ${result.removedReplies} Antwort(en).`,
      data: result,
    };
  },
});

export const COMMENT_TOOLS: readonly AnyToolDefinition[] = [
  commentListTool,
  commentCreateTool,
  commentUpdateTool,
  commentResolveTool,
  commentDeleteTool,
];
