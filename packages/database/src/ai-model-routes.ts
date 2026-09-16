import { type PrismaClient } from './client';

/**
 * Persisting a model's endpoint snapshot (issue #68, ADR-032).
 *
 * Two callers write it -- the admin sync in the API and the scheduled refresh in
 * the worker -- so the transaction lives here rather than twice. What a snapshot
 * should say is decided in `@exocortex/ai`; this only writes it down, coherently.
 */

/** One provider's offer, as the caller derived it from the provider's catalogue. */
export interface ModelEndpointInput {
  providerKey: string;
  providerName: string;
  contextWindowTokens: number;
  maxPromptTokens: number | null;
  maxOutputTokens: number | null;
  inputMicroUsdPerMTok: number;
  outputMicroUsdPerMTok: number;
  supportsTools: boolean;
  supportsReasoningEffort: boolean;
  quantization: string | null;
}

/** Model-level figures the snapshot implies. Omitted when the caller keeps the current ones. */
export interface ModelRouteFields {
  contextWindowTokens: number;
  maxOutputTokens: number | null;
  inputMicroUsdPerMTok: number;
  outputMicroUsdPerMTok: number;
}

export interface ModelRouteSnapshot {
  modelId: string;
  /** The slug the endpoints describe: an alias' target, or the model's own slug. */
  targetSlug: string;
  /** Set only for an alias row; `null` says the model is its own target. */
  aliasTargetSlug: string | null;
  endpoints: readonly ModelEndpointInput[];
  fields?: ModelRouteFields;
}

export interface ModelRouteSnapshotResult {
  written: number;
  removed: number;
}

/**
 * Replaces one model's endpoint snapshot in a single transaction.
 *
 * All or nothing on purpose: a half-written snapshot would mix two providers'
 * capacities, and after an alias moved it would mix two *models*. An empty
 * endpoint list is never written -- a provider that cannot answer must leave the
 * previous, coherent snapshot standing rather than erase it (issue #68).
 */
export async function applyModelRouteSnapshot(
  prisma: PrismaClient,
  snapshot: ModelRouteSnapshot,
): Promise<ModelRouteSnapshotResult> {
  if (snapshot.endpoints.length === 0) {
    return { written: 0, removed: 0 };
  }

  const keptKeys = snapshot.endpoints.map((endpoint) => endpoint.providerKey);

  return prisma.$transaction(async (tx) => {
    const removed = await tx.aiModelEndpoint.deleteMany({
      where: { modelId: snapshot.modelId, providerKey: { notIn: keptKeys } },
    });

    for (const endpoint of snapshot.endpoints) {
      const row = { ...endpoint, targetSlug: snapshot.targetSlug };
      await tx.aiModelEndpoint.upsert({
        where: {
          modelId_providerKey: { modelId: snapshot.modelId, providerKey: endpoint.providerKey },
        },
        create: { modelId: snapshot.modelId, ...row },
        update: row,
      });
    }

    await tx.aiModel.update({
      where: { id: snapshot.modelId },
      data: {
        aliasTargetSlug: snapshot.aliasTargetSlug,
        endpointsSyncedAt: new Date(),
        // A refresh that got this far describes the model the row names again.
        endpointsStaleSince: null,
        ...(snapshot.fields ?? {}),
      },
    });

    return { written: snapshot.endpoints.length, removed: removed.count };
  });
}
