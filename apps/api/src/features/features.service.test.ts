import { describe, expect, it } from 'vitest';

import { FEATURE_AREAS, featureListResponseSchema, type Locale } from '@exocortex/contracts';
import { type PrismaClient } from '@exocortex/database';
import { FEATURES } from '@exocortex/features';

import { FeaturesService } from './features.service';

/** The two reads `list` makes, and nothing else: no marker, a chosen locale. */
function service(locale: Locale | null): FeaturesService {
  const prisma = {
    user: { findUnique: async () => ({ locale }) },
    userFeatureSeen: { findUnique: async () => null },
  } as unknown as PrismaClient;
  return new FeaturesService(prisma);
}

describe('FeaturesService.list', () => {
  it('puts the registry and the German catalogue together into the wire shape', async () => {
    const result = await service('de').list('user-1', {});
    expect(featureListResponseSchema.safeParse(result).success).toBe(true);
    expect(result.features).toHaveLength(FEATURES.length);
    for (const feature of result.features) {
      // A raw key where a sentence belongs means the catalogue lost an entry.
      expect(feature.title, feature.id).not.toContain(`${feature.id}.title`);
      expect(feature.details.length, feature.id).toBeGreaterThan(0);
    }
    expect(result.areas.map((area) => area.id)).toEqual([...FEATURE_AREAS]);
  });

  it('keeps a door in the browser exactly where the registry has one', async () => {
    const result = await service('de').list('user-1', {});
    const registered = new Map(FEATURES.map((feature) => [feature.id, feature]));
    for (const feature of result.features) {
      const ui = registered.get(feature.id)?.access.ui ?? null;
      expect(feature.access.ui === null, feature.id).toBe(ui === null);
      if (feature.access.ui !== null) expect(feature.access.ui.path).toBe(ui?.path ?? null);
    }
  });

  it('breaks ties on one day by the title as the reader sees it', async () => {
    const { features } = await service('de').list('user-1', {});
    const collator = new Intl.Collator('de');
    for (let index = 1; index < features.length; index += 1) {
      const previous = features[index - 1]!;
      const current = features[index]!;
      if (previous.area !== current.area || previous.since !== current.since) continue;
      expect(collator.compare(previous.title, current.title)).toBeLessThanOrEqual(0);
    }
  });

  it('answers in any supported locale, with German behind a missing translation', async () => {
    const result = await service('fr').list('user-1', {});
    expect(featureListResponseSchema.safeParse(result).success).toBe(true);
    expect(result.features.every((feature) => feature.title.length > 0)).toBe(true);
  });
});
