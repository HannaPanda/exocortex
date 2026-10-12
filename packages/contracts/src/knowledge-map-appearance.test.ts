import { describe, expect, it } from 'vitest';

import {
  DEFAULT_KNOWLEDGE_MAP_APPEARANCE,
  knowledgeMapAppearancePatchSchema,
  knowledgeMapAppearanceSchema,
  mergeKnowledgeMapAppearance,
  readKnowledgeMapAppearance,
} from './knowledge-map';

describe('knowledge map appearance', () => {
  it('ships defaults that pass its own schema', () => {
    expect(knowledgeMapAppearanceSchema.parse(DEFAULT_KNOWLEDGE_MAP_APPEARANCE)).toEqual(
      DEFAULT_KNOWLEDGE_MAP_APPEARANCE,
    );
  });

  it('changes only what a patch names', () => {
    const merged = mergeKnowledgeMapAppearance(DEFAULT_KNOWLEDGE_MAP_APPEARANCE, {
      points: { green: { glow: 0.5 } },
      bloom: { strength: 1.1 },
    });
    expect(merged.points.green).toEqual({ glow: 0.5, lightness: 0.55 });
    expect(merged.points.blue).toEqual(DEFAULT_KNOWLEDGE_MAP_APPEARANCE.points.blue);
    expect(merged.bloom).toEqual({ ...DEFAULT_KNOWLEDGE_MAP_APPEARANCE.bloom, strength: 1.1 });
    expect(merged.star).toEqual(DEFAULT_KNOWLEDGE_MAP_APPEARANCE.star);
  });

  it('refuses a value outside its range', () => {
    expect(knowledgeMapAppearancePatchSchema.safeParse({ bloom: { strength: 9 } }).success).toBe(
      false,
    );
    expect(
      knowledgeMapAppearancePatchSchema.safeParse({ points: { green: { lightness: 0.1 } } })
        .success,
    ).toBe(false);
  });

  it('reads a stored value over the defaults and falls back when it no longer fits', () => {
    expect(readKnowledgeMapAppearance(null)).toEqual(DEFAULT_KNOWLEDGE_MAP_APPEARANCE);
    expect(readKnowledgeMapAppearance({ star: { halo: 5 } }).star.halo).toBe(5);
    expect(readKnowledgeMapAppearance({ bloom: { strength: 'loud' } })).toEqual(
      DEFAULT_KNOWLEDGE_MAP_APPEARANCE,
    );
  });
});
