import { estimateMessageTokens } from '@exocortex/ai';
import { type AiUsage, type QUEUE_NAMES } from '@exocortex/contracts';
import { type AiRun, Prisma, type PrismaClient } from '@exocortex/database';
import { type JobContext, type RedisEventBus } from '@exocortex/queue';

import { type RunFailure } from './contract';

type AiJob = JobContext<typeof QUEUE_NAMES.ai>;

/** What both terminal writes need to know about how the run went. */
interface RunOutcome {
  text: string;
  usage: AiUsage | null;
  toolIterations: number;
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
      usage:
        outcome.usage === null
          ? Prisma.JsonNull
          : (outcome.usage as unknown as Prisma.InputJsonObject),
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
}): Promise<void> {
  const { prisma, bus, run, payload, logger, reportProgress, outcome } = input;
  const written = await prisma.aiRun.updateMany({
    where: { id: run.id, status: { in: ['PENDING', 'RUNNING'] } },
    data: {
      status: 'COMPLETED',
      resultText: outcome.text,
      usage:
        outcome.usage === null
          ? Prisma.JsonNull
          : (outcome.usage as unknown as Prisma.InputJsonObject),
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
