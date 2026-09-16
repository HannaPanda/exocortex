import { describe, expect, it } from 'vitest';

import { aiModelVendorLabel, clampReasoningLevel, groupAiModelsByVendor } from './ai-models';

/**
 * Thinking-level clamping (issue #67).
 *
 * The API clamps what it asks the provider for; the browser clamps what the
 * picker shows for a remembered preference. One implementation, so the two can
 * never disagree about what `high` means on a model that offers `low` at most.
 */
describe('clampReasoningLevel', () => {
  it('keeps a level the model offers', () => {
    expect(clampReasoningLevel(['none', 'low', 'high'], 'high')).toBe('high');
  });

  it('falls back to the strongest level below the request', () => {
    expect(clampReasoningLevel(['none', 'minimal', 'low'], 'high')).toBe('low');
  });

  it('never climbs above the request', () => {
    expect(clampReasoningLevel(['none', 'high'], 'low')).toBe('none');
  });

  it('answers none for a model without a selectable level', () => {
    expect(clampReasoningLevel(['none'], 'medium')).toBe('none');
    expect(clampReasoningLevel([], 'medium')).toBe('none');
  });
});

/**
 * Vendor grouping (issue #67). Derived from the slug on purpose: `provider` on
 * the row says who serves a model, not who made it.
 */
describe('aiModelVendorLabel', () => {
  it('spells the known vendors the way they spell themselves', () => {
    expect(aiModelVendorLabel('openai/gpt-5')).toBe('OpenAI');
    expect(aiModelVendorLabel('z-ai/glm-4.6')).toBe('Z.ai');
    expect(aiModelVendorLabel('x-ai/grok-4')).toBe('xAI');
  });

  it('title-cases an unknown vendor instead of showing the slug fragment', () => {
    expect(aiModelVendorLabel('brand-new/model-1')).toBe('Brand New');
  });

  it('treats a slug without a vendor segment as its own vendor', () => {
    expect(aiModelVendorLabel('mock')).toBe('Mock');
  });
});

describe('groupAiModelsByVendor', () => {
  it('keeps the incoming order and puts a group where its first model is', () => {
    const groups = groupAiModelsByVendor([
      { slug: 'openai/gpt-5' },
      { slug: 'z-ai/glm-4.6' },
      { slug: 'openai/gpt-5-mini' },
    ]);

    expect(groups.map((group) => group.label)).toEqual(['OpenAI', 'Z.ai']);
    expect(groups[0].models.map((model) => model.slug)).toEqual([
      'openai/gpt-5',
      'openai/gpt-5-mini',
    ]);
  });
});
