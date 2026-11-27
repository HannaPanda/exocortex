import { type AiProvider, estimateConversationTokens, estimateMessageTokens } from '@exocortex/ai';
import { type AiConversationMessage, type PrismaClient } from '@exocortex/database';
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

  const outcome = await summarizeAndSupersede({
    ...input,
    active,
    toSummarize,
    usedTokens,
  });
  if (!outcome.ok) {
    // A failed compaction must never fail the run: losing a compaction is
    // recoverable, losing the user's question is not.
    input.logger.warn('Compaction failed; the run proceeds with the uncompacted context', {
      conversationId: input.conversationId,
      reason: outcome.reason,
    });
    return { compacted: false, summarizedMessages: 0 };
  }
  return { compacted: true, summarizedMessages: outcome.summarizedMessages };
}

type SummaryOutcome = { ok: true; summarizedMessages: number } | { ok: false; reason: string };

/**
 * Writes one summary of `toSummarize` and retires those messages, in one
 * transaction once the summariser has answered. The part both triggers share:
 * the automatic one before a turn and the one a person asked for (issue #287).
 * Never throws for a provider failure; it says so instead.
 */
async function summarizeAndSupersede(input: {
  prisma: PrismaClient;
  provider: AiProvider;
  bus: RedisEventBus;
  runId: string | null;
  conversationId: string;
  workspaceId: string;
  systemPromptTokens: number;
  summaryModel: string;
  correlationId: string;
  active: AiConversationMessage[];
  toSummarize: AiConversationMessage[];
  usedTokens: number;
}): Promise<SummaryOutcome> {
  const { active, toSummarize } = input;
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
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  if (summaryText.trim().length === 0) {
    // An empty summary would retire the messages and replace them with
    // nothing, which is a `/clear` nobody asked for.
    return { ok: false, reason: 'The summariser answered with an empty text' };
  }

  const summaryContent = `Zusammenfassung des bisherigen Verlaufs:\n\n${summaryText}`;
  const summaryEstimatedTokens = estimateMessageTokens({ role: 'system', content: summaryContent });
  const summarizedIds = new Set(toSummarize.map((message) => message.id));
  const keptMessageTokens = active
    .filter((message) => !summarizedIds.has(message.id))
    .reduce((sum, message) => sum + message.estimatedTokens, 0);
  const messageTokensAfter = keptMessageTokens + summaryEstimatedTokens;

  await input.prisma.$transaction(async (tx) => {
    const summary = await tx.aiConversationMessage.create({
      data: {
        conversationId: input.conversationId,
        role: 'SYSTEM',
        content: summaryContent,
        isSummary: true,
        estimatedTokens: summaryEstimatedTokens,
      },
    });
    // Which summary took them in, so the files on them stay in the context
    // after the summary: a picture's description, a document by name (#223).
    // `/clear` retires the summary too, and the files leave with it.
    await tx.aiConversationMessage.updateMany({
      where: { id: { in: [...summarizedIds] } },
      data: { supersededAt: new Date(), summarizedIntoId: summary.id },
    });
    await tx.aiConversation.update({
      where: { id: input.conversationId },
      // The last measured prompt described the transcript just superseded;
      // the next turn measures the compacted one.
      data: { estimatedTokens: messageTokensAfter, measuredInputTokens: null },
    });
  });

  await input.bus.publish({
    type: 'ai.conversation.compacted',
    workspaceId: input.workspaceId,
    correlationId: input.correlationId,
    emittedAt: new Date().toISOString(),
    payload: {
      conversationId: input.conversationId,
      summarizedMessages: summarizedIds.size,
      estimatedTokensBefore: input.usedTokens,
      estimatedTokensAfter: input.systemPromptTokens + messageTokensAfter,
    },
  });

  return { ok: true, summarizedMessages: summarizedIds.size };
}

export interface CompactOnRequestInput {
  prisma: PrismaClient;
  provider: AiProvider;
  bus: RedisEventBus;
  conversationId: string;
  workspaceId: string;
  summaryModel: string;
  correlationId: string;
}

export type CompactOnRequestResult =
  | { outcome: 'compacted'; summarizedMessages: number }
  | { outcome: 'nothing_to_compact' }
  | { outcome: 'provider_failed'; reason: string };

/**
 * The compaction a person asked for (issue #287): `/compact`, or
 * `exo_chat_compact`.
 *
 * A different trigger from `compactIfNeeded`, and deliberately not the same
 * question. The automatic one asks whether a smaller prompt would change who
 * can serve the next turn (ADR-032) and keeps a recent tail verbatim, because
 * nobody asked it to touch the thread being worked on. A person who asks for
 * the history to be summarised has answered that question already, so there
 * is no budget here and no tail: every message still in the context goes into
 * one summary, which is what "summarise the conversation so far" means. Two
 * messages are the least worth summarising, as in the automatic case.
 */
export async function compactOnRequest(
  input: CompactOnRequestInput,
): Promise<CompactOnRequestResult> {
  const active = await input.prisma.aiConversationMessage.findMany({
    where: { conversationId: input.conversationId, supersededAt: null },
    orderBy: { createdAt: 'asc' },
  });
  if (active.length < 2) return { outcome: 'nothing_to_compact' };

  const outcome = await summarizeAndSupersede({
    ...input,
    runId: null,
    // Nothing of a system prompt is counted: no turn is being built.
    systemPromptTokens: 0,
    active,
    toSummarize: active,
    usedTokens: estimateConversationTokens(
      active.map((message) => ({ role: message.role, content: message.content })),
    ),
  });
  return outcome.ok
    ? { outcome: 'compacted', summarizedMessages: outcome.summarizedMessages }
    : { outcome: 'provider_failed', reason: outcome.reason };
}
