import { describe, expect, it } from 'vitest';

import { type WorkflowNodeOf } from '@exocortex/contracts';

import { evaluateCondition } from './handlers';

function condition(
  operator: WorkflowNodeOf<'condition'>['operator'],
  value: string | number | boolean | null = null,
): WorkflowNodeOf<'condition'> {
  return { id: 'c', type: 'condition', source: { nodeId: 'a', field: 'score' }, operator, value };
}

/**
 * A condition branches on a field of an agent's `fields` (issue #162), and a
 * missing field takes `false` (issue #161).
 */
describe('evaluateCondition', () => {
  it('compares numbers', () => {
    expect(evaluateCondition(condition('gte', 7), { fields: { score: 7 } })).toBe(true);
    expect(evaluateCondition(condition('gt', 7), { fields: { score: 7 } })).toBe(false);
    expect(evaluateCondition(condition('lt', 7), { fields: { score: 3 } })).toBe(true);
    expect(evaluateCondition(condition('lte', 7), { fields: { score: '3' } })).toBe(false);
  });

  it('treats a missing output or field as absent', () => {
    expect(evaluateCondition(condition('absent'), null)).toBe(true);
    expect(evaluateCondition(condition('present'), { fields: { other: 1 } })).toBe(false);
    expect(evaluateCondition(condition('eq', 1), null)).toBe(false);
    expect(evaluateCondition(condition('neq', 1), null)).toBe(false);
  });

  it('reads only the checked fields, never the rest of the output', () => {
    expect(evaluateCondition(condition('eq', 7), { score: 7 })).toBe(false);
    expect(evaluateCondition(condition('present'), { fields: null })).toBe(false);
  });

  it('reads booleans and equality', () => {
    expect(evaluateCondition(condition('is_true'), { fields: { score: true } })).toBe(true);
    expect(evaluateCondition(condition('is_false'), { fields: { score: 'false' } })).toBe(false);
    expect(evaluateCondition(condition('eq', 'ja'), { fields: { score: 'ja' } })).toBe(true);
    expect(evaluateCondition(condition('neq', 'ja'), { fields: { score: 'nein' } })).toBe(true);
  });
});
