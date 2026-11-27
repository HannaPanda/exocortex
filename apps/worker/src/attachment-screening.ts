import { type DecisionProvider, screenForAiInstructions } from '@exocortex/ai';
import { type AttachmentScreening } from '@exocortex/contracts';
import { type PrismaClient } from '@exocortex/database';

const TO_COLUMN = { clean: 'CLEAN', flagged: 'FLAGGED', failed: 'FAILED' } as const;

/**
 * Asks the screening question of one file's text (ADR-096) and writes the
 * answer on its row.
 *
 * Never throws: a question that cannot be asked -- no decision model on this
 * deployment, a timeout, an error -- is recorded as `failed`, which keeps the
 * file foreign exactly like a finding does. A screening that could not run is
 * not a reason to fail the extraction or the run around it.
 */
export async function screenAttachment(input: {
  prisma: PrismaClient;
  decisions: DecisionProvider | null;
  attachmentId: string;
  text: string;
  correlationId: string;
  logger: {
    info: (message: string, context?: Record<string, unknown>) => void;
    warn: (message: string, context?: Record<string, unknown>) => void;
  };
}): Promise<AttachmentScreening> {
  const { prisma, logger, attachmentId } = input;
  let screening: AttachmentScreening = 'failed';
  let score: number | null = null;
  let model: string | null = null;
  if (input.decisions === null) {
    logger.info('No decision model to screen an attachment with; it stays foreign', {
      attachmentId,
    });
  } else {
    try {
      const result = await screenForAiInstructions({
        decisions: input.decisions,
        text: input.text,
        correlationId: input.correlationId,
      });
      screening = result.screening;
      score = result.score;
      model = result.model;
      // Facts only, never the text: what was found is the file's business.
      logger.info('Attachment screened for instructions to an AI', {
        attachmentId,
        screening,
        score,
        costMicroUsd: result.costMicroUsd,
        correlationId: input.correlationId,
      });
    } catch (error) {
      logger.warn('Attachment screening failed; the file stays foreign', {
        attachmentId,
        correlationId: input.correlationId,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  await prisma.attachment.update({
    where: { id: attachmentId },
    data: {
      screening: TO_COLUMN[screening],
      screenedAt: new Date(),
      screenModel: model,
      screenScore: score,
    },
  });
  return screening;
}
