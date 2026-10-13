import { type AiUsage } from '@exocortex/contracts';
import { type Prisma, type PrismaClient } from '@exocortex/database';

import { type RunExecutionInput } from './execution-types';

/**
 * What a run keeps on its conversation about the size of the prompt.
 *
 * Two numbers with different jobs (issue #193). The running estimate grows
 * with every message the next prompt will carry, tool results included; it is
 * only the meter's fallback. The provider's count of the newest turn's input
 * is the real one, because it alone sees the system prompt, the rules, the
 * page context and the tool schemas as they were sent.
 */

/** Stores one transcript message and adds its estimate to the conversation's, together. */
export async function persistCountedMessage(
  prisma: PrismaClient,
  data: Prisma.AiConversationMessageUncheckedCreateInput & { estimatedTokens: number },
): Promise<void> {
  await prisma.$transaction([
    prisma.aiConversationMessage.create({ data }),
    prisma.aiConversation.update({
      where: { id: data.conversationId },
      data: { estimatedTokens: { increment: data.estimatedTokens } },
    }),
  ]);
}

/**
 * Keeps the provider's count of this turn's prompt on the conversation.
 *
 * One small update per turn and never a reason to fail the run: a meter that
 * lags one turn is harmless.
 */
export async function recordMeasuredInput(
  input: Pick<RunExecutionInput, 'prisma' | 'run' | 'logger'>,
  usage: AiUsage | null,
): Promise<void> {
  const { prisma, run, logger } = input;
  if (run.conversationId === null || usage === null || !(usage.inputTokens > 0)) return;
  try {
    await prisma.aiConversation.update({
      where: { id: run.conversationId },
      data: { measuredInputTokens: usage.inputTokens },
    });
  } catch (error) {
    logger.warn('Could not record the measured prompt size', {
      runId: run.id,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}
