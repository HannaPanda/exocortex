import { Inject, Injectable } from '@nestjs/common';

import { assertPolicy, canReadWorkspace, WorkspaceAccessService } from '@exocortex/auth';
import { type ApiEnv } from '@exocortex/config';
import {
  AI_CONVERSATION_MAX_PAGE_SIZE,
  type AiConversation,
  type AiConversationArchivedFilter,
  type AiConversationDeleteResponse,
  type AiConversationListResponse,
  type AiConversationSearchResponse,
  type ConversationToPageRequest,
  type ConversationToPageResponse,
} from '@exocortex/contracts';
import { type Prisma, type PrismaClient } from '@exocortex/database';
import { type Logger } from '@exocortex/logger';

import { AppError } from '../common/app-error';
import { API_ENV, LOGGER } from '../common/logger.provider';
import { DocumentContentService } from '../documents/document-content.service';
import { DocumentsService } from '../documents/documents.service';
import { PRISMA } from '../platform/platform.module';

import { AiModelResolverService } from './ai-model-resolver.service';
import {
  CONVERSATION_SELECT,
  conversationMessageToContract,
  type ConversationRow,
  conversationToContract,
  loadConversationPreviews,
  loadOwnedConversation,
  memberWorkspaceIds,
  resolveFallbackContextWindow,
} from './conversation-mapping';
import { ConversationSearchService } from './conversation-search';
import { conversationToMarkdown } from './transcript-markdown';

/**
 * Finding a conversation again (issue #69).
 *
 * The half of the conversation surface that is about the archive rather than
 * about the chat: listing across workspaces, searching the transcript,
 * deleting for good, and saving a chat as a page. Kept apart from
 * `ConversationsService` because the two answer different questions -- that one
 * is what the panel needs to hold a conversation, this one is what a person
 * needs to find one they had three weeks ago.
 *
 * Every method re-checks the same two things `ConversationsService` does: the
 * caller's role in the workspace, and that the conversation is the caller's
 * own.
 */

/**
 * The cursor is the sort key, not an offset.
 *
 * `lastMessageAt` alone is not unique -- two conversations touched in the same
 * millisecond are not hypothetical when a script creates them -- so the id
 * rides along and breaks the tie. Base64 only so nobody is tempted to build one
 * by hand and depend on the shape.
 *
 * Exported for the round-trip test: a cursor that decodes to something slightly
 * different from what was encoded skips or repeats a row, and neither shows up
 * as an error anywhere.
 */
export function encodeCursor(row: { lastMessageAt: Date; id: string }): string {
  return Buffer.from(`${String(row.lastMessageAt.getTime())}:${row.id}`, 'utf8').toString(
    'base64url',
  );
}

export function decodeCursor(cursor: string): { lastMessageAt: Date; id: string } {
  const raw = Buffer.from(cursor, 'base64url').toString('utf8');
  const separator = raw.indexOf(':');
  const millis = Number(raw.slice(0, separator));
  const id = raw.slice(separator + 1);
  if (separator === -1 || !Number.isFinite(millis) || id.length === 0) {
    throw new AppError('ai_conversation_cursor_invalid', 'The pagination cursor is not readable');
  }
  return { lastMessageAt: new Date(millis), id };
}

function archivedWhere(filter: AiConversationArchivedFilter): Prisma.DateTimeNullableFilter | null {
  if (filter === 'all') return null;
  return filter === 'archived' ? { not: null } : { equals: null };
}

@Injectable()
export class ConversationArchiveService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(API_ENV) private readonly env: ApiEnv,
    private readonly access: WorkspaceAccessService,
    private readonly modelResolver: AiModelResolverService,
    private readonly search: ConversationSearchService,
    private readonly documents: DocumentsService,
    private readonly content: DocumentContentService,
  ) {}

  /**
   * One page of the caller's own conversations.
   *
   * `workspaceId` is optional: without it the list spans every workspace the
   * caller is a member of, which is what the `/chats` area needs and what the
   * panel's per-workspace dropdown does not.
   */
  async list(input: {
    userId: string;
    workspaceId: string | null;
    documentId: string | null;
    archived: AiConversationArchivedFilter;
    limit: number;
    cursor: string | null;
  }): Promise<AiConversationListResponse> {
    const workspaceIds = await this.scopeWorkspaces(input.userId, input.workspaceId);
    if (workspaceIds.length === 0) return { conversations: [], nextCursor: null };

    const archived = archivedWhere(input.archived);
    const after = input.cursor === null ? null : decodeCursor(input.cursor);
    const limit = Math.min(Math.max(input.limit, 1), AI_CONVERSATION_MAX_PAGE_SIZE);

    const rows = await this.prisma.aiConversation.findMany({
      where: {
        createdById: input.userId,
        workspaceId: { in: workspaceIds },
        ...(input.documentId === null ? {} : { documentId: input.documentId }),
        ...(archived === null ? {} : { archivedAt: archived }),
        ...(after === null
          ? {}
          : {
              OR: [
                { lastMessageAt: { lt: after.lastMessageAt } },
                { lastMessageAt: after.lastMessageAt, id: { lt: after.id } },
              ],
            }),
      },
      orderBy: [{ lastMessageAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      select: CONVERSATION_SELECT,
    });

    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      conversations: await this.toContracts(page),
      nextCursor: rows.length > limit && last !== undefined ? encodeCursor(last) : null,
    };
  }

  /** Full-text search over the caller's own transcripts. */
  async searchMessages(input: {
    userId: string;
    query: string;
    workspaceId: string | null;
    archived: AiConversationArchivedFilter;
    limit: number;
  }): Promise<AiConversationSearchResponse> {
    const workspaceIds = await this.scopeWorkspaces(input.userId, input.workspaceId);
    const matches = await this.search.search({
      query: input.query,
      userId: input.userId,
      workspaceIds,
      archived: input.archived,
      limit: input.limit,
    });
    if (matches.length === 0) return { query: input.query, hits: [] };

    const rows = await this.prisma.aiConversation.findMany({
      where: { id: { in: matches.map((match) => match.conversationId) } },
      select: CONVERSATION_SELECT,
    });
    const conversations = new Map(
      (await this.toContracts(rows)).map((conversation) => [conversation.id, conversation]),
    );

    const hits = matches
      .map((match) => {
        const conversation = conversations.get(match.conversationId);
        return conversation === undefined ? null : { conversation, ...match.hit };
      })
      .filter((hit): hit is NonNullable<typeof hit> => hit !== null);
    return { query: input.query, hits };
  }

  /**
   * Deletes a conversation for good.
   *
   * The messages go, and so does the conversation. The `AiRun` rows do not:
   * their payloads are emptied and `payloadsPrunedAt` is stamped, exactly the
   * way the retention sweep already prunes an old run, and the run is detached
   * from the conversation. That is a deliberate narrowing of "with its runs":
   * a run row is two things at once, a copy of the transcript and a line in the
   * deployment's cost ledger, and deleting it would quietly reduce a figure an
   * administrator is accountable for. Nothing of what was said survives either
   * way -- what survives is how many tokens it cost.
   */
  async deletePermanently(
    conversationId: string,
    userId: string,
  ): Promise<AiConversationDeleteResponse> {
    const conversation = await this.loadOwned(conversationId, userId);

    const [messages, runs] = await this.prisma.$transaction([
      this.prisma.aiConversationMessage.deleteMany({ where: { conversationId: conversation.id } }),
      this.prisma.aiRun.updateMany({
        where: { conversationId: conversation.id },
        data: {
          conversationId: null,
          messages: [],
          resultText: null,
          payloadsPrunedAt: new Date(),
        },
      }),
      this.prisma.aiConversation.delete({ where: { id: conversation.id } }),
    ]);

    this.logger.info('AI conversation deleted permanently', {
      conversationId: conversation.id,
      workspaceId: conversation.workspaceId,
      messagesDeleted: messages.count,
      runsPruned: runs.count,
    });
    return { deleted: true, messagesDeleted: messages.count, runsPruned: runs.count };
  }

  /**
   * Saves a conversation as an ordinary page (AP5).
   *
   * The page is a normal document created through `DocumentsService` and
   * written through `DocumentContentService`, so it passes the same permission
   * checks, lands in the same outbox and reaches an open editor through the
   * collaboration server (ADR-016). The conversation itself stays what it is: a
   * list of message rows, not a second canonical state.
   */
  async toPage(input: {
    conversationId: string;
    userId: string;
    request: ConversationToPageRequest;
    correlationId: string;
  }): Promise<ConversationToPageResponse> {
    const conversation = await this.loadOwned(input.conversationId, input.userId);

    const [messages, workspace] = await Promise.all([
      this.prisma.aiConversationMessage.findMany({
        where: { conversationId: conversation.id },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.workspace.findUnique({
        where: { id: conversation.workspaceId },
        select: { name: true },
      }),
    ]);

    const title = input.request.title ?? conversation.title;
    const created = await this.documents.create({
      workspaceId: conversation.workspaceId,
      userId: input.userId,
      request: { type: 'PAGE', title, parentId: input.request.parentId ?? undefined },
      correlationId: input.correlationId,
    });

    await this.content.write({
      documentId: created.id,
      userId: input.userId,
      request: {
        markdown: conversationToMarkdown({
          title,
          workspaceName: workspace?.name ?? null,
          documentTitle: conversation.document?.title ?? null,
          modelSlug: conversation.model?.slug ?? null,
          createdAt: conversation.createdAt.toISOString(),
          lastMessageAt: conversation.lastMessageAt.toISOString(),
          messages: messages.map((message) => conversationMessageToContract(message)),
        }),
        mode: 'replace',
      },
      correlationId: input.correlationId,
      source: 'api',
    });

    this.logger.info('AI conversation saved as a page', {
      correlationId: input.correlationId,
      conversationId: conversation.id,
      documentId: created.id,
    });

    return {
      conversationId: conversation.id,
      documentId: created.id,
      workspaceId: conversation.workspaceId,
      title: created.title,
      url: this.documentUrl(conversation.workspaceId, created.id),
    };
  }

  // -------------------------------------------------------------------------

  private async loadOwned(conversationId: string, userId: string): Promise<ConversationRow> {
    return loadOwnedConversation(this.prisma, this.access, conversationId, userId);
  }

  /**
   * Which workspaces a listing may look in.
   *
   * A named workspace is checked the usual way; without one, the caller's own
   * memberships are the scope. Either way the filter is a list of ids in the
   * `WHERE`, so a conversation in a workspace the caller has been removed from
   * stops appearing without anything else having to notice.
   */
  private async scopeWorkspaces(userId: string, workspaceId: string | null): Promise<string[]> {
    if (workspaceId === null) return memberWorkspaceIds(this.prisma, userId);
    const role = await this.access.findRole(workspaceId, userId);
    assertPolicy(canReadWorkspace(role));
    return [workspaceId];
  }

  private async toContracts(rows: readonly ConversationRow[]): Promise<AiConversation[]> {
    if (rows.length === 0) return [];
    const [fallbackContextWindow, previews] = await Promise.all([
      resolveFallbackContextWindow(this.modelResolver),
      loadConversationPreviews(
        this.prisma,
        rows.map((row) => row.id),
      ),
    ]);
    return rows.map((row) =>
      conversationToContract(row, fallbackContextWindow, previews.get(row.id) ?? ''),
    );
  }

  private documentUrl(workspaceId: string, documentId: string): string {
    try {
      return new URL(
        `/arbeitsbereich/${workspaceId}/seite/${documentId}`,
        this.env.APP_URL,
      ).toString();
    } catch {
      return `/arbeitsbereich/${workspaceId}/seite/${documentId}`;
    }
  }
}
