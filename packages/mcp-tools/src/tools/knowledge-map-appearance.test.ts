import { describe, expect, it } from 'vitest';

import { DEFAULT_KNOWLEDGE_MAP_APPEARANCE } from '@exocortex/contracts';

import { renderKnowledgeMapAppearance } from './preferences.js';

describe('renderKnowledgeMapAppearance', () => {
  it('says whether the look was ever tuned and names every colour', () => {
    const text = renderKnowledgeMapAppearance({
      appearance: DEFAULT_KNOWLEDGE_MAP_APPEARANCE,
      isDefault: true,
    });
    expect(text).toContain('Standard');
    expect(text).toContain('green 0.85/0.55');
    expect(text).toContain('removed 1.2');
    expect(text).toContain('Farbraum-Korrektur aus');
  });

  it('marks a personal look', () => {
    const text = renderKnowledgeMapAppearance({
      appearance: { ...DEFAULT_KNOWLEDGE_MAP_APPEARANCE, colourCorrection: true },
      isDefault: false,
    });
    expect(text).toContain('persönlich angepasst');
    expect(text).toContain('Farbraum-Korrektur an');
  });
});
