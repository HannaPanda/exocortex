import { estimateMessageTokens } from '@exocortex/ai';
import { type AiUsage, type QUEUE_NAMES } from '@exocortex/contracts';
import { type AiRun, Prisma, type PrismaClient } from '@exocortex/database';
import { type JobContext, type RedisEventBus } from '@exocortex/queue';

import { type ResolvedModelRow, type RunFailure } from './contract';

type AiJob = JobContext<typeof QUEUE_NAMES.ai>;

/** What both terminal writes need to know about how the run went. */
interface RunOutcome {
  text: string;
  usage: AiUsage | null;
  toolIterations: number;
}

const MICRO_USD_PER_MTOK_DIVISOR = 1_000_000;

/**
 * What the run cost according to the price list, for the case where the
 * provider named no price itself.
 *
 * Returns null whenever the answer would be a guess rather than a calculation:
 * no usage at all, or a model the registry does not price. Cached input tokens
 * are billed here at the full input price -- OpenRouter counts them inside
 * `prompt_tokens` and the registry holds no separate cache rate, so this
 * slightly overstates a heavily cached run. That direction is the safe one for
 * a figure that is already flagged as an estimate.
 */
function estimateCostMicroUsd(usage: AiUsage | null, modelRow: ResolvedModelRow): number | null {
  if (usage === null) return null;
  const { inputMicroUsdPerMTok, outputMicroUsdPerMTok } = modelRow;
  if (inputMicroUsdPerMTok === null || outputMicroUsdPerMTok === null) return null;
  return Math.round(
    (usage.inputTokens * inputMicroUsdPerMTok + usage.outputTokens * outputMicroUsdPerMTok) /
      MICRO_USD_PER_MTOK_DIVISOR,
  );
}

/**
 * The usage figures as the columns want them (issue #10).
 *
 * Written beside `usage`, not instead of it: the JSON keeps whatever a
 * provider reports on top of these, the columns are what the usage view groups
 * over. `estimatedCostMicroUsd` is filled only when the provider reported no
 * cost, so the two columns never both describe the same money.
 */
function usageColumns(
  usage: AiUsage | null,
  modelRow: ResolvedModelRow,
): {
  usage: Prisma.InputJsonObject | typeof Prisma.JsonNull;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  providerCostMicroUsd: number | null;
  estimatedCostMicroUsd: number | null;
  durationMs: number | null;
} {
  const reported = usage?.providerCostMicroUsd ?? null;
  return {
    usage: usage === null ? Prisma.JsonNull : (usage as unknown as Prisma.InputJsonObject),
    inputTokens: usage?.inputTokens ?? null,
    outputTokens: usage?.outputTokens ?? null,
    cachedInputTokens: usage?.cachedInputTokens ?? null,
    providerCostMicroUsd: reported,
    estimatedCostMicroUsd: reported === null ? estimateCostMicroUsd(usage, modelRow) : null,
    durationMs: usage?.durationMs ?? null,
  };
}

/**
 * Records a run that ended without an answer and tells the clients why.
 *
 * The write is status-filtered rather than a blind `update`: the row may
 * already carry a terminal status set by `POST /cancel` or by the maintenance
 * reaper while this loop was still unwinding, and that status must win.
 */
export async function writeFailure(input: {
  prisma: PrismaClient;
  bus: RedisEventBus;
  run: AiRun;
  payload: AiJob['payload'];
  logger: AiJob['logger'];
  failure: RunFailure;
  outcome: RunOutcome;
  modelRow: ResolvedModelRow;
}): Promise<void> {
  const { prisma, bus, run, payload, logger, failure, outcome } = input;
  const terminalStatus: 'CANCELLED' | 'TIMED_OUT' | 'FAILED' =
    failure.code === 'ai_cancelled'
      ? 'CANCELLED'
      : failure.code === 'ai_timeout'
        ? 'TIMED_OUT'
        : 'FAILED';

  const written = await prisma.aiRun.updateMany({
    where: { id: run.id, status: { in: ['PENDING', 'RUNNING'] } },
    data: {
      status: terminalStatus,
      errorCode: failure.code,
      finishedAt: new Date(),
      resultText: outcome.text.length > 0 ? outcome.text : null,
      ...usageColumns(outcome.usage, input.modelRow),
      toolIterations: outcome.toolIterations,
    },
  });
  if (written.count === 0) {
    logger.warn('AI run already ended elsewhere; discarding this result', { runId: run.id });
    return;
  }
  await bus.publish({
    type: 'ai.run.failed',
    workspaceId: run.workspaceId,
    correlationId: payload.correlationId,
    emittedAt: new Date().toISOString(),
    payload: {
      runId: run.id,
      status:
        terminalStatus === 'CANCELLED'
          ? 'cancelled'
          : terminalStatus === 'TIMED_OUT'
            ? 'timed_out'
            : 'failed',
      errorCode: failure.code,
      reason: failure.message,
    },
  });
  logger.warn('AI run failed', { runId: run.id, code: failure.code });
}

/**
 * Records the finished answer, appends it to the transcript and announces it.
 *
 * Same status-filtered write as the failure path: a run that was cancelled or
 * reaped while its final answer was still streaming must not be resurrected as
 * COMPLETED just because the stream itself finished cleanly.
 */
export async function writeSuccess(input: {
  prisma: PrismaClient;
  bus: RedisEventBus;
  run: AiRun;
  payload: AiJob['payload'];
  logger: AiJob['logger'];
  reportProgress: AiJob['reportProgress'];
  outcome: RunOutcome;
  modelRow: ResolvedModelRow;
}): Promise<void> {
  const { prisma, bus, run, payload, logger, reportProgress, outcome } = input;
  const written = await prisma.aiRun.updateMany({
    where: { id: run.id, status: { in: ['PENDING', 'RUNNING'] } },
    data: {
      status: 'COMPLETED',
      resultText: outcome.text,
      ...usageColumns(outcome.usage, input.modelRow),
      finishedAt: new Date(),
      toolIterations: outcome.toolIterations,
    },
  });
  if (written.count === 0) {
    logger.warn('AI run already ended elsewhere; discarding a completed result', { runId: run.id });
    return;
  }

  if (run.conversationId !== null) {
    // Only the final assistant text becomes `run.resultText` and the
    // `ai.run.completed` payload; intermediate tool-calling turns were
    // already persisted as the loop ran. The final answer still needs its own
    // row, though -- otherwise the next user message would build its context
    // from a transcript that is silently missing the assistant's actual reply.
    const finalMessage = await prisma.aiConversationMessage.create({
      data: {
        conversationId: run.conversationId,
        role: 'ASSISTANT',
        content: outcome.text,
        runId: run.id,
        estimatedTokens: estimateMessageTokens({ role: 'assistant', content: outcome.text }),
      },
    });
    await prisma.aiConversation.update({
      where: { id: run.conversationId },
      data: {
        lastMessageAt: new Date(),
        estimatedTokens: { increment: finalMessage.estimatedTokens },
      },
    });
  }

  await bus.publish({
    type: 'ai.run.completed',
    workspaceId: run.workspaceId,
    correlationId: payload.correlationId,
    emittedAt: new Date().toISOString(),
    payload: { runId: run.id, status: 'completed', text: outcome.text, usage: outcome.usage },
  });

  await reportProgress(100, 'Antwort fertig');
  logger.info('AI run completed', {
    runId: run.id,
    provider: run.provider,
    outputTokens: outcome.usage?.outputTokens ?? 0,
    toolIterations: outcome.toolIterations,
  });
}
