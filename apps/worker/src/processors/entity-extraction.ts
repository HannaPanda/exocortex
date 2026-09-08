import { type Settings } from '@exocortex/contracts';
import {
  knownAliasKeys,
  loadEntityRegistry,
  type PrismaClient,
  replaceEntityCandidateSightings,
  replaceEntityMentions,
  toAliasCandidates,
} from '@exocortex/database';
import { findEntityPhrases, matchEntityAliases } from '@exocortex/editor';
import { type Logger } from '@exocortex/logger';

/**
 * Which entities a page talks about, worked out as it is materialized
 * (issue #47).
 *
 * Part of the materialization pass rather than a job of its own, for the same
 * reason the reference index is: it is derived from the same content in the
 * same way Markdown and the plain text are, and one place that turns content
 * into derived data is the point of ADR-007.
 *
 * Nothing here asks a model. The alias match is deterministic, free and gives
 * the same answer twice, which is what makes re-running the pass safe.
 */

/**
 * How long the registry is reused between pages.
 *
 * An import or a restore materializes hundreds of pages in a row, and loading
 * the same short list of entities for each of them is the one avoidable cost in
 * this pass. Thirty seconds is long enough to cover a burst and short enough
 * that an entity created by hand is matched almost immediately -- and the
 * rescan job catches the pages saved inside the window anyway.
 */
const REGISTRY_TTL_MS = 30_000;

interface CachedRegistry {
  databaseId: string;
  loadedAt: number;
  candidates: ReturnType<typeof toAliasCandidates>;
  known: Set<string>;
}

let cache: CachedRegistry | null = null;

/** Drops the cached registry. Called by the rescan job, which has just changed it. */
export function invalidateEntityRegistryCache(): void {
  cache = null;
}

async function registryFor(prisma: PrismaClient, databaseId: string): Promise<CachedRegistry> {
  const now = Date.now();
  if (cache !== null && cache.databaseId === databaseId && now - cache.loadedAt < REGISTRY_TTL_MS) {
    return cache;
  }
  const entities = await loadEntityRegistry(prisma, databaseId);
  cache = {
    databaseId,
    loadedAt: now,
    candidates: toAliasCandidates(entities),
    known: knownAliasKeys(entities),
  };
  return cache;
}

export interface EntityExtractionResult {
  mentions: number;
  candidates: number;
}

/**
 * Rewrites one page's entity edges and its candidate sightings.
 *
 * Returns zeroes and touches nothing when the layer is off or unconfigured,
 * which is the state every deployment starts in: the feature costs nothing
 * until somebody names a database.
 */
export async function extractEntities(
  prisma: PrismaClient,
  input: {
    documentId: string;
    workspaceId: string;
    plainText: string;
    settings: Settings;
    logger: Logger;
  },
): Promise<EntityExtractionResult> {
  const databaseId = input.settings['entities.databaseId'];
  if (!input.settings['entities.enabled'] || databaseId === null) {
    return { mentions: 0, candidates: 0 };
  }
  // The entity database's own rows are what the matcher matches *with*. Letting
  // them match themselves would give every entity a mention of itself and
  // connect every two entities whose names share a word.
  if (input.documentId === databaseId) return { mentions: 0, candidates: 0 };

  const registry = await registryFor(prisma, databaseId);
  const text = input.plainText;

  const matches = matchEntityAliases(text, registry.candidates, {
    minAliasLength: input.settings['entities.minAliasLength'],
  })
    .filter((match) => match.entityId !== input.documentId)
    .slice(0, input.settings['entities.maxMentionsPerDocument']);

  const mentions = await replaceEntityMentions(prisma, {
    documentId: input.documentId,
    workspaceId: input.workspaceId,
    mentions: matches.map((match) => ({
      entityDocumentId: match.entityId,
      alias: match.alias,
      aliasKey: match.aliasKey,
      occurrences: match.occurrences,
      context: match.context,
    })),
  });

  let candidates = 0;
  if (input.settings['entities.candidatesEnabled']) {
    const phrases = findEntityPhrases(text, {
      known: registry.known,
      minLength: input.settings['entities.minAliasLength'],
    });
    candidates = await replaceEntityCandidateSightings(prisma, {
      documentId: input.documentId,
      workspaceId: input.workspaceId,
      phrases,
    });
  }

  if (mentions > 0 || candidates > 0) {
    input.logger.debug('Entities extracted', {
      documentId: input.documentId,
      mentions,
      candidates,
    });
  }
  return { mentions, candidates };
}
