import { describe, expect, it } from 'vitest';

import { type WorkflowConditionSource, type WorkflowNodeOf } from '@exocortex/contracts';

import { conditionValue, evaluateCondition } from './handlers';

function condition(
  operator: WorkflowNodeOf<'condition'>['operator'],
  value: string | number | boolean | null = null,
): WorkflowNodeOf<'condition'> {
  return { id: 'c', type: 'condition', source: { nodeId: 'a', field: 'score' }, operator, value };
}

/** Evaluates a condition on node `a`'s output, the way the handler does. */
function holds(node: WorkflowNodeOf<'condition'>, output: Record<string, unknown> | null): boolean {
  const outputs = new Map<string, Record<string, unknown> | null>([['a', output]]);
  return evaluateCondition(node, conditionValue(node.source, { input: null, outputs }));
}

/**
 * A condition branches on a field of an agent's or an approval's `fields`
 * (issues #162, #163), or on the run's input, and a missing field takes
 * `false` (issue #161).
 */
describe('evaluateCondition', () => {
  it('compares numbers', () => {
    expect(holds(condition('gte', 7), { fields: { score: 7 } })).toBe(true);
    expect(holds(condition('gt', 7), { fields: { score: 7 } })).toBe(false);
    expect(holds(condition('lt', 7), { fields: { score: 3 } })).toBe(true);
    expect(holds(condition('lte', 7), { fields: { score: '3' } })).toBe(false);
  });

  it('treats a missing output or field as absent', () => {
    expect(holds(condition('absent'), null)).toBe(true);
    expect(holds(condition('present'), { fields: { other: 1 } })).toBe(false);
    expect(holds(condition('eq', 1), null)).toBe(false);
    expect(holds(condition('neq', 1), null)).toBe(false);
  });

  it('reads only the checked fields, never the rest of the output', () => {
    expect(holds(condition('eq', 7), { score: 7 })).toBe(false);
    expect(holds(condition('present'), { fields: null })).toBe(false);
  });

  it('reads booleans and equality', () => {
    expect(holds(condition('is_true'), { fields: { score: true } })).toBe(true);
    expect(holds(condition('is_false'), { fields: { score: 'false' } })).toBe(false);
    expect(holds(condition('eq', 'ja'), { fields: { score: 'ja' } })).toBe(true);
    expect(holds(condition('neq', 'ja'), { fields: { score: 'nein' } })).toBe(true);
  });

  it('reads a key of the run input as it is', () => {
    const source: WorkflowConditionSource = { input: 'trigger' };
    const outputs = new Map<string, Record<string, unknown> | null>();
    const input = { trigger: 'PAGE_CREATED', count: 3 };
    expect(conditionValue(source, { input, outputs })).toBe('PAGE_CREATED');
    expect(conditionValue({ input: 'missing' }, { input, outputs })).toBeUndefined();
    expect(conditionValue(source, { input: null, outputs })).toBeUndefined();
    expect(
      evaluateCondition(
        { operator: 'gt', value: 2 },
        conditionValue({ input: 'count' }, { input, outputs }),
      ),
    ).toBe(true);
  });
});
