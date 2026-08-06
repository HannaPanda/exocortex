import { Inject, Injectable } from '@nestjs/common';

import { estimateMessageTokens } from '@exocortex/ai';
import { assertPolicy, canReadWorkspace, WorkspaceAccessService } from '@exocortex/auth';
import {
  type AiConversation,
  type AiConversationDetailResponse,
  type AiConversationListResponse,
  type AiConversationMessage,
  aiReasoningLevelSchema,
  CHAT_COMMANDS,
  type ChatCommandResult,
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
import { toolsFor } from '@exocortex/mcp-tools';
import { QueueRegistry } from '@exocortex/queue';

import { AppError } from '../common/app-error';
import { LOGGER } from '../common/logger.provider';
import { PRISMA, QUEUES } from '../platform/platform.module';
import { SettingsService } from '../platform/settings.service';

import { AiModelResolverService, REASONING_LEVEL_TO_CONTRACT, REASONING_LEVEL_TO_PRISMA } from './ai-model-resolver.service';
import { parseChatCommand,type ParsedChatCommand } from './chat-commands';
import { mapAiRunRow } from './run-mapper';

const CONVERSATION_SELECT = {
  id: true,
  workspaceId: true,
  createdById: true,
  title: true,
  documentId: true,
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

const CONVERSATION_ROLE_TO_CONTRACT: Record<AiConversationRolePrisma, AiConversationMessage['role']> = {
  SYSTEM: 'system',
  USER: 'user',
  ASSISTANT: 'assistant',
  TOOL: 'tool',
};

const PLACEHOLDER_TITLE = 'Neue Unterhaltung';
const TITLE_MAX_CHARS = 60;

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
      if (input.request.visionCompanionSlug !== null && input.request.visionCompanionSlug !== 'off') {
        await this.modelResolver.resolve({ slug: input.request.visionCompanionSlug });
      }
      data.visionCompanionSlug = input.request.visionCompanionSlug;
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
      throw new AppError('ai_conversation_locked', 'A run for this conversation is still in progress');
    }

    const parsedCommand = parseChatCommand(input.request.content);
    if (parsedCommand !== null) {
      return this.executeCommand({ conversation, command: parsedCommand });
    }

    const content = input.request.content;
    const userMessage = await this.prisma.aiConversationMessage.create({
      data: {
        conversationId: conversation.id,
        role: 'USER',
        content,
        estimatedTokens: estimateMessageTokens({ role: 'user', content }),
      },
    });

    const resolvedModel =
      conversation.model === null
        ? await this.modelResolver.resolveDefault()
        : await this.modelResolver.resolve({ slug: conversation.model.slug, allowDisabled: true });

    const requestedReasoning =
      input.request.reasoningLevel ?? REASONING_LEVEL_TO_CONTRACT[conversation.reasoningLevel];
    const clampedReasoning = this.modelResolver.clampReasoningLevel(resolvedModel, requestedReasoning);

    // `messages` stores only the just-submitted user message for traceability;
    // the worker reads the live transcript from `AiConversationMessage` instead
    // of trusting a copy that could drift from it.
    const run = await this.prisma.aiRun.create({
      data: {
        workspaceId: conversation.workspaceId,
        documentId: input.request.documentId ?? conversation.documentId ?? null,
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

    const isPlaceholderTitle = conversation.title.trim().length === 0 || conversation.title === PLACEHOLDER_TITLE;
    await this.prisma.aiConversation.update({
      where: { id: conversation.id },
      data: {
        lastMessageAt: new Date(),
        estimatedTokens: { increment: userMessage.estimatedTokens },
        ...(isPlaceholderTitle ? { title: deriveTitle(content) } : {}),
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

    const result = await this.runCommand(conversation, command);
    return { run: null, command: result, userMessage: null };
  }

  private async runCommand(
    conversation: ConversationRow,
    command: ParsedChatCommand,
  ): Promise<ChatCommandResult> {
    switch (command.name) {
      case 'clear': {
        await this.prisma.aiConversationMessage.updateMany({
          where: { conversationId: conversation.id, supersededAt: null },
          data: { supersededAt: new Date() },
        });
        await this.prisma.aiConversation.update({
          where: { id: conversation.id },
          data: { estimatedTokens: 0 },
        });
        return {
          command: 'clear',
          message: 'Kontext geleert. Der Verlauf bleibt lesbar.',
          conversationId: conversation.id,
          conversationChanged: false,
        };
      }

      case 'new': {
        const title = command.argument ?? PLACEHOLDER_TITLE;
        const created = await this.prisma.aiConversation.create({
          data: {
            workspaceId: conversation.workspaceId,
            createdById: conversation.createdById,
            title,
            modelId: conversation.modelId,
            reasoningLevel: conversation.reasoningLevel,
          },
        });
        return {
          command: 'new',
          message: `Neue Unterhaltung „${title}“ gestartet.`,
          conversationId: created.id,
          conversationChanged: true,
        };
      }

      case 'model': {
        if (command.argument === null) {
          throw AppError.validation('The /model command requires a model slug argument');
        }
        const resolved = await this.modelResolver.resolve({ slug: command.argument });
        await this.prisma.aiConversation.update({
          where: { id: conversation.id },
          data: { modelId: resolved.id },
        });
        return {
          command: 'model',
          message: `Modell gewechselt zu ${await this.displayNameOf(resolved.id)}.`,
          conversationId: conversation.id,
          conversationChanged: false,
        };
      }

      case 'think': {
        if (command.argument === null) {
          throw AppError.validation('The /think command requires a reasoning level argument');
        }
        const parsedLevel = aiReasoningLevelSchema.safeParse(command.argument);
        if (!parsedLevel.success) {
          throw AppError.validation(`Unknown reasoning level "${command.argument}"`);
        }
        const modelRow =
          conversation.model === null
            ? await this.modelResolver.resolveDefault()
            : await this.modelResolver.resolve({ slug: conversation.model.slug, allowDisabled: true });
        const clamped = this.modelResolver.clampReasoningLevel(modelRow, parsedLevel.data);
        await this.prisma.aiConversation.update({
          where: { id: conversation.id },
          data: { reasoningLevel: REASONING_LEVEL_TO_PRISMA[clamped] },
        });
        const message =
          clamped === parsedLevel.data
            ? `Denkstufe auf ${clamped} gesetzt.`
            : `${await this.displayNameOf(modelRow.id)} unterstützt diese Stufe nicht, verwende stattdessen ${clamped}.`;
        return { command: 'think', message, conversationId: conversation.id, conversationChanged: false };
      }

      case 'vision': {
        const argument = command.argument?.toLowerCase() ?? 'auto';
        if (argument === 'auto') {
          await this.prisma.aiConversation.update({
            where: { id: conversation.id },
            data: { visionCompanionSlug: null },
          });
          return {
            command: 'vision',
            message: 'Vision-Begleitmodell folgt jetzt der Admin-Voreinstellung.',
            conversationId: conversation.id,
            conversationChanged: false,
          };
        }
        if (argument === 'off') {
          await this.prisma.aiConversation.update({
            where: { id: conversation.id },
            data: { visionCompanionSlug: 'off' },
          });
          return {
            command: 'vision',
            message: 'Vision-Begleitmodell für diese Unterhaltung deaktiviert.',
            conversationId: conversation.id,
            conversationChanged: false,
          };
        }
        const resolved = await this.modelResolver.resolve({ slug: argument });
        await this.prisma.aiConversation.update({
          where: { id: conversation.id },
          data: { visionCompanionSlug: resolved.slug },
        });
        return {
          command: 'vision',
          message: `Vision-Begleitmodell auf ${await this.displayNameOf(resolved.id)} gesetzt.`,
          conversationId: conversation.id,
          conversationChanged: false,
        };
      }

      case 'compact': {
        // Compacting synchronously here would call the provider from inside the
        // API process, which rule 6 forbids. Compaction already runs
        // automatically in the worker before every provider call once the
        // context passes its threshold (see compaction.ts); `/clear` is the
        // only way to force it immediately (docs/ai-architecture.md).
        return {
          command: 'compact',
          message:
            'Der Kontext wird automatisch zusammengefasst, sobald er das Limit erreicht. Nutze /clear, um ihn sofort zu leeren.',
          conversationId: conversation.id,
          conversationChanged: false,
        };
      }

      case 'rules': {
        const rules = await this.prisma.document.findMany({
          where: { workspaceId: conversation.workspaceId, archivedAt: null, aiRuleMode: { not: 'OFF' } },
          orderBy: [{ aiRulePriority: 'asc' }, { title: 'asc' }],
          select: { title: true, aiRuleMode: true, aiRuleTrigger: true },
        });
        const message =
          rules.length === 0
            ? 'Keine aktiven KI-Regelseiten in diesem Arbeitsbereich.'
            : rules
                .map((rule) => {
                  const kind = rule.aiRuleMode === 'ALWAYS' ? 'immer aktiv' : 'auf Anfrage';
                  const trigger = rule.aiRuleTrigger !== null ? `: ${rule.aiRuleTrigger}` : '';
                  return `- ${rule.title} (${kind})${trigger}`;
                })
                .join('\n');
        return { command: 'rules', message, conversationId: conversation.id, conversationChanged: false };
      }

      case 'tools': {
        const includeMutating = await this.settings.getKey('ai.mutatingToolsEnabled');
        const tools = toolsFor('ai', { includeMutating });
        const message =
          tools.length === 0
            ? 'Keine Werkzeuge verfügbar.'
            : tools.map((tool) => `- ${tool.name} — ${tool.description}`).join('\n');
        return { command: 'tools', message, conversationId: conversation.id, conversationChanged: false };
      }

      case 'help': {
        const message = CHAT_COMMANDS.map(
          (entry) => `/${entry.name}${entry.argument !== null ? ` <${entry.argument}>` : ''} — ${entry.description}`,
        ).join('\n');
        return { command: 'help', message, conversationId: conversation.id, conversationChanged: false };
      }

      default: {
        // Unreachable: `parseChatCommand` only ever returns a name from
        // `CHAT_COMMANDS`, and every one of those is handled above.
        throw AppError.internal(`Unhandled chat command "${command.name}"`);
      }
    }
  }

  private async displayNameOf(modelId: string): Promise<string> {
    const row = await this.prisma.aiModel.findUnique({ where: { id: modelId }, select: { displayName: true } });
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

  private toContract(conversation: ConversationRow, fallbackContextWindowTokens: number | null): AiConversation {
    const contextWindowTokens = conversation.model?.contextWindowTokens ?? fallbackContextWindowTokens;
    const contextUsagePercent =
      contextWindowTokens === null || contextWindowTokens === 0
        ? 0
        : Math.min(100, Math.max(0, Math.round((conversation.estimatedTokens / contextWindowTokens) * 100)));

    return {
      id: conversation.id,
      workspaceId: conversation.workspaceId,
      createdById: conversation.createdById,
      title: conversation.title,
      documentId: conversation.documentId,
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
