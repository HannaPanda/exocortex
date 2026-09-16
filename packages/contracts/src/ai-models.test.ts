import { describe, expect, it } from 'vitest';

import { clampReasoningLevel } from './ai-models';

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
