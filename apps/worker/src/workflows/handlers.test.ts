import { describe, expect, it } from 'vitest';

import { type WorkflowNodeOf } from '@exocortex/contracts';

import { evaluateCondition } from './handlers';

function condition(
  operator: WorkflowNodeOf<'condition'>['operator'],
  value: string | number | boolean | null = null,
): WorkflowNodeOf<'condition'> {
  return { id: 'c', type: 'condition', source: { nodeId: 'a', field: 'score' }, operator, value };
}

/** A condition branches on a field, and a missing field takes `false` (issue #161). */
describe('evaluateCondition', () => {
  it('compares numbers', () => {
    expect(evaluateCondition(condition('gte', 7), { score: 7 })).toBe(true);
    expect(evaluateCondition(condition('gt', 7), { score: 7 })).toBe(false);
    expect(evaluateCondition(condition('lt', 7), { score: 3 })).toBe(true);
    expect(evaluateCondition(condition('lte', 7), { score: '3' })).toBe(false);
  });

  it('treats a missing output or field as absent', () => {
    expect(evaluateCondition(condition('absent'), null)).toBe(true);
    expect(evaluateCondition(condition('present'), { other: 1 })).toBe(false);
    expect(evaluateCondition(condition('eq', 1), null)).toBe(false);
    expect(evaluateCondition(condition('neq', 1), null)).toBe(false);
  });

  it('reads booleans and equality', () => {
    expect(evaluateCondition(condition('is_true'), { score: true })).toBe(true);
    expect(evaluateCondition(condition('is_false'), { score: 'false' })).toBe(false);
    expect(evaluateCondition(condition('eq', 'ja'), { score: 'ja' })).toBe(true);
    expect(evaluateCondition(condition('neq', 'ja'), { score: 'nein' })).toBe(true);
  });
});
