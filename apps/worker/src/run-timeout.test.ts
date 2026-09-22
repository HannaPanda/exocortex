import { describe, expect, it } from 'vitest';

import { describeRunTimeout, type RunTimeoutFacts } from './run-timeout';

const facts: RunTimeoutFacts = {
  limit: 'turn',
  limitMs: 180_000,
  model: 'deepseek/deepseek-v4.1-flash',
  effort: 'max',
  turnChars: 0,
  sawReasoning: true,
  toolIterations: 1,
};

describe('describeRunTimeout', () => {
  it('names the limit that ran out, the level, and that nothing was written yet', () => {
    const text = describeRunTimeout(facts);
    expect(text).toContain('3 Minuten');
    expect(text).toContain('ai.timeoutMs');
    expect(text).toContain('deepseek/deepseek-v4.1-flash');
    expect(text).toContain('„maximal“');
    expect(text).toContain('nach einer Werkzeugrunde');
    expect(text).toContain('ins Nachdenken gegangen');
    expect(text).toContain('niedrigere Denkstufe');
  });

  it('does not blame the thinking level once the answer had started', () => {
    const text = describeRunTimeout({ ...facts, turnChars: 1_234 });
    expect(text).toContain('1.234 Zeichen');
    expect(text).not.toContain('niedrigere Denkstufe');
  });

  it('does not blame the thinking level when there is none to lower', () => {
    const text = describeRunTimeout({ ...facts, effort: 'none' });
    expect(text).toContain('„keine“');
    expect(text).not.toContain('niedrigere Denkstufe');
  });

  it('names the run budget and its setting, in minutes, for the whole-run limit', () => {
    const text = describeRunTimeout({
      ...facts,
      limit: 'run',
      limitMs: 900_000,
      turnChars: 400,
      toolIterations: 12,
    });
    expect(text).toContain('15 Minuten');
    expect(text).toContain('ai.maxRunMs');
    expect(text).toContain('12 Werkzeugrunden');
    expect(text).toContain('kleinerer Schritt');
  });

  it('leaves the tool rounds out of a run that never called one', () => {
    const text = describeRunTimeout({ ...facts, toolIterations: 0 });
    expect(text).not.toContain('Werkzeugrunde');
  });
});
