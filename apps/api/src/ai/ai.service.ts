import { Inject, Injectable } from '@nestjs/common';

import { type AiProvider } from '@exocortex/ai';
import { assertPolicy, canCreateDocument, WorkspaceAccessService } from '@exocortex/auth';
import {
  type AiRun,
  type CreateAiRunRequest,
  QUEUE_NAMES,
} from '@exocortex/contracts';
import { type Prisma, type PrismaClient } from '@exocortex/database';
import { type Logger } from '@exocortex/logger';
import { QueueRegistry } from '@exocortex/queue';

import { AppError } from '../common/app-error';
import { LOGGER } from '../common/logger.provider';
import { AI_DEFAULT_MODEL, AI_PROVIDER, PRISMA, QUEUES } from '../platform/platform.module';

const STATUS_MAP = {
  PENDING: 'pending',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  TIMED_OUT: 'timed_out',
} as const;

// Widened in plan-01 (conversations/tool loop, briefs 02/04 build on this):
// every existing run resolves to NONE/0 through these columns' defaults.
const REASONING_LEVEL_MAP = {
  NONE: 'none',
  MINIMAL: 'minimal',
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
} as const;

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
    @Inject(AI_DEFAULT_MODEL) private readonly defaultModel: string,
    @Inject(LOGGER) private readonly logger: Logger,
    private readonly access: WorkspaceAccessService,
  ) {}

  async createRun(input: {
    userId: string;
    request: CreateAiRunRequest;
    correlationId: string;
  }): Promise<AiRun> {
    const role = await this.access.findRole(input.request.workspaceId, input.userId);
    assertPolicy(canCreateDocument(role));

    if (input.request.documentId != null) {
      const context = await this.access.findDocumentContext(input.request.documentId, input.userId);
      if (context === null || context.workspaceId !== input.request.workspaceId) {
        throw new AppError('document_access_denied', 'The referenced document is not accessible');
      }
    }

    // `capabilities.models` is empty for OpenRouter ("provider decides"), so the
    // literal string 'default' used to be persisted and sent as the model id
    // verbatim -- this now falls through to the actually configured default.
    const model = input.request.model ?? this.provider.capabilities.models[0] ?? this.defaultModel;

    const run = await this.prisma.aiRun.create({
      data: {
        workspaceId: input.request.workspaceId,
        documentId: input.request.documentId ?? null,
        createdById: input.userId,
        status: 'PENDING',
        provider: this.provider.id,
        model,
        messages: input.request.messages as unknown as Prisma.InputJsonValue,
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

    return this.toContract(run);
  }

  async getRun(runId: string, userId: string): Promise<AiRun> {
    const run = await this.prisma.aiRun.findUnique({ where: { id: runId } });
    if (run === null) throw AppError.notFound('AI run');
    await this.access.requireRole(run.workspaceId, userId);
    return this.toContract(run);
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
    return this.toContract(updated);
  }

  private toContract(run: {
    id: string;
    workspaceId: string;
    documentId: string | null;
    status: keyof typeof STATUS_MAP;
    provider: string;
    model: string;
    createdById: string;
    createdAt: Date;
    finishedAt: Date | null;
    usage: unknown;
    errorCode: string | null;
    conversationId: string | null;
    reasoningLevel: keyof typeof REASONING_LEVEL_MAP;
    toolIterations: number;
  }): AiRun {
    return {
      id: run.id,
      workspaceId: run.workspaceId,
      documentId: run.documentId,
      status: STATUS_MAP[run.status],
      provider: run.provider,
      model: run.model,
      createdById: run.createdById,
      createdAt: run.createdAt.toISOString(),
      finishedAt: run.finishedAt === null ? null : run.finishedAt.toISOString(),
      usage: run.usage === null ? null : (run.usage as AiRun['usage']),
      errorCode: run.errorCode,
      conversationId: run.conversationId,
      reasoningLevel: REASONING_LEVEL_MAP[run.reasoningLevel],
      toolIterations: run.toolIterations,
    };
  }
}
