import { type AiRunDiagnosis, type AiUsage } from '@exocortex/contracts';
import { Prisma, type PrismaClient } from '@exocortex/database';
import { type Logger } from '@exocortex/logger';

import { germanDiagnosis } from '../diagnosis';

import { estimateCostMicroUsd } from './ai-run/completion';

/**
 * One picture drawn for a page, as the usage report has to see it (issue #252,
 * ADR-090).
 *
 * The report reads `ai_run` and nothing else, so a picture is a row of kind
 * `IMAGE` there: workspace, page, who asked, which model, whose key paid, the
 * tokens and the price. It is written once, when the call is over, because a
 * picture has no turns and no heartbeat for the reaper to watch; a row that
 * existed while the call was running would only be a second state to keep
 * right.
 */
export interface ImageRunRecord {
  workspaceId: string;
  documentId: string;
  userId: string;
  /** What the picture was drawn from, kept like a run's prompt until retention empties it. */
  prompt: string;
  /** Who was paid: `openrouter`, or `mock`, which costs nothing. */
  provider: string;
  /** The configured slug, which is what the registry prices and names. */
  model: string;
  /** What the provider reported. Null when the call never got an answer. */
  usage: AiUsage | null;
  usedOwnKey: boolean;
  status: 'COMPLETED' | 'FAILED' | 'TIMED_OUT';
  errorCode: string | null;
  diagnosis: AiRunDiagnosis | null;
  startedAt: Date;
  finishedAt: Date;
  correlationId: string;
}

export type ImageRunRecorder = (record: ImageRunRecord) => Promise<void>;

/** The registry's prices for a model, or nulls for one it does not hold. */
export interface ImageModelPrices {
  inputMicroUsdPerMTok: number | null;
  outputMicroUsdPerMTok: number | null;
}

/**
 * The row for one picture. Pure, so the arithmetic is tested without a
 * database: `estimatedCostMicroUsd` only when the provider named no price, the
 * same rule a chat run follows (issue #10).
 */
export function imageRunData(
  record: ImageRunRecord,
  prices: ImageModelPrices,
): Prisma.AiRunUncheckedCreateInput {
  const { usage, diagnosis } = record;
  const reported = usage?.providerCostMicroUsd ?? null;
  return {
    kind: 'IMAGE',
    workspaceId: record.workspaceId,
    documentId: record.documentId,
    createdById: record.userId,
    status: record.status,
    provider: record.provider,
    model: record.model,
    messages: [{ role: 'user', content: record.prompt }],
    usage: usage === null ? Prisma.JsonNull : (usage as unknown as Prisma.InputJsonObject),
    inputTokens: usage?.inputTokens ?? null,
    outputTokens: usage?.outputTokens ?? null,
    cachedInputTokens: usage?.cachedInputTokens ?? null,
    providerCostMicroUsd: reported,
    estimatedCostMicroUsd: reported === null ? estimateCostMicroUsd(usage, prices) : null,
    durationMs: record.finishedAt.getTime() - record.startedAt.getTime(),
    usedOwnKey: record.usedOwnKey,
    errorCode: record.errorCode,
    errorDetail: diagnosis === null ? null : germanDiagnosis(diagnosis),
    errorDetailKey: diagnosis?.key ?? null,
    errorDetailArgs:
      diagnosis === null ? Prisma.JsonNull : (diagnosis.args as unknown as Prisma.InputJsonObject),
    createdAt: record.startedAt,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    correlationId: record.correlationId,
  };
}

/**
 * Writes the row, and never fails the cover for it: a picture that was drawn
 * and installed stays installed when the bookkeeping does not work out. A page
 * deleted while the picture was being drawn is the one expected failure, and
 * the row is then kept without it, because the money was spent either way.
 */
export function createImageRunRecorder(input: {
  prisma: PrismaClient;
  logger: Logger;
}): ImageRunRecorder {
  const { prisma, logger } = input;
  return async (record) => {
    try {
      const prices = (await prisma.aiModel.findUnique({
        where: { slug: record.model },
        select: { inputMicroUsdPerMTok: true, outputMicroUsdPerMTok: true },
      })) ?? { inputMicroUsdPerMTok: null, outputMicroUsdPerMTok: null };
      const data = imageRunData(record, prices);
      await prisma.aiRun.create({ data }).catch(async (error: unknown) => {
        if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2003') {
          throw error;
        }
        await prisma.aiRun.create({ data: { ...data, documentId: null } });
      });
    } catch (error: unknown) {
      logger.error('Could not record the usage of a drawn picture', error, {
        documentId: record.documentId,
        workspaceId: record.workspaceId,
        model: record.model,
      });
    }
  };
}
