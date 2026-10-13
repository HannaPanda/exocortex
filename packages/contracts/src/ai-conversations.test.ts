import { describe, expect, it } from 'vitest';

import { contextUsagePercentOf } from './ai-conversations';

describe('contextUsagePercentOf', () => {
  it('reads a measured prompt to one decimal (issue #193)', () => {
    // The run that read 0 %: 189 934 of 1 048 576 tokens.
    expect(contextUsagePercentOf(189_934, 1_048_576)).toBe(18.1);
  });

  it('keeps a small share visible instead of rounding it to nothing', () => {
    expect(contextUsagePercentOf(3_779, 1_048_576)).toBe(0.4);
    expect(contextUsagePercentOf(1, 1_048_576)).toBe(0.1);
  });

  it('reads 0 only for an empty prompt', () => {
    expect(contextUsagePercentOf(0, 128_000)).toBe(0);
  });

  it('answers null for an unknown window rather than 0', () => {
    expect(contextUsagePercentOf(5_000, null)).toBeNull();
    expect(contextUsagePercentOf(5_000, 0)).toBeNull();
  });

  it('never exceeds 100', () => {
    expect(contextUsagePercentOf(300_000, 128_000)).toBe(100);
  });
});
