import { describe, expect, it } from 'vitest';

import { type WorkflowOutputField } from './workflow-graph';
import {
  checkStructuredResult,
  structuredResultSchema,
  workflowGoalPlaceholders,
} from './workflow-result';
import { validateWorkflowGraph } from './workflow-validation';

const fields: WorkflowOutputField[] = [
  { name: 'score', type: 'number', values: [], required: true },
  { name: 'verdict', type: 'enum', values: ['go', 'stop'], required: true },
  { name: 'note', type: 'string', values: [], required: false },
  { name: 'urgent', type: 'boolean', values: [], required: false },
];

/** A structured result is trusted for being checked, never for having parsed (issue #162). */
describe('checkStructuredResult', () => {
  it('accepts values that match their declared types', () => {
    const value = { score: 7, verdict: 'go', note: 'fine', urgent: false };
    expect(checkStructuredResult(fields, value, { complete: true })).toEqual([]);
  });

  it('names an undeclared field, a wrong type and a value not allowed', () => {
    expect(
      checkStructuredResult(
        fields,
        { score: '7', verdict: 'maybe', extra: 1 },
        { complete: false },
      ),
    ).toEqual([
      { field: 'extra', code: 'unknown_field' },
      { field: 'score', code: 'wrong_type' },
      { field: 'verdict', code: 'not_allowed' },
    ]);
  });

  it('asks for required fields only when the work is handed in', () => {
    expect(checkStructuredResult(fields, { score: 3 }, { complete: false })).toEqual([]);
    expect(checkStructuredResult(fields, { score: 3, verdict: null }, { complete: true })).toEqual([
      { field: 'verdict', code: 'missing' },
    ]);
    expect(checkStructuredResult(fields, null, { complete: true })).toHaveLength(2);
  });

  it('refuses nested values before they reach the check', () => {
    expect(structuredResultSchema.safeParse({ score: { nested: 1 } }).success).toBe(false);
    expect(structuredResultSchema.safeParse({ 'bad name': 1 }).success).toBe(false);
  });
});

describe('goal placeholders', () => {
  it('finds node fields and run input', () => {
    expect(workflowGoalPlaceholders('Plan {{review.score}} for {{ input.documentId }}')).toEqual([
      { source: 'review', key: 'score' },
      { source: 'input', key: 'documentId' },
    ]);
  });

  const graph = (goal: string) => ({
    schemaVersion: 1,
    nodes: [
      { id: 'start', type: 'trigger.manual' },
      {
        id: 'review',
        type: 'agent',
        goal: 'Review',
        outputFields: [{ name: 'score', type: 'number' }],
      },
      { id: 'plan', type: 'agent', goal },
    ],
    edges: [
      {
        id: 'e1',
        kind: 'flow',
        source: { nodeId: 'start', handle: 'next' },
        target: { nodeId: 'review' },
      },
      {
        id: 'e2',
        kind: 'flow',
        source: { nodeId: 'review', handle: 'next' },
        target: { nodeId: 'plan' },
      },
    ],
  });

  const placeholderProblems = (goal: string) =>
    validateWorkflowGraph(graph(goal)).problems.filter(
      (problem) => problem.code === 'goal_placeholder_invalid',
    );

  it('accepts a field an upstream agent declares, and the run input', () => {
    expect(placeholderProblems('Plan the idea scored {{review.score}} ({{input.x}})')).toEqual([]);
  });

  it('refuses a typo, an unknown node and a node that is not upstream', () => {
    expect(placeholderProblems('{{review.socre}}')).toHaveLength(1);
    expect(placeholderProblems('{{nobody.score}}')).toHaveLength(1);
    expect(
      validateWorkflowGraph({
        ...graph('x'),
        nodes: graph('x').nodes.map((node) =>
          node.id === 'review' ? { ...node, goal: '{{plan.score}}' } : node,
        ),
      }).problems.filter((problem) => problem.code === 'goal_placeholder_invalid'),
    ).toHaveLength(1);
  });
});
