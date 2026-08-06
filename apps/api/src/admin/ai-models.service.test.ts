import { describe, expect, it } from 'vitest';

import { deriveReasoningLevels } from './ai-models.service';

describe('deriveReasoningLevels', () => {
  it('offers only NONE for a model without reasoning_effort (glm-4.7-like)', () => {
    expect(
      deriveReasoningLevels({
        slug: 'z-ai/glm-4.7',
        supportedParameters: ['tools', 'response_format', 'reasoning'],
      }),
    ).toEqual(['NONE']);
  });

  it('offers the standard four levels for a non-OpenAI model with reasoning_effort (glm-5.2-like)', () => {
    expect(
      deriveReasoningLevels({
        slug: 'z-ai/glm-5.2',
        supportedParameters: ['tools', 'reasoning_effort', 'reasoning'],
      }),
    ).toEqual(['NONE', 'LOW', 'MEDIUM', 'HIGH']);
  });

  it('inserts MINIMAL after NONE for an OpenAI model with reasoning_effort (gpt-5.2-like)', () => {
    expect(
      deriveReasoningLevels({
        slug: 'openai/gpt-5.2',
        supportedParameters: ['tools', 'reasoning_effort', 'reasoning'],
      }),
    ).toEqual(['NONE', 'MINIMAL', 'LOW', 'MEDIUM', 'HIGH']);
  });

  it('does not add a level for `verbosity` alone (anthropic/claude-sonnet-5-like still needs reasoning_effort)', () => {
    expect(
      deriveReasoningLevels({
        slug: 'anthropic/claude-sonnet-5',
        supportedParameters: ['tools', 'reasoning_effort', 'reasoning', 'verbosity'],
      }),
    ).toEqual(['NONE', 'LOW', 'MEDIUM', 'HIGH']);
  });
});
