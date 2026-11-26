import { type AiProvider } from '@exocortex/ai';
import {
  AI_CONVERSATION_COMPACTION_LEASE_MS,
  type AiConversationCompactionError,
  type QUEUE_NAMES,
  type Settings,
} from '@exocortex/contracts';
import { type PrismaClient } from '@exocortex/database';
import { type JobHandler, type RedisEventBus } from '@exocortex/queue';

import { type ResolvedAiKey, WorkspaceKeyUnreadableError } from '../ai-key';
import { compactOnRequest } from '../compaction';

export interface ConversationCompactionDependencies {
  prisma: PrismaClient;
  bus: RedisEventBus;
  settings: (workspaceId?: string) => Promise<Settings>;
  /** The same resolution an AI run uses, so the same key pays (ADR-090, ADR-091). */
  providerFor: (
    workspaceId: string,
    providerId?: string,
  ) => Promise<{ provider: AiProvider; key: ResolvedAiKey; openRouter?: AiProvider }>;
}

/**
 * Summarises a conversation's history because somebody asked for it (issue
 * #287), and frees the conversation again whatever came of it.
 *
 * The request is the row's `compactRequestedAt`: a job that finds it cleared
 * or older than the lease does nothing, because the conversation has already
 * been given back to its owner and new messages may have arrived since. The
 * outcome is told twice, as `compactionError` on the row (what a reader of
 * the conversation sees later, an agent included) and as an event (what the
 * open panel shows now).
 */
export function createConversationCompactionProcessor(
  dependencies: ConversationCompactionDependencies,
): JobHandler<typeof QUEUE_NAMES.conversationCompaction> {
  const { prisma, bus } = dependencies;

  return async ({ payload, logger }) => {
    const conversation = await prisma.aiConversation.findUnique({
      where: { id: payload.conversationId },
      select: { id: true, compactRequestedAt: true },
    });
    const requestedAt = conversation?.compactRequestedAt ?? null;
    if (
      conversation === null ||
      requestedAt === null ||
      Date.now() - requestedAt.getTime() > AI_CONVERSATION_COMPACTION_LEASE_MS
    ) {
      logger.info('Requested compaction skipped: the request is gone or has expired', {
        conversationId: payload.conversationId,
      });
      return { outcome: 'skipped' };
    }

    const settle = async (error: AiConversationCompactionError | null): Promise<void> => {
      // Only the request this job was for: a newer one belongs to its own job.
      await prisma.aiConversation.updateMany({
        where: { id: conversation.id, compactRequestedAt: requestedAt },
        data: { compactRequestedAt: null, compactionError: error },
      });
      if (error === null) return;
      await bus.publish({
        type: 'ai.conversation.compaction_failed',
        workspaceId: payload.workspaceId,
        correlationId: payload.correlationId,
        emittedAt: new Date().toISOString(),
        payload: { conversationId: conversation.id, errorCode: error },
      });
    };

    try {
      const settings = await dependencies.settings(payload.workspaceId);
      let resolved: Awaited<ReturnType<ConversationCompactionDependencies['providerFor']>>;
      try {
        resolved = await dependencies.providerFor(payload.workspaceId, payload.provider);
      } catch (error) {
        if (error instanceof WorkspaceKeyUnreadableError) {
          logger.warn('Requested compaction refused: the workspace key cannot be read', {
            conversationId: conversation.id,
            reason: error.reason,
          });
          await settle('key_unreadable');
          return { outcome: 'key_unreadable' };
        }
        throw error;
      }
      // The same choice a run makes: a configured compaction model is an
      // OpenRouter slug, so it never goes to a subscription endpoint.
      const compactionModel = settings['ai.compactionModelSlug'];
      const provider =
        compactionModel === null ? resolved.provider : (resolved.openRouter ?? resolved.provider);

      const result = await compactOnRequest({
        prisma,
        provider,
        bus,
        conversationId: conversation.id,
        workspaceId: payload.workspaceId,
        summaryModel: compactionModel ?? payload.model,
        correlationId: payload.correlationId,
      });

      if (result.outcome === 'provider_failed') {
        logger.warn('Requested compaction failed at the summariser', {
          conversationId: conversation.id,
          reason: result.reason,
        });
      } else {
        logger.info('Requested compaction finished', {
          conversationId: conversation.id,
          outcome: result.outcome,
          summarizedMessages: result.outcome === 'compacted' ? result.summarizedMessages : 0,
        });
      }
      await settle(result.outcome === 'compacted' ? null : result.outcome);
      return { outcome: result.outcome };
    } catch (error) {
      // An infrastructure error: the conversation must not stay held until
      // the lease runs out, and the panel must hear that nothing came of it.
      await settle('abandoned').catch(() => undefined);
      throw error;
    }
  };
}
