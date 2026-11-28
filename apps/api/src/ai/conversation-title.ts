import {
  type AiConversationTitleSuggestion,
  type AiConversationTitleSuggestionResponse,
  aiConversationTitleSuggestionSchema,
  QUEUE_NAMES,
} from '@exocortex/contracts';
import { type Logger } from '@exocortex/logger';
import { type QueueRegistry, QueueWaitTimeoutError } from '@exocortex/queue';

import { type AiModelResolverService } from './ai-model-resolver.service';
import { type ConversationRow } from './conversation-mapping';

/**
 * How long a title suggestion may take before the request answers
 * `timed_out`. The worker gives the model twenty seconds; the rest is the
 * queue and a worker that may be busy with another person's dialog.
 */
export const TITLE_SUGGESTION_TIMEOUT_MS = 30_000;

export interface ConversationTitleDependencies {
  queues: QueueRegistry;
  logger: Logger;
  modelResolver: AiModelResolverService;
}

/**
 * Asks the worker for a title for a conversation and waits for it (issue
 * #233). The call is a provider call and is paid with the workspace's key,
 * which only the worker reads (ADR-090, ADR-091); the model is the one the
 * next message would run on, unless a compaction model is configured, which
 * the worker decides exactly as it does for a summary.
 *
 * Nothing is stored here: the answer is a suggestion for the rename dialog,
 * and only the person's rename stores a title. The caller has already proved
 * that the conversation is theirs.
 */
export async function suggestConversationTitle(
  dependencies: ConversationTitleDependencies,
  input: { conversation: ConversationRow; userId: string; correlationId: string },
): Promise<AiConversationTitleSuggestionResponse> {
  const { queues, logger, modelResolver } = dependencies;
  const { conversation } = input;

  const model =
    conversation.model === null
      ? await modelResolver.resolveDefault(conversation.workspaceId)
      : await modelResolver.resolve({ slug: conversation.model.slug, allowDisabled: true });

  let suggestion: AiConversationTitleSuggestion;
  try {
    const result = await queues.enqueueAndWait(
      QUEUE_NAMES.conversationTitle,
      {
        correlationId: input.correlationId,
        conversationId: conversation.id,
        workspaceId: conversation.workspaceId,
        userId: input.userId,
        model: model.slug,
        provider: model.provider,
      },
      { timeoutMs: TITLE_SUGGESTION_TIMEOUT_MS },
    );
    suggestion = aiConversationTitleSuggestionSchema.parse(result);
  } catch (error) {
    if (!(error instanceof QueueWaitTimeoutError)) throw error;
    logger.warn('Title suggestion timed out', {
      conversationId: conversation.id,
      correlationId: input.correlationId,
    });
    suggestion = { outcome: 'failed', reason: 'timed_out' };
  }

  return { conversationId: conversation.id, currentTitle: conversation.title, suggestion };
}
