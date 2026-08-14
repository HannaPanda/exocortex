import { Inject, Injectable } from '@nestjs/common';

import { type AiProvider } from '@exocortex/ai';
import { assertPolicy, canCreateDocument, WorkspaceAccessService } from '@exocortex/auth';
import {
  type AiRun,
  type CreateAiRunRequest,
  type PostConversationMessageResponse,
  QUEUE_NAMES,
} from '@exocortex/contracts';
import { type Prisma, type PrismaClient } from '@exocortex/database';
import { type Logger } from '@exocortex/logger';
import { QueueRegistry } from '@exocortex/queue';

import { AppError } from '../common/app-error';
import { LOGGER } from '../common/logger.provider';
import { AI_PROVIDER, PRISMA, QUEUES } from '../platform/platform.module';

import {
  AiModelResolverService,
  REASONING_LEVEL_TO_PRISMA,
  type ResolvedAiModel,
} from './ai-model-resolver.service';
import { ConversationsService } from './conversations.service';
import { mapAiRunRow } from './run-mapper';

/**
 * AI run lifecycle.
 *
 * The API only records the run and enqueues it; the actual provider call happens
 * in the worker process. CLI agents (Claude Code, Codex) must never run inside
 * the API process (docs/ai-architecture.md).
 */
@Injectable()
export class AiService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(QUEUES) private readonly queues: QueueRegistry,
    @Inject(AI_PROVIDER) private readonly provider: AiProvider,
    @Inject(LOGGER) private readonly logger: Logger,
    private readonly access: WorkspaceAccessService,
    private readonly modelResolver: AiModelResolverService,
    private readonly conversations: ConversationsService,
  ) {}

  /**
   * Compatibility path for `POST /api/ai/runs`, which the current production
   * web panel calls directly.
   *
   * When `conversationId` is absent this keeps its pre-conversations
   * behaviour byte-for-byte: the submitted messages are persisted on the run
   * as-is, no conversation is touched, and tools stay off by default so the
   * legacy panel can never start mutating pages just because the tool loop
   * exists now. When `conversationId` **is** present, `messages` is ignored
   * and the call behaves exactly like `POST .../conversations/:id/messages`
   * (the last message's content, re-parsed for slash commands), so a client
   * mid-migration to the conversation API does not need two code paths.
   */
  async createRun(input: {
    userId: string;
    request: CreateAiRunRequest;
    correlationId: string;
  }): Promise<AiRun> {
    if (input.request.conversationId != null) {
      const lastMessage = [...input.request.messages]
        .reverse()
        .find((message) => message.role === 'user');
      if (lastMessage === undefined || lastMessage.content.trim().length === 0) {
        throw AppError.validation('At least one non-empty user message is required');
      }
      const response: PostConversationMessageResponse = await this.conversations.postMessage({
        conversationId: input.request.conversationId,
        userId: input.userId,
        request: {
          content: lastMessage.content,
          documentId: input.request.documentId ?? undefined,
          reasoningLevel: input.request.reasoningLevel,
          toolsEnabled: input.request.toolsEnabled,
        },
        correlationId: input.correlationId,
      });
      if (response.run !== null) return response.run;
      // A slash command was submitted through the legacy endpoint: there is no
      // run to report back, so a synthetic completed one carries the command's
      // German message instead of silently returning nothing.
      throw AppError.validation(
        'Slash commands are not supported through the legacy /api/ai/runs endpoint; use the conversation message endpoint instead',
      );
    }

    const role = await this.access.findRole(input.request.workspaceId, input.userId);
    assertPolicy(canCreateDocument(role));

    if (input.request.documentId != null) {
      const context = await this.access.findDocumentContext(input.request.documentId, input.userId);
      if (context === null || context.workspaceId !== input.request.workspaceId) {
        throw new AppError('document_access_denied', 'The referenced document is not accessible');
      }
    }

    // Resolves through the shared registry so `ai_model_unknown` /
    // `ai_model_disabled` are reported consistently everywhere a model slug is
    // accepted. The one exception is a provider that dictates its own fixed
    // model (`capabilities.models`, e.g. the mock provider used in development
    // and tests) -- that model deliberately has no registry row, exactly as
    // before this change, so it is used verbatim instead of failing a lookup.
    const fixedProviderModel = this.provider.capabilities.models[0];
    let resolvedModel: ResolvedAiModel | null = null;
    let modelSlug: string;
    if (input.request.model !== undefined) {
      resolvedModel = await this.modelResolver.resolve({ slug: input.request.model });
      modelSlug = resolvedModel.slug;
    } else if (fixedProviderModel !== undefined) {
      modelSlug = fixedProviderModel;
    } else {
      resolvedModel = await this.modelResolver.resolveDefault();
      modelSlug = resolvedModel.slug;
    }

    const requestedReasoningLevel = input.request.reasoningLevel ?? 'none';
    const clampedReasoningLevel =
      resolvedModel === null
        ? 'none'
        : this.modelResolver.clampReasoningLevel(resolvedModel, requestedReasoningLevel);

    const run = await this.prisma.aiRun.create({
      data: {
        workspaceId: input.request.workspaceId,
        documentId: input.request.documentId ?? null,
        createdById: input.userId,
        status: 'PENDING',
        provider: this.provider.id,
        model: modelSlug,
        messages: input.request.messages as unknown as Prisma.InputJsonValue,
        reasoningLevel: REASONING_LEVEL_TO_PRISMA[clampedReasoningLevel],
        // No tool loop for the legacy path: `toolsEnabled` is honoured only
        // through the conversation endpoint above, never here.
      },
    });

    await this.queues.enqueue(QUEUE_NAMES.ai, {
      correlationId: input.correlationId,
      runId: run.id,
      workspaceId: run.workspaceId,
      userId: input.userId,
    });

    this.logger.info('AI run queued', {
      runId: run.id,
      workspaceId: run.workspaceId,
      provider: this.provider.id,
      correlationId: input.correlationId,
    });

    return mapAiRunRow(run);
  }

  async getRun(runId: string, userId: string): Promise<AiRun> {
    const run = await this.prisma.aiRun.findUnique({ where: { id: runId } });
    if (run === null) throw AppError.notFound('AI run');
    await this.access.requireRole(run.workspaceId, userId);
    return mapAiRunRow(run);
  }

  /** Cancels a pending or running AI run. */
  async cancelRun(runId: string, userId: string): Promise<AiRun> {
    const run = await this.prisma.aiRun.findUnique({ where: { id: runId } });
    if (run === null) throw AppError.notFound('AI run');
    await this.access.requireRole(run.workspaceId, userId);
    if (run.status !== 'PENDING' && run.status !== 'RUNNING') {
      throw AppError.conflict('The AI run has already finished');
    }
    const updated = await this.prisma.aiRun.update({
      where: { id: runId },
      data: { status: 'CANCELLED', cancelledAt: new Date(), finishedAt: new Date() },
    });
    return mapAiRunRow(updated);
  }
}
