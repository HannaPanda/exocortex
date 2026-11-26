import {
  AI_CONVERSATION_COMPACTION_LEASE_MS,
  type AiConversationCompactResponse,
  QUEUE_NAMES,
} from '@exocortex/contracts';
import { type PrismaClient } from '@exocortex/database';
import { type Logger } from '@exocortex/logger';
import { type QueueRegistry } from '@exocortex/queue';

import { type SettingsService } from '../platform/settings.service';

import { type AiModelResolverService } from './ai-model-resolver.service';
import { compactionHolds, type ConversationRow } from './conversation-mapping';

export interface ConversationCompactionDependencies {
  prisma: PrismaClient;
  queues: QueueRegistry;
  logger: Logger;
  modelResolver: AiModelResolverService;
  settings: SettingsService;
}

/**
 * Asks the worker to summarise a conversation's history now (issue #287).
 *
 * The person's request is its own trigger. The automatic compaction asks
 * whether a smaller prompt would change who can serve the next turn
 * (ADR-032) and stays silent when it would not; a request is answered with a
 * summary however full the window is, and only says on the side whether the
 * automatic one would have run anyway. The summariser is a provider call, so
 * it runs in the worker; this only decides, claims the conversation and
 * queues. The caller has already proved ownership and that no run is open.
 *
 * The claim is one conditional update, so two requests at once queue one
 * job: the second finds the conversation held and answers `already_queued`.
 */
export async function requestConversationCompaction(
  dependencies: ConversationCompactionDependencies,
  input: {
    conversation: ConversationRow;
    userId: string;
    correlationId: string;
    contextUsagePercent: number | null;
  },
): Promise<AiConversationCompactResponse> {
  const { prisma, queues, logger, modelResolver } = dependencies;
  const { conversation, contextUsagePercent } = input;

  const settings = await dependencies.settings.getForWorkspace(conversation.workspaceId);
  const thresholdPercent = settings['ai.compactionThresholdPercent'];
  const messagesToSummarize = await prisma.aiConversationMessage.count({
    where: { conversationId: conversation.id, supersededAt: null },
  });
  const answer = (
    status: AiConversationCompactResponse['status'],
  ): AiConversationCompactResponse => ({
    conversationId: conversation.id,
    status,
    messagesToSummarize: status === 'nothing_to_compact' ? 0 : messagesToSummarize,
    contextUsagePercent,
    thresholdPercent,
    wouldCompactAutomatically:
      contextUsagePercent !== null && contextUsagePercent >= thresholdPercent,
  });

  if (compactionHolds(conversation.compactRequestedAt)) return answer('already_queued');
  // One message is no history to summarise: the summary would only repeat it.
  if (messagesToSummarize < 2) return answer('nothing_to_compact');

  // The model the next message would run on, resolved the way a message
  // resolves it, so the summary is written and paid for alike.
  const model =
    conversation.model === null
      ? await modelResolver.resolveDefault(conversation.workspaceId)
      : await modelResolver.resolve({ slug: conversation.model.slug, allowDisabled: true });

  const now = new Date();
  const claimed = await prisma.aiConversation.updateMany({
    where: {
      id: conversation.id,
      OR: [
        { compactRequestedAt: null },
        {
          compactRequestedAt: { lt: new Date(now.getTime() - AI_CONVERSATION_COMPACTION_LEASE_MS) },
        },
      ],
    },
    data: { compactRequestedAt: now, compactionError: null },
  });
  if (claimed.count === 0) return answer('already_queued');

  try {
    await queues.enqueue(QUEUE_NAMES.conversationCompaction, {
      correlationId: input.correlationId,
      conversationId: conversation.id,
      workspaceId: conversation.workspaceId,
      userId: input.userId,
      model: model.slug,
      provider: model.provider,
    });
  } catch (error) {
    // Nothing will settle a request that never reached the queue, so give
    // the conversation back rather than hold it for the whole lease.
    await prisma.aiConversation.updateMany({
      where: { id: conversation.id, compactRequestedAt: now },
      data: { compactRequestedAt: null },
    });
    throw error;
  }

  logger.info('Compaction requested for conversation', {
    conversationId: conversation.id,
    messagesToSummarize,
    contextUsagePercent,
    thresholdPercent,
    correlationId: input.correlationId,
  });
  return answer('queued');
}
