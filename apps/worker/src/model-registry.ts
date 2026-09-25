import { type PrismaClient } from '@exocortex/database';

import { type ResolvedModelRow } from './processors/ai-run';

/**
 * One registry row as a run reads it, endpoint snapshot included.
 *
 * Outside `createWorkerRuntime` so the function that wires a dozen factories
 * together does not also hold a query.
 */
export async function readModelRow(
  prisma: PrismaClient,
  slug: string,
): Promise<ResolvedModelRow | null> {
  const row = await prisma.aiModel.findUnique({
    where: { slug },
    include: {
      visionCompanion: { select: { slug: true } },
      // The endpoint snapshot travels with the row: every turn plans its
      // route from it (ADR-032), so fetching it separately would mean one
      // more query per turn for data that never changes mid-run.
      endpoints: {
        select: {
          providerKey: true,
          contextWindowTokens: true,
          maxPromptTokens: true,
          maxOutputTokens: true,
          supportsTools: true,
          supportsReasoningEffort: true,
        },
      },
    },
  });
  if (row === null) return null;
  return {
    id: row.id,
    slug: row.slug,
    provider: row.provider,
    contextWindowTokens: row.contextWindowTokens,
    maxOutputTokens: row.maxOutputTokens,
    supportsVision: row.supportsVision,
    supportsTools: row.supportsTools,
    reasoningLevels: row.reasoningLevels,
    visionCompanionSlug: row.visionCompanion?.slug ?? null,
    inputMicroUsdPerMTok: row.inputMicroUsdPerMTok,
    outputMicroUsdPerMTok: row.outputMicroUsdPerMTok,
    endpoints: row.endpoints,
    aliasTargetSlug: row.aliasTargetSlug,
  };
}
