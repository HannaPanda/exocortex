import { type AiProvider, estimateConversationTokens, estimateMessageTokens } from '@exocortex/ai';
import { type PrismaClient } from '@exocortex/database';
import { type Logger } from '@exocortex/logger';
import { type RedisEventBus } from '@exocortex/queue';

/** What a summary is assumed to cost once it is in the context: the summariser's own output cap. */
const SUMMARY_TOKEN_ALLOWANCE = 1_500;

const SUMMARY_PROMPT =
  'Fasse den folgenden Gesprächsverlauf so zusammen, dass die Unterhaltung ohne den Originaltext ' +
  'fortgesetzt werden kann. Behalte Entscheidungen, Fakten, Namen, IDs, offene Aufgaben und den Ton ' +
  'bei. Antworte auf Deutsch, in Stichpunkten, maximal 400 Wörter.';

export interface CompactIfNeededInput {
  prisma: PrismaClient;
  provider: AiProvider;
  bus: RedisEventBus;
  /**
   * Run this compaction is being done for, when there is one. Compaction only
   * reported itself once it was over, which from the outside was
   * indistinguishable from a stalled run for as long as the summariser took;
   * with a run id it can announce the phase while it happens (issue #6).
   */
  runId: string | null;
  conversationId: string;
  workspaceId: string;
  /**
   * The largest prompt this turn may be, in tokens: the model's window minus
   * the reserved answer, or -- once a model has an endpoint snapshot -- the
   * largest prompt any provider that can serve the request would take
   * (ADR-032). Computed by the caller, because only the caller knows which
   * providers are eligible.
   */
  budgetInputTokens: number;
  systemPromptTokens: number;
  keepRecentMessages: number;
  summaryModel: string;
  correlationId: string;
  logger: Logger;
}

export interface CompactIfNeededResult {
  compacted: boolean;
  summarizedMessages: number;
}

/**
 * The smallest prompt this conversation could be reduced to.
 *
 * Everything compaction cannot touch -- the system prompt, the recent tail it
 * keeps, and room for the summary it writes -- which is what decides whether
 * compacting would put a bigger provider back in reach at all (ADR-032). An
 * over-estimate is the safe direction: it only ever says "do not bother".
 */
export async function estimateFloorInputTokens(input: {
  prisma: PrismaClient;
  conversationId: string;
  systemPromptTokens: number;
  keepRecentMessages: number;
}): Promise<number> {
  const active = await input.prisma.aiConversationMessage.findMany({
    where: { conversationId: input.conversationId, supersededAt: null },
    orderBy: { createdAt: 'asc' },
    select: { estimatedTokens: true },
  });
  const tail = active.slice(Math.max(0, active.length - input.keepRecentMessages));
  const tailTokens = tail.reduce((sum, message) => sum + message.estimatedTokens, 0);
  return input.systemPromptTokens + tailTokens + SUMMARY_TOKEN_ALLOWANCE;
}

/**
 * Summarize-and-truncate compaction, keyed to the budget the caller computed.
 *
 * Runs before the provider call. Token counts are estimates
 * (`estimateTokens`), which is why the budget sits at a configurable share of
 * the window rather than at the window itself.
 */
export async function compactIfNeeded(input: CompactIfNeededInput): Promise<CompactIfNeededResult> {
  const active = await input.prisma.aiConversationMessage.findMany({
    where: { conversationId: input.conversationId, supersededAt: null },
    orderBy: { createdAt: 'asc' },
  });

  const usedTokens =
    input.systemPromptTokens +
    estimateConversationTokens(
      active.map((message) => ({ role: message.role, content: message.content })),
    );
  const budget = input.budgetInputTokens;

  if (usedTokens <= budget) {
    return { compacted: false, summarizedMessages: 0 };
  }

  const toSummarize = active.slice(0, Math.max(0, active.length - input.keepRecentMessages));
  if (toSummarize.length < 2) {
    // Nothing meaningful can be freed: the recent tail alone already exceeds
    // the budget. The run proceeds and the provider will complain, which is
    // better than silently deleting the user's latest question.
    input.logger.warn('Compaction skipped: the recent tail alone already exceeds the budget', {
      conversationId: input.conversationId,
      usedTokens,
      budget,
    });
    return { compacted: false, summarizedMessages: 0 };
  }

  const transcript = toSummarize
    .map((message) => `${message.role}: ${message.content}`)
    .join('\n\n');

  // Announced before the summariser call, not after it: this is the silence
  // that has to be named while it lasts.
  if (input.runId !== null) {
    await input.bus.publish({
      type: 'ai.run.phase',
      workspaceId: input.workspaceId,
      correlationId: input.correlationId,
      emittedAt: new Date().toISOString(),
      payload: { runId: input.runId, phase: 'compacting' },
    });
  }

  let summaryText: string;
  try {
    const result = await input.provider.generate({
      messages: [
        { role: 'system', content: SUMMARY_PROMPT },
        { role: 'user', content: transcript },
      ],
      model: input.summaryModel,
      maxOutputTokens: 1_500,
      temperature: 0.2,
      correlationId: input.correlationId,
      timeoutMs: 60_000,
    });
    summaryText = result.text;
  } catch (error) {
    // A failed compaction must never fail the run: losing a compaction is
    // recoverable, losing the user's question is not.
    input.logger.warn('Compaction failed; the run proceeds with the uncompacted context', {
      conversationId: input.conversationId,
      reason: error instanceof Error ? error.message : String(error),
    });
    return { compacted: false, summarizedMessages: 0 };
  }

  const summaryContent = `Zusammenfassung des bisherigen Verlaufs:\n\n${summaryText}`;
  const summaryEstimatedTokens = estimateMessageTokens({ role: 'system', content: summaryContent });
  const summarizedIds = new Set(toSummarize.map((message) => message.id));
  const keptMessageTokens = active
    .filter((message) => !summarizedIds.has(message.id))
    .reduce((sum, message) => sum + message.estimatedTokens, 0);
  const messageTokensAfter = keptMessageTokens + summaryEstimatedTokens;

  await input.prisma.$transaction([
    input.prisma.aiConversationMessage.create({
      data: {
        conversationId: input.conversationId,
        role: 'SYSTEM',
        content: summaryContent,
        isSummary: true,
        estimatedTokens: summaryEstimatedTokens,
      },
    }),
    input.prisma.aiConversationMessage.updateMany({
      where: { id: { in: [...summarizedIds] } },
      data: { supersededAt: new Date() },
    }),
    input.prisma.aiConversation.update({
      where: { id: input.conversationId },
      data: { estimatedTokens: messageTokensAfter },
    }),
  ]);

  await input.bus.publish({
    type: 'ai.conversation.compacted',
    workspaceId: input.workspaceId,
    correlationId: input.correlationId,
    emittedAt: new Date().toISOString(),
    payload: {
      conversationId: input.conversationId,
      summarizedMessages: summarizedIds.size,
      estimatedTokensBefore: usedTokens,
      estimatedTokensAfter: input.systemPromptTokens + messageTokensAfter,
    },
  });

  return { compacted: true, summarizedMessages: summarizedIds.size };
}
