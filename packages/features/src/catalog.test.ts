import { describe, expect, it } from 'vitest';

import { FEATURE_AREAS, featureSchema } from '@exocortex/contracts';

import { FEATURES, findFeature, latestFeatureDate } from './catalog.js';

/**
 * What the coverage gate cannot ask.
 *
 * `scripts/check-feature-coverage.mjs` compares the catalogue against the
 * inventories in the source: it knows whether every tool is claimed. It does
 * not know whether an entry is well formed, because it reads the registry as
 * text and a scan strict enough to judge that would be a parser. So the shape
 * is checked here, where the types are real.
 */
describe('the feature catalogue', () => {
  it('matches the wire schema, apart from the field the API computes', () => {
    for (const feature of FEATURES) {
      const parsed = featureSchema.safeParse({ ...feature, isNew: false });
      expect(parsed.success, `${feature.id}: ${parsed.error?.message ?? ''}`).toBe(true);
    }
  });

  it('gives every feature an id of its own', () => {
    const ids = FEATURES.map((feature) => feature.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('never claims the same tool twice', () => {
    const owners = new Map<string, string>();
    for (const feature of FEATURES) {
      for (const tool of feature.access.tools) {
        const first = owners.get(tool);
        expect(first, `${tool} is claimed by both ${first ?? ''} and ${feature.id}`).toBe(
          undefined,
        );
        owners.set(tool, feature.id);
      }
    }
  });

  /**
   * A length, because the failure this guards against is an entry written to
   * satisfy the schema: one paragraph repeating the summary in other words.
   * Two paragraphs of a few sentences is what "how it works, how you use it,
   * where it stops" comes out at, and anything shorter than that is a teaser
   * again. The gate cannot judge whether the prose is true; it can insist
   * that somebody sat down and wrote some.
   */
  it('explains every feature in more than a teaser', () => {
    for (const feature of FEATURES) {
      expect(feature.details.length, `${feature.id} has too few paragraphs`).toBeGreaterThanOrEqual(
        2,
      );
      const written = feature.details.join(' ');
      expect(written.length, `${feature.id} says too little`).toBeGreaterThan(400);
      expect(written, `${feature.id} repeats its summary verbatim`).not.toContain(feature.summary);
    }
  });

  it('gives every feature at least one door', () => {
    for (const feature of FEATURES) {
      const doors =
        (feature.access.ui === null ? 0 : 1) +
        feature.access.shortcuts.length +
        feature.access.tools.length;
      expect(doors, `${feature.id} names no way to reach it`).toBeGreaterThan(0);
    }
  });

  it('sorts by area and then newest first', () => {
    const areaIndex = (area: string) =>
      FEATURE_AREAS.indexOf(area as (typeof FEATURE_AREAS)[number]);
    for (let index = 1; index < FEATURES.length; index += 1) {
      const previous = FEATURES[index - 1]!;
      const current = FEATURES[index]!;
      if (previous.area !== current.area) {
        expect(areaIndex(previous.area)).toBeLessThan(areaIndex(current.area));
        continue;
      }
      expect(previous.since >= current.since).toBe(true);
    }
  });

  it('dates nothing in the future of the newest entry', () => {
    const latest = latestFeatureDate();
    expect(latest).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    for (const feature of FEATURES) expect(feature.since <= latest).toBe(true);
  });

  it('finds a feature by id and nothing by a wrong one', () => {
    const first = FEATURES[0]!;
    expect(findFeature(first.id)?.title).toBe(first.title);
    expect(findFeature('no-such-feature')).toBeNull();
  });
});
