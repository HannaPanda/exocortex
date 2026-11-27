import { describe, expect, it } from 'vitest';

import { type DecisionProvider, type DecisionRequest } from './decision-provider';
import { SCREEN_FLAG_THRESHOLD, screenForAiInstructions, screenWindows } from './injection-screen';

/** A decision model that answers each window with the next probability in line. */
function scripted(probabilities: readonly number[]): DecisionProvider & { asked: string[] } {
  const asked: string[] = [];
  return {
    id: 'scripted',
    asked,
    decide(request: DecisionRequest) {
      asked.push(typeof request.state === 'string' ? request.state : JSON.stringify(request.state));
      const probability = probabilities[asked.length - 1] ?? 0;
      return Promise.resolve({
        answers: { instructsAi: { kind: 'yesNo', probability } },
        model: 'typesafe/jev-test',
        provider: 'test',
        latencyMs: 1,
        inputTokens: 10,
        costMicroUsd: 5,
      });
    },
  };
}

describe('screenWindows', () => {
  it('cuts a text into windows of the given size, in order', () => {
    expect(screenWindows('abcdefg', 3)).toEqual(['abc', 'def', 'g']);
    expect(screenWindows('', 3)).toEqual([]);
  });
});

describe('screenForAiInstructions', () => {
  it('calls an empty text clean without asking anybody', async () => {
    const decisions = scripted([]);
    const result = await screenForAiInstructions({ decisions, text: '  ', correlationId: 'c' });
    expect(result.screening).toBe('clean');
    expect(decisions.asked).toEqual([]);
  });

  it('answers with the worst window and stops at the first finding', async () => {
    const decisions = scripted([0.1, SCREEN_FLAG_THRESHOLD, 0.0]);
    const text = 'x'.repeat(60_000 * 2 + 10);
    const result = await screenForAiInstructions({ decisions, text, correlationId: 'c' });
    expect(result).toMatchObject({ screening: 'flagged', score: SCREEN_FLAG_THRESHOLD });
    expect(decisions.asked).toHaveLength(2);
    expect(result.costMicroUsd).toBe(10);
  });

  it('calls a text clean when every window stays below the threshold', async () => {
    const decisions = scripted([0.2]);
    const result = await screenForAiInstructions({
      decisions,
      text: 'Rechnung',
      correlationId: 'c',
    });
    expect(result).toEqual({
      screening: 'clean',
      score: 0.2,
      model: 'typesafe/jev-test',
      costMicroUsd: 5,
    });
  });

  it('throws rather than answering for a window it could not ask about', async () => {
    const decisions: DecisionProvider = {
      id: 'broken',
      decide: () => Promise.reject(new Error('unreachable')),
    };
    await expect(
      screenForAiInstructions({ decisions, text: 'Text', correlationId: 'c' }),
    ).rejects.toThrow('unreachable');
  });
});
