import { fetchOpenRouterModels, resolveModelRoutes } from '@exocortex/ai';
import { applyModelRouteSnapshot } from '@exocortex/database';

import { type MaintenanceTask } from './context';

/**
 * Models refreshed per run. The whole registry is a dozen rows on a normal
 * deployment, so this is a ceiling rather than a pace: it keeps one sweep from
 * making several hundred requests if somebody registers the entire catalogue.
 */
const BATCH_SIZE = 12;

/**
 * Context window for a provider entry that does not state one. Same conservative
 * number the admin sync uses.
 */
const FALLBACK_CONTEXT_WINDOW_TOKENS = 8192;

/**
 * Refreshes who serves the registered models (issue #68, ADR-032).
 *
 * The snapshot is what every request's provider allowlist is planned from, so
 * it has to keep up with two things that move on their own: providers coming
 * and going, and `latest` aliases pointing at a new model. Neither would
 * otherwise be noticed until an admin pressed a button.
 *
 * Stale-marked rows first (a run saw an alias answer as something else), then
 * the ones refreshed longest ago. A model whose endpoints cannot be read keeps
 * the snapshot it has: a coherent old picture beats no picture, and beats a
 * half-written new one.
 */
export const syncAiModelRoutes: MaintenanceTask = async (context) => {
  const { prisma, logger } = context;

  const models = await prisma.aiModel.findMany({
    where: { enabled: true, provider: 'openrouter' },
    orderBy: [
      { endpointsStaleSince: { sort: 'desc', nulls: 'last' } },
      { endpointsSyncedAt: { sort: 'asc', nulls: 'first' } },
    ],
    take: BATCH_SIZE,
    select: { id: true, slug: true, aliasTargetSlug: true, contextWindowTokens: true },
  });
  if (models.length === 0) return;

  const liveById = await fetchOpenRouterModels(context.openRouterBaseUrl);

  let refreshed = 0;
  let unchanged = 0;
  let failed = 0;

  for (const model of models) {
    const routes = await resolveModelRoutes({
      baseUrl: context.openRouterBaseUrl,
      slug: model.slug,
      models: liveById,
      fallbackContextWindowTokens: FALLBACK_CONTEXT_WINDOW_TOKENS,
    });

    if (routes.endpoints.length === 0) {
      failed += 1;
      logger.warn('Endpoint snapshot kept: the provider did not answer about this model', {
        slug: model.slug,
        targetSlug: routes.targetSlug,
        reason: routes.endpointFailure,
      });
      continue;
    }

    // An alias that moved gets the new target's endpoints and the new target's
    // figures in one transaction. The two must never be mixed: half of one
    // model's capacities and half of another's would be a routing plan for a
    // model that does not exist.
    const moved = routes.aliasTargetSlug !== model.aliasTargetSlug;
    const result = await applyModelRouteSnapshot(prisma, {
      modelId: model.id,
      targetSlug: routes.targetSlug,
      aliasTargetSlug: routes.aliasTargetSlug,
      endpoints: routes.endpoints,
      fields:
        routes.fields === null
          ? undefined
          : {
              contextWindowTokens: routes.fields.contextWindowTokens,
              maxOutputTokens: routes.fields.maxOutputTokens,
              inputMicroUsdPerMTok: routes.fields.inputMicroUsdPerMTok,
              outputMicroUsdPerMTok: routes.fields.outputMicroUsdPerMTok,
            },
    });

    if (moved) {
      logger.info('A latest alias now points at a different model', {
        slug: model.slug,
        from: model.aliasTargetSlug,
        to: routes.aliasTargetSlug,
      });
    }
    if (result.removed > 0 || moved) refreshed += 1;
    else unchanged += 1;
  }

  logger.info('AI model routes refreshed', {
    models: models.length,
    refreshed,
    unchanged,
    failed,
  });
};
