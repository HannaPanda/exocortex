import { Inject, Injectable } from '@nestjs/common';

import { estimateTokens } from '@exocortex/ai';
import { WorkspaceAccessService } from '@exocortex/auth';
import {
  type AddAiConversationSourceRequest,
  type AiConversationSource,
  type AiConversationSourcesResponse,
  type UpdateAiConversationSourceRequest,
} from '@exocortex/contracts';
import {
  type ConversationSourceRef,
  type PrismaClient,
  renderConversationSources,
  type SearchAdapter,
} from '@exocortex/database';
import { type Logger } from '@exocortex/logger';

import { AppError } from '../common/app-error';
import { LOGGER } from '../common/logger.provider';
import { PRISMA } from '../platform/platform.module';
import { SettingsService } from '../platform/settings.service';
import { KEYWORD_SEARCH_ADAPTER, SEARCH_ADAPTER } from '../search/search.service';

import { loadOwnedConversation } from './conversation-mapping';

/** The row shape every read here selects. Ordered by `createdAt`, the order the chips are in. */
const SOURCE_SELECT = {
  id: true,
  conversationId: true,
  kind: true,
  mode: true,
  documentId: true,
  databaseViewId: true,
  savedQueryId: true,
  createdAt: true,
} as const;

/**
 * The sources a conversation has pinned beside the page it is standing on
 * (issue #75, ADR-043).
 *
 * The rule the chip row promises is the same one the page context already
 * promises: what stands there goes out, what does not stand there does not. So
 * this service answers with the sizes the *prompt* will actually use, which is
 * why it calls `renderConversationSources` from `@exocortex/database` rather
 * than measuring the targets itself. A second measurement would be a promise
 * about a different text.
 *
 * Ownership is the conversation's, not the workspace's: like every other route
 * on a conversation, the caller has to be its creator.
 */
@Injectable()
export class ConversationSourcesService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(SEARCH_ADAPTER) private readonly hybrid: SearchAdapter,
    @Inject(KEYWORD_SEARCH_ADAPTER) private readonly keyword: SearchAdapter,
    private readonly access: WorkspaceAccessService,
    private readonly settings: SettingsService,
  ) {}

  async list(conversationId: string, userId: string): Promise<AiConversationSourcesResponse> {
    const conversation = await loadOwnedConversation(
      this.prisma,
      this.access,
      conversationId,
      userId,
    );
    return this.render(conversation.id, conversation.workspaceId);
  }

  async add(input: {
    conversationId: string;
    userId: string;
    request: AddAiConversationSourceRequest;
  }): Promise<AiConversationSourcesResponse> {
    const conversation = await loadOwnedConversation(
      this.prisma,
      this.access,
      input.conversationId,
      input.userId,
    );
    const settings = await this.settings.getForWorkspace(conversation.workspaceId);
    const maxSources = settings['ai.maxPinnedSources'];
    if (maxSources === 0) {
      throw new AppError(
        'pinned_sources_disabled',
        'Pinning context sources is switched off for this workspace',
      );
    }

    const target = await this.resolveTarget({
      request: input.request,
      workspaceId: conversation.workspaceId,
      userId: input.userId,
    });

    const existing = await this.prisma.aiConversationSource.count({
      where: { conversationId: conversation.id },
    });
    const alreadyPinned = await this.prisma.aiConversationSource.findUnique({
      where: {
        conversationId_targetKey: {
          conversationId: conversation.id,
          targetKey: target.targetKey,
        },
      },
      select: { id: true },
    });
    if (alreadyPinned === null && existing >= maxSources) {
      throw new AppError(
        'pinned_sources_limit_reached',
        `A conversation may pin at most ${maxSources} sources`,
      );
    }

    // Pinning the same target twice is the same intent expressed twice, not an
    // error: it updates the mode and leaves the chip where it was.
    await this.prisma.aiConversationSource.upsert({
      where: {
        conversationId_targetKey: {
          conversationId: conversation.id,
          targetKey: target.targetKey,
        },
      },
      create: {
        conversationId: conversation.id,
        kind: input.request.kind,
        mode: input.request.mode,
        documentId: target.documentId,
        databaseViewId: target.databaseViewId,
        savedQueryId: target.savedQueryId,
        targetKey: target.targetKey,
      },
      update: { mode: input.request.mode },
    });

    return this.render(conversation.id, conversation.workspaceId);
  }

  async update(input: {
    conversationId: string;
    sourceId: string;
    userId: string;
    request: UpdateAiConversationSourceRequest;
  }): Promise<AiConversationSourcesResponse> {
    const conversation = await loadOwnedConversation(
      this.prisma,
      this.access,
      input.conversationId,
      input.userId,
    );
    const updated = await this.prisma.aiConversationSource.updateMany({
      where: { id: input.sourceId, conversationId: conversation.id },
      data: { mode: input.request.mode },
    });
    if (updated.count === 0) throw AppError.notFound('Pinned context source');

    return this.render(conversation.id, conversation.workspaceId);
  }

  async remove(input: {
    conversationId: string;
    sourceId: string;
    userId: string;
  }): Promise<AiConversationSourcesResponse> {
    const conversation = await loadOwnedConversation(
      this.prisma,
      this.access,
      input.conversationId,
      input.userId,
    );
    const deleted = await this.prisma.aiConversationSource.deleteMany({
      where: { id: input.sourceId, conversationId: conversation.id },
    });
    if (deleted.count === 0) throw AppError.notFound('Pinned context source');

    return this.render(conversation.id, conversation.workspaceId);
  }

  /**
   * Verifies the target is in the conversation's workspace and readable, and
   * builds the key the unique index deduplicates on.
   *
   * The check is the same one `resolvePageContext` makes for the open page, and
   * for the same reason: a title from a workspace the conversation has nothing
   * to do with must never reach a prompt, and an unchecked id would hand a
   * caller the title of any document by guessing it.
   */
  private async resolveTarget(input: {
    request: AddAiConversationSourceRequest;
    workspaceId: string;
    userId: string;
  }): Promise<{
    targetKey: string;
    documentId: string | null;
    databaseViewId: string | null;
    savedQueryId: string | null;
  }> {
    const { request, workspaceId, userId } = input;

    if (request.kind === 'SAVED_QUERY') {
      const savedQueryId = request.savedQueryId ?? '';
      const savedQuery = await this.prisma.savedQuery.findFirst({
        where: { id: savedQueryId, workspaceId },
        select: { id: true },
      });
      if (savedQuery === null) {
        throw new AppError('saved_query_access_denied', 'The saved query is not accessible');
      }
      return {
        targetKey: `query:${savedQuery.id}`,
        documentId: null,
        databaseViewId: null,
        savedQueryId: savedQuery.id,
      };
    }

    const documentId = request.documentId ?? '';
    const context = await this.access.findDocumentContext(documentId, userId);
    if (context === null || context.workspaceId !== workspaceId) {
      throw new AppError('document_access_denied', 'The referenced document is not accessible');
    }

    if (request.kind === 'PAGE') {
      return {
        targetKey: `page:${documentId}`,
        documentId,
        databaseViewId: null,
        savedQueryId: null,
      };
    }

    if (context.document.type !== 'COLLECTION') {
      throw new AppError('document_not_a_collection', 'Only a database page has views');
    }

    // Without a named view the first one is pinned, exactly as the table on
    // screen falls back: rows only mean something through a view's filters, so
    // a pinned database without one would describe a different table.
    const view =
      request.databaseViewId === undefined || request.databaseViewId === null
        ? await this.prisma.databaseView.findFirst({
            where: { documentId },
            orderBy: { orderKey: 'asc' },
            select: { id: true },
          })
        : await this.prisma.databaseView.findFirst({
            where: { id: request.databaseViewId, documentId },
            select: { id: true },
          });
    if (view === null) throw AppError.notFound('Database view');

    return {
      targetKey: `view:${documentId}:${view.id}`,
      documentId,
      databaseViewId: view.id,
      savedQueryId: null,
    };
  }

  /** Reads the rows and renders them through the same code the prompt uses. */
  private async render(
    conversationId: string,
    workspaceId: string,
  ): Promise<AiConversationSourcesResponse> {
    const settings = await this.settings.getForWorkspace(workspaceId);
    const rows = await this.prisma.aiConversationSource.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'asc' },
      select: SOURCE_SELECT,
    });

    const refs: ConversationSourceRef[] = rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      mode: row.mode,
      documentId: row.documentId,
      databaseViewId: row.databaseViewId,
      savedQueryId: row.savedQueryId,
    }));

    const rendered = await renderConversationSources({
      prisma: this.prisma,
      workspaceId,
      sources: refs,
      maxChars: settings['ai.pinnedContextMaxChars'],
      search: { hybrid: this.hybrid, keyword: this.keyword },
      logger: this.logger,
    });

    const byId = new Map(rows.map((row) => [row.id, row]));
    const sources: AiConversationSource[] = rendered.sources.map((source) => {
      const row = byId.get(source.id);
      return {
        id: source.id,
        conversationId,
        kind: source.kind,
        mode: source.mode,
        documentId: row?.documentId ?? null,
        databaseViewId: row?.databaseViewId ?? null,
        savedQueryId: row?.savedQueryId ?? null,
        title: source.title,
        subtitle: source.subtitle,
        chars: source.text.length,
        fullChars: source.fullChars,
        tokens: estimateTokens(source.text),
        truncated: source.truncated,
        empty: source.empty,
        createdAt: (row?.createdAt ?? new Date()).toISOString(),
      };
    });

    return {
      sources,
      budget: {
        maxChars: rendered.budget.maxChars,
        perSourceChars: rendered.budget.perSourceChars,
        usedChars: rendered.budget.usedChars,
        usedTokens: sources.reduce((total, source) => total + source.tokens, 0),
        maxSources: settings['ai.maxPinnedSources'],
      },
    };
  }
}
