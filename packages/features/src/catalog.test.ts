import { describe, expect, it } from 'vitest';

import { FEATURE_AREAS } from '@exocortex/contracts';

import { FEATURES, findFeature, latestFeatureDate } from './catalog.js';

/**
 * What the coverage gate cannot ask.
 *
 * `scripts/check-feature-coverage.mjs` compares the catalogue against the
 * inventories in the source: it knows whether every tool is claimed. It does
 * not know whether an entry is well formed, because it reads the registry as
 * text and a scan strict enough to judge that would be a parser. So the shape
 * is checked here, where the types are real.
 *
 * The words are the exception. They live in the message catalogue, which this
 * package does not import, so whether every entry has a title, a summary and
 * more than a teaser of prose is the gate's question now: it reads the German
 * catalogue as JSON beside the registry.
 */
describe('the feature catalogue', () => {
  it('writes ids the help page can use as anchors', () => {
    for (const feature of FEATURES) expect(feature.id).toMatch(/^[a-z0-9-]+$/);
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
    expect(findFeature(first.id)?.since).toBe(first.since);
    expect(findFeature('no-such-feature')).toBeNull();
  });
});
