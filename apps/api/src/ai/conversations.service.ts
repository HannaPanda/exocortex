import { Inject, Injectable } from '@nestjs/common';

import { estimateMessageTokens } from '@exocortex/ai';
import { assertPolicy, canReadWorkspace, WorkspaceAccessService } from '@exocortex/auth';
import {
  type AiConversation,
  type AiConversationDetailResponse,
  type AiConversationListResponse,
  type AiConversationMessage,
  type CreateAiConversationRequest,
  type PostConversationMessageRequest,
  type PostConversationMessageResponse,
  QUEUE_NAMES,
  type UpdateAiConversationRequest,
} from '@exocortex/contracts';
import {
  type AiConversationRole as AiConversationRolePrisma,
  type AiReasoningLevel as AiReasoningLevelPrisma,
  type Prisma,
  type PrismaClient,
} from '@exocortex/database';
import { type Logger } from '@exocortex/logger';
import { QueueRegistry } from '@exocortex/queue';

import { AppError } from '../common/app-error';
import { LOGGER } from '../common/logger.provider';
import { PRISMA, QUEUES } from '../platform/platform.module';
import { SettingsService } from '../platform/settings.service';

import {
  AiModelResolverService,
  REASONING_LEVEL_TO_CONTRACT,
  REASONING_LEVEL_TO_PRISMA,
} from './ai-model-resolver.service';
import { runChatCommand } from './chat-command-runner';
import { parseChatCommand, type ParsedChatCommand } from './chat-commands';
import { mapAiRunRow } from './run-mapper';

const CONVERSATION_SELECT = {
  id: true,
  workspaceId: true,
  createdById: true,
  title: true,
  documentId: true,
  pageContextEnabled: true,
  modelId: true,
  reasoningLevel: true,
  visionCompanionSlug: true,
  estimatedTokens: true,
  lastMessageAt: true,
  createdAt: true,
  archivedAt: true,
  model: { select: { slug: true, contextWindowTokens: true } },
  _count: { select: { messages: true } },
} as const;

interface ConversationRow {
  id: string;
  workspaceId: string;
  createdById: string;
  title: string;
  documentId: string | null;
  pageContextEnabled: boolean;
  modelId: string | null;
  reasoningLevel: AiReasoningLevelPrisma;
  visionCompanionSlug: string | null;
  estimatedTokens: number;
  lastMessageAt: Date;
  createdAt: Date;
  archivedAt: Date | null;
  model: { slug: string; contextWindowTokens: number } | null;
  _count: { messages: number };
}

interface ConversationMessageRow {
  id: string;
  conversationId: string;
  role: AiConversationRolePrisma;
  content: string;
  toolCallId: string | null;
  toolName: string | null;
  isSummary: boolean;
  supersededAt: Date | null;
  runId: string | null;
  createdAt: Date;
}

const CONVERSATION_ROLE_TO_CONTRACT: Record<
  AiConversationRolePrisma,
  AiConversationMessage['role']
> = {
  SYSTEM: 'system',
  USER: 'user',
  ASSISTANT: 'assistant',
  TOOL: 'tool',
};

const PLACEHOLDER_TITLE = 'Neue Unterhaltung';
const TITLE_MAX_CHARS = 60;

/** The transcript line that records a page switch. Rendered as a muted system line in the panel. */
function formatContextSwitch(documentTitle: string | null): string {
  return documentTitle === null
    ? '↳ Kontextwechsel: es ist keine Seite mehr geöffnet.'
    : `↳ Kontextwechsel: geöffnet ist jetzt „${documentTitle}“.`;
}

/**
 * Hard cap on a handed-over selection.
 *
 * A selection is meant to be "this bit here", not a way to smuggle a whole page
 * past the page-context switch. Beyond the cap it is cut and the cut is stated
 * in the text itself, so the model knows it is looking at an excerpt -- the same
 * rule the ALWAYS rule budget follows in `buildSystemPrompt`.
 */
const MAX_SELECTION_CHARS = 4_000;

/**
 * The transcript entry that carries a handed-over selection.
 *
 * It goes into the transcript rather than into one run's prompt on purpose: the
 * user can see exactly what was sent, later turns can still refer back to it,
 * and `/clear` and auto-compaction handle it like any other message.
 */
function formatSelection(input: {
  text: string;
  blockIds: readonly string[];
  documentTitle: string | null;
}): string {
  const cut = input.text.length > MAX_SELECTION_CHARS;
  const body = cut ? input.text.slice(0, MAX_SELECTION_CHARS) : input.text;

  const source = input.documentTitle === null ? '' : ` aus „${input.documentTitle}“`;
  const count =
    input.blockIds.length === 0
      ? ''
      : ` (${input.blockIds.length} ${input.blockIds.length === 1 ? 'Block' : 'Blöcke'}: ${input.blockIds.join(', ')})`;

  const lines = [`↳ Ausgewählter Abschnitt${source}${count}:`, body];
  if (cut) {
    lines.push(`_Die Auswahl wurde nach ${MAX_SELECTION_CHARS} Zeichen gekürzt._`);
  }
  return lines.join('\n');
}

/** Derives a conversation title from the first user message: whitespace-collapsed, capped at 60 characters. */
function deriveTitle(content: string): string {
  const collapsed = content.replace(/\s+/g, ' ').trim();
  if (collapsed.length === 0) return PLACEHOLDER_TITLE;
  return collapsed.length > TITLE_MAX_CHARS ? collapsed.slice(0, TITLE_MAX_CHARS) : collapsed;
}

/**
 * Persistent AI conversations: CRUD, server-side slash commands, and posting a
 * message (which enqueues an `AiRun` bound to the conversation).
 *
 * A conversation is personal, not shared, even inside a shared workspace: every
 * route in this service -- reads included -- requires the caller to be the
 * conversation's own creator, not merely a member of its workspace. This is a
 * deliberate widening of "ownership required for writes": without it, a
 * workspace member could read another member's chat history by guessing or
 * observing a conversation id, which would contradict the whole point of a
 * personal conversation.
 */
@Injectable()
export class ConversationsService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(QUEUES) private readonly queues: QueueRegistry,
    @Inject(LOGGER) private readonly logger: Logger,
    private readonly access: WorkspaceAccessService,
    private readonly modelResolver: AiModelResolverService,
    private readonly settings: SettingsService,
  ) {}

  async list(input: {
    workspaceId: string;
    userId: string;
    includeArchived: boolean;
  }): Promise<AiConversationListResponse> {
    const role = await this.access.findRole(input.workspaceId, input.userId);
    assertPolicy(canReadWorkspace(role));

    const rows = await this.prisma.aiConversation.findMany({
      where: {
        workspaceId: input.workspaceId,
        createdById: input.userId,
        archivedAt: input.includeArchived ? undefined : null,
      },
      orderBy: { lastMessageAt: 'desc' },
      select: CONVERSATION_SELECT,
    });

    const fallbackContextWindow = await this.resolveFallbackContextWindow();
    return { conversations: rows.map((row) => this.toContract(row, fallbackContextWindow)) };
  }

  async get(conversationId: string, userId: string): Promise<AiConversationDetailResponse> {
    const conversation = await this.loadOwned(conversationId, userId);
    const messages = await this.prisma.aiConversationMessage.findMany({
      where: { conversationId: conversation.id },
      orderBy: { createdAt: 'asc' },
    });

    const fallbackContextWindow = await this.resolveFallbackContextWindow();
    return {
      conversation: this.toContract(conversation, fallbackContextWindow),
      messages: messages.map((message) => this.messageToContract(message)),
    };
  }

  async create(input: {
    userId: string;
    request: CreateAiConversationRequest;
  }): Promise<{ conversation: AiConversation }> {
    const role = await this.access.findRole(input.request.workspaceId, input.userId);
    assertPolicy(canReadWorkspace(role));

    if (input.request.documentId !== null) {
      const context = await this.access.findDocumentContext(input.request.documentId, input.userId);
      if (context === null || context.workspaceId !== input.request.workspaceId) {
        throw new AppError('document_access_denied', 'The referenced document is not accessible');
      }
    }

    let modelId: string | null = null;
    let reasoningLevel: AiReasoningLevelPrisma = 'NONE';
    if (input.request.modelSlug !== undefined) {
      const resolved = await this.modelResolver.resolve({ slug: input.request.modelSlug });
      modelId = resolved.id;
      reasoningLevel =
        REASONING_LEVEL_TO_PRISMA[
          this.modelResolver.clampReasoningLevel(resolved, input.request.reasoningLevel ?? 'none')
        ];
    } else if (input.request.reasoningLevel !== undefined) {
      reasoningLevel = REASONING_LEVEL_TO_PRISMA[input.request.reasoningLevel];
    }

    const created = await this.prisma.aiConversation.create({
      data: {
        workspaceId: input.request.workspaceId,
        createdById: input.userId,
        title: input.request.title ?? PLACEHOLDER_TITLE,
        documentId: input.request.documentId,
        ...(input.request.pageContextEnabled === undefined
          ? {}
          : { pageContextEnabled: input.request.pageContextEnabled }),
        modelId,
        reasoningLevel,
      },
      select: CONVERSATION_SELECT,
    });

    const fallbackContextWindow = await this.resolveFallbackContextWindow();
    return { conversation: this.toContract(created, fallbackContextWindow) };
  }

  async update(input: {
    conversationId: string;
    userId: string;
    request: UpdateAiConversationRequest;
  }): Promise<{ conversation: AiConversation }> {
    const conversation = await this.loadOwned(input.conversationId, input.userId);

    const data: Prisma.AiConversationUpdateInput = {};
    if (input.request.title !== undefined) data.title = input.request.title;
    if (input.request.modelSlug !== undefined) {
      const resolved = await this.modelResolver.resolve({ slug: input.request.modelSlug });
      data.model = { connect: { id: resolved.id } };
    }
    if (input.request.reasoningLevel !== undefined) {
      data.reasoningLevel = REASONING_LEVEL_TO_PRISMA[input.request.reasoningLevel];
    }
    if (input.request.visionCompanionSlug !== undefined) {
      if (
        input.request.visionCompanionSlug !== null &&
        input.request.visionCompanionSlug !== 'off'
      ) {
        await this.modelResolver.resolve({ slug: input.request.visionCompanionSlug });
      }
      data.visionCompanionSlug = input.request.visionCompanionSlug;
    }
    if (input.request.pageContextEnabled !== undefined) {
      data.pageContextEnabled = input.request.pageContextEnabled;
    }
    if (input.request.archived !== undefined) {
      data.archivedAt = input.request.archived ? new Date() : null;
    }

    const updated = await this.prisma.aiConversation.update({
      where: { id: conversation.id },
      data,
      select: CONVERSATION_SELECT,
    });

    const fallbackContextWindow = await this.resolveFallbackContextWindow();
    return { conversation: this.toContract(updated, fallbackContextWindow) };
  }

  /** Soft-archives a conversation. It never deletes rows: the transcript stays around. */
  async archive(conversationId: string, userId: string): Promise<{ archived: true }> {
    const conversation = await this.loadOwned(conversationId, userId);
    await this.prisma.aiConversation.update({
      where: { id: conversation.id },
      data: { archivedAt: new Date() },
    });
    return { archived: true };
  }

  /**
   * Decides which page this turn runs against, and proves the caller may see it.
   *
   * The distinction between an absent `documentId` and an explicit `null` is the
   * whole point: a client that does not track pages (MCP, scripts) omits the
   * field and inherits whatever the conversation is bound to, while the panel
   * always sends the route's page and therefore sends `null` when the user is
   * somewhere without one. Treating both the same would make leaving a page
   * impossible.
   *
   * The check itself is not decoration: since the worker puts the page's title
   * and path into the system prompt, an unchecked id would hand a caller the
   * title of any document by guessing its id.
   */
  private async resolvePageContext(input: {
    conversation: ConversationRow;
    requested: string | null | undefined;
    userId: string;
  }): Promise<{ documentId: string | null; documentTitle: string | null }> {
    const { conversation, requested, userId } = input;
    const documentId = requested === undefined ? conversation.documentId : requested;
    if (documentId === null) return { documentId: null, documentTitle: null };

    const context = await this.access.findDocumentContext(documentId, userId);
    if (context !== null && context.workspaceId === conversation.workspaceId) {
      return { documentId, documentTitle: context.document.title };
    }

    // A page the caller named explicitly must fail loudly. A page the
    // conversation was bound to earlier may simply have been deleted since, and
    // that must not lock the user out of their own transcript.
    if (requested !== undefined) {
      throw new AppError('document_access_denied', 'The referenced document is not accessible');
    }
    this.logger.info(
      'Conversation is bound to a document that is gone; continuing without page context',
      {
        conversationId: conversation.id,
        documentId,
      },
    );
    return { documentId: null, documentTitle: null };
  }

  async postMessage(input: {
    conversationId: string;
    userId: string;
    request: PostConversationMessageRequest;
    correlationId: string;
  }): Promise<PostConversationMessageResponse> {
    const conversation = await this.loadOwned(input.conversationId, input.userId);

    const pendingRun = await this.prisma.aiRun.findFirst({
      where: { conversationId: conversation.id, status: { in: ['PENDING', 'RUNNING'] } },
      select: { id: true },
    });
    if (pendingRun !== null) {
      throw new AppError(
        'ai_conversation_locked',
        'A run for this conversation is still in progress',
      );
    }

    const parsedCommand = parseChatCommand(input.request.content);
    if (parsedCommand !== null) {
      return this.executeCommand({ conversation, command: parsedCommand });
    }

    const { documentId: boundDocumentId, documentTitle } = await this.resolvePageContext({
      conversation,
      requested: input.request.documentId,
      userId: input.userId,
    });

    // Two different questions, deliberately kept apart: `documentId` records
    // where the user is standing, `pageContextEnabled` decides whether that is
    // disclosed. Removing the context chip must not make the panel forget which
    // page it is on -- it must only stop telling the model.
    const disclosedDocumentId = conversation.pageContextEnabled ? boundDocumentId : null;

    const databaseViewId = await this.resolveDatabaseViewId(
      disclosedDocumentId,
      input.request.databaseViewId ?? null,
    );

    // A conversation outlives the page it started on: the panel keeps the active
    // conversation per workspace, so walking to another page keeps typing into
    // the same transcript. Without a marker in that transcript, everything above
    // the switch silently refers to a different page than everything below --
    // and "summarize this page" would resolve against the wrong one.
    //
    // The marker names the page, so it is itself a disclosure and is suppressed
    // along with everything else when the context is off.
    const contextSwitched = boundDocumentId !== conversation.documentId;
    const announceSwitch =
      contextSwitched && conversation._count.messages > 0 && conversation.pageContextEnabled;

    const content = input.request.content;

    // Prelude entries explain the message that follows them, so they have to
    // sort before it. Explicit timestamps rather than `now()` defaults: two
    // consecutive statements are not guaranteed to land on different
    // milliseconds, and `orderBy createdAt` would then be free to invert them.
    const preludeContents: string[] = [];
    if (announceSwitch) preludeContents.push(formatContextSwitch(documentTitle));

    const selection = input.request.selection ?? null;
    if (selection !== null) {
      preludeContents.push(
        formatSelection({
          text: selection.text,
          blockIds: selection.blockIds,
          // Named from the bound page even when the page context is off: the
          // user picked this passage by hand and can see it in the chip row, so
          // saying where it came from discloses nothing they did not send.
          documentTitle,
        }),
      );
    }

    const startedAt = new Date();
    const preludeMessages = [];
    for (const [index, preludeContent] of preludeContents.entries()) {
      preludeMessages.push(
        await this.prisma.aiConversationMessage.create({
          data: {
            conversationId: conversation.id,
            role: 'SYSTEM',
            content: preludeContent,
            estimatedTokens: estimateMessageTokens({ role: 'system', content: preludeContent }),
            createdAt: new Date(startedAt.getTime() + index),
          },
        }),
      );
    }

    const userMessage = await this.prisma.aiConversationMessage.create({
      data: {
        conversationId: conversation.id,
        role: 'USER',
        content,
        estimatedTokens: estimateMessageTokens({ role: 'user', content }),
        createdAt: new Date(startedAt.getTime() + preludeMessages.length),
      },
    });

    const preludeTokens = preludeMessages.reduce(
      (sum, message) => sum + message.estimatedTokens,
      0,
    );

    const resolvedModel =
      conversation.model === null
        ? await this.modelResolver.resolveDefault(conversation.workspaceId)
        : await this.modelResolver.resolve({ slug: conversation.model.slug, allowDisabled: true });

    const requestedReasoning =
      input.request.reasoningLevel ?? REASONING_LEVEL_TO_CONTRACT[conversation.reasoningLevel];
    const clampedReasoning = this.modelResolver.clampReasoningLevel(
      resolvedModel,
      requestedReasoning,
    );

    // `messages` stores only the just-submitted user message for traceability;
    // the worker reads the live transcript from `AiConversationMessage` instead
    // of trusting a copy that could drift from it.
    const run = await this.prisma.aiRun.create({
      data: {
        workspaceId: conversation.workspaceId,
        documentId: disclosedDocumentId,
        databaseViewId,
        createdById: input.userId,
        status: 'PENDING',
        provider: resolvedModel.provider,
        model: resolvedModel.slug,
        messages: [{ role: 'user', content }] as unknown as Prisma.InputJsonValue,
        conversationId: conversation.id,
        reasoningLevel: REASONING_LEVEL_TO_PRISMA[clampedReasoning],
      },
    });

    await this.queues.enqueue(QUEUE_NAMES.ai, {
      correlationId: input.correlationId,
      runId: run.id,
      workspaceId: run.workspaceId,
      userId: input.userId,
    });

    const isPlaceholderTitle =
      conversation.title.trim().length === 0 || conversation.title === PLACEHOLDER_TITLE;
    await this.prisma.aiConversation.update({
      where: { id: conversation.id },
      data: {
        lastMessageAt: new Date(),
        estimatedTokens: { increment: userMessage.estimatedTokens + preludeTokens },
        ...(isPlaceholderTitle ? { title: deriveTitle(content) } : {}),
        ...(contextSwitched ? { documentId: boundDocumentId } : {}),
      },
    });

    this.logger.info('AI run queued for conversation', {
      runId: run.id,
      conversationId: conversation.id,
      correlationId: input.correlationId,
    });

    return {
      run: mapAiRunRow(run),
      command: null,
      userMessage: this.messageToContract(userMessage),
    };
  }

  private async executeCommand(input: {
    conversation: ConversationRow;
    command: ParsedChatCommand;
  }): Promise<PostConversationMessageResponse> {
    const { conversation, command } = input;

    const result = await runChatCommand({
      prisma: this.prisma,
      modelResolver: this.modelResolver,
      settings: this.settings,
      conversation,
      command,
    });
    return { run: null, command: result, userMessage: null };
  }

  /**
   * Which view was open, verified against the disclosed page rather than
   * trusted: a view id belonging to some other database would otherwise put
   * that database's column names and rows into the prompt.
   */
  private async resolveDatabaseViewId(
    disclosedDocumentId: string | null,
    requestedViewId: string | null,
  ): Promise<string | null> {
    if (disclosedDocumentId === null || requestedViewId === null) return null;
    const view = await this.prisma.databaseView.findFirst({
      where: { id: requestedViewId, documentId: disclosedDocumentId },
      select: { id: true },
    });
    return view?.id ?? null;
  }

  private async displayNameOf(modelId: string): Promise<string> {
    const row = await this.prisma.aiModel.findUnique({
      where: { id: modelId },
      select: { displayName: true },
    });
    return row?.displayName ?? modelId;
  }

  private async resolveFallbackContextWindow(): Promise<number | null> {
    try {
      return (await this.modelResolver.resolveDefault()).contextWindowTokens;
    } catch {
      return null;
    }
  }

  private async loadOwned(conversationId: string, userId: string): Promise<ConversationRow> {
    const conversation = await this.prisma.aiConversation.findUnique({
      where: { id: conversationId },
      select: CONVERSATION_SELECT,
    });
    if (conversation === null) throw AppError.notFound('AI conversation');

    const role = await this.access.findRole(conversation.workspaceId, userId);
    assertPolicy(canReadWorkspace(role));

    if (conversation.createdById !== userId) {
      throw AppError.forbidden('AI conversations are visible only to the user who created them');
    }
    return conversation;
  }

  private toContract(
    conversation: ConversationRow,
    fallbackContextWindowTokens: number | null,
  ): AiConversation {
    const contextWindowTokens =
      conversation.model?.contextWindowTokens ?? fallbackContextWindowTokens;
    const contextUsagePercent =
      contextWindowTokens === null || contextWindowTokens === 0
        ? 0
        : Math.min(
            100,
            Math.max(0, Math.round((conversation.estimatedTokens / contextWindowTokens) * 100)),
          );

    return {
      id: conversation.id,
      workspaceId: conversation.workspaceId,
      createdById: conversation.createdById,
      title: conversation.title,
      documentId: conversation.documentId,
      pageContextEnabled: conversation.pageContextEnabled,
      modelSlug: conversation.model?.slug ?? null,
      reasoningLevel: REASONING_LEVEL_TO_CONTRACT[conversation.reasoningLevel],
      visionCompanionSlug: conversation.visionCompanionSlug,
      estimatedTokens: conversation.estimatedTokens,
      contextUsagePercent,
      messageCount: conversation._count.messages,
      lastMessageAt: conversation.lastMessageAt.toISOString(),
      createdAt: conversation.createdAt.toISOString(),
      archivedAt: conversation.archivedAt === null ? null : conversation.archivedAt.toISOString(),
    };
  }

  private messageToContract(message: ConversationMessageRow): AiConversationMessage {
    return {
      id: message.id,
      conversationId: message.conversationId,
      role: CONVERSATION_ROLE_TO_CONTRACT[message.role],
      content: message.content,
      toolName: message.toolName,
      toolCallId: message.toolCallId,
      isSummary: message.isSummary,
      superseded: message.supersededAt !== null,
      runId: message.runId,
      createdAt: message.createdAt.toISOString(),
    };
  }
}
