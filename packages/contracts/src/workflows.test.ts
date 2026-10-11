import { describe, expect, it } from 'vitest';

import {
  emptyWorkflowGraph,
  validateWorkflowGraph,
  type WorkflowGraphInput,
  workflowGraphSchema,
  type WorkflowNodeExecutionState,
  workflowProgress,
} from './index';

const LIMITS = {
  maxNodeExecutions: null,
  maxParallelBranches: null,
  maxLifetimeSeconds: null,
  budgetMicroUsd: null,
};

function edge(id: string, from: string, handle: string, to: string) {
  return { id, kind: 'flow' as const, source: { nodeId: from, handle }, target: { nodeId: to } };
}

/** trigger -> review (agent) -> decide (condition) -> approve | done */
function reviewGraph(): WorkflowGraphInput {
  return {
    schemaVersion: 1,
    nodes: [
      { id: 'start', type: 'trigger.manual' },
      {
        id: 'review',
        type: 'agent',
        goal: 'Review the open ideas and score them',
        outputFields: [
          { name: 'score', type: 'number' },
          { name: 'verdict', type: 'enum', values: ['keep', 'drop'] },
        ],
      },
      {
        id: 'decide',
        type: 'condition',
        source: { nodeId: 'review', field: 'score' },
        operator: 'gte',
        value: 5,
      },
      { id: 'approve', type: 'approval', title: 'Keep?', question: 'Shall we keep this?' },
      { id: 'done', type: 'end', outcome: 'succeeded' },
    ],
    edges: [
      edge('e1', 'start', 'next', 'review'),
      edge('e2', 'review', 'next', 'decide'),
      edge('e3', 'decide', 'true', 'approve'),
      edge('e4', 'decide', 'false', 'done'),
    ],
    limits: LIMITS,
  };
}

function codes(raw: unknown): string[] {
  return validateWorkflowGraph(raw).problems.map((problem) => problem.code);
}

describe('validateWorkflowGraph', () => {
  it('accepts a coherent graph and the empty starting graph', () => {
    expect(codes(reviewGraph())).toEqual([]);
    expect(codes(emptyWorkflowGraph())).toEqual([]);
  });

  it('refuses an unknown node type at the contract boundary and names the node', () => {
    const graph = reviewGraph();
    (graph.nodes as unknown[]).push({ id: 'shell', type: 'exec', command: 'rm -rf /' });
    const result = validateWorkflowGraph(graph);
    expect(result.graph).toBeNull();
    expect(result.problems[0]).toMatchObject({ code: 'schema_invalid', nodeId: 'shell' });
  });

  it('refuses edges to missing nodes and from handles the node does not offer', () => {
    const graph = reviewGraph();
    graph.edges.push(edge('e5', 'review', 'maybe', 'done'), edge('e6', 'done', 'next', 'ghost'));
    const problems = validateWorkflowGraph(graph).problems;
    expect(problems).toContainEqual(
      expect.objectContaining({ code: 'edge_invalid_handle', edgeId: 'e5' }),
    );
    expect(problems).toContainEqual(
      expect.objectContaining({ code: 'edge_unknown_node', edgeId: 'e6' }),
    );
  });

  it('refuses a graph without a trigger and an edge into a trigger', () => {
    expect(codes({ ...reviewGraph(), nodes: reviewGraph().nodes.slice(1) })).toContain(
      'no_trigger',
    );
    const graph = reviewGraph();
    graph.edges.push(edge('back', 'review', 'next', 'start'));
    expect(codes(graph)).toContain('edge_into_trigger');
  });

  it('refuses cycles', () => {
    const graph = reviewGraph();
    graph.nodes.push({ id: 'again', type: 'agent', goal: 'Again' });
    graph.edges = [
      edge('e1', 'start', 'next', 'review'),
      edge('e2', 'review', 'next', 'decide'),
      edge('e3', 'decide', 'true', 'again'),
      edge('e4', 'again', 'next', 'review'),
    ];
    expect(codes(graph)).toContain('cycle');
  });

  it('refuses two inputs on a node that is not a join, and nodes no trigger reaches', () => {
    const graph = reviewGraph();
    graph.edges.push(edge('e5', 'approve', 'approved', 'done'));
    graph.nodes.push({ id: 'island', type: 'end', outcome: 'failed' });
    const found = codes(graph);
    expect(found).toContain('node_multiple_inputs');
    expect(found).toContain('node_unreachable');
  });

  it('accepts parallel branches into a wait-for-all join', () => {
    const graph: WorkflowGraphInput = {
      schemaVersion: 1,
      nodes: [
        { id: 'start', type: 'trigger.manual' },
        { id: 'fan', type: 'parallel' },
        { id: 'a', type: 'agent', goal: 'A' },
        { id: 'b', type: 'agent', goal: 'B' },
        { id: 'meet', type: 'join', policy: 'all' },
      ],
      edges: [
        edge('e1', 'start', 'next', 'fan'),
        edge('e2', 'fan', 'branch', 'a'),
        edge('e3', 'fan', 'branch', 'b'),
        edge('e4', 'a', 'next', 'meet'),
        edge('e5', 'b', 'next', 'meet'),
      ],
    };
    expect(codes(graph)).toEqual([]);
    expect(codes({ ...graph, limits: { ...LIMITS, maxParallelBranches: 1 } })).toContain(
      'parallel_too_many_branches',
    );
  });

  it('refuses a wait-for-all join over the two branches of one condition', () => {
    const graph = reviewGraph();
    graph.nodes.push({ id: 'meet', type: 'join', policy: 'all' });
    graph.edges = [
      edge('e1', 'start', 'next', 'review'),
      edge('e2', 'review', 'next', 'decide'),
      edge('e3', 'decide', 'true', 'meet'),
      edge('e4', 'decide', 'false', 'meet'),
    ];
    expect(codes(graph)).toContain('join_impossible');
    graph.nodes[graph.nodes.length - 1] = { id: 'meet', type: 'join', policy: 'any' };
    expect(codes(graph)).not.toContain('join_impossible');
  });

  it('refuses a wait-for-all join fed by two different triggers', () => {
    const graph: WorkflowGraphInput = {
      schemaVersion: 1,
      nodes: [
        { id: 'byHand', type: 'trigger.manual' },
        {
          id: 'weekly',
          type: 'trigger.schedule',
          schedule: { kind: 'WEEKLY', time: '07:00', weekday: 0, timeZone: 'Europe/Berlin' },
        },
        { id: 'meet', type: 'join', policy: 'all' },
      ],
      edges: [edge('e1', 'byHand', 'next', 'meet'), edge('e2', 'weekly', 'next', 'meet')],
    };
    expect(codes(graph)).toContain('join_impossible');
  });

  it('checks a condition against the declared output of an upstream agent', () => {
    const wrongField = reviewGraph();
    (wrongField.nodes[2] as { source: { field: string } }).source.field = 'missing';
    expect(codes(wrongField)).toContain('condition_unknown_field');

    const wrongValue = reviewGraph();
    (wrongValue.nodes[2] as { value: unknown }).value = 'high';
    expect(codes(wrongValue)).toContain('condition_value_invalid');

    const wrongOperator = reviewGraph();
    Object.assign(wrongOperator.nodes[2]!, {
      source: { nodeId: 'review', field: 'verdict' },
      operator: 'gt',
      value: 'keep',
    });
    expect(codes(wrongOperator)).toContain('condition_operator_mismatch');

    const enumValue = reviewGraph();
    Object.assign(enumValue.nodes[2]!, {
      source: { nodeId: 'review', field: 'verdict' },
      operator: 'eq',
      value: 'perhaps',
    });
    expect(codes(enumValue)).toContain('condition_value_invalid');
  });

  it('lets a condition read an approval and the run input (issue #163)', () => {
    const graph = reviewGraph();
    graph.nodes.push(
      {
        id: 'answered',
        type: 'condition',
        source: { nodeId: 'approve', field: 'approved' },
        operator: 'is_true',
      },
      { id: 'kind', type: 'condition', source: { input: 'trigger' }, operator: 'eq', value: 'x' },
    );
    graph.edges.push(
      edge('e5', 'approve', 'approved', 'answered'),
      edge('e6', 'answered', 'true', 'kind'),
    );
    expect(codes(graph)).toEqual([]);

    const wrongField = structuredClone(graph);
    Object.assign(wrongField.nodes[5]!, { source: { nodeId: 'approve', field: 'score' } });
    expect(codes(wrongField)).toContain('condition_unknown_field');

    const notNumber = structuredClone(graph);
    Object.assign(notNumber.nodes[6]!, { operator: 'gt', value: 'many' });
    expect(codes(notNumber)).toContain('condition_value_invalid');

    const fromEnd = structuredClone(graph);
    Object.assign(fromEnd.nodes[5]!, { source: { nodeId: 'done', field: 'approved' } });
    expect(codes(fromEnd)).toContain('condition_unknown_source');
  });

  it('parses an approval stored before #163 with an optional note', () => {
    const parsed = workflowGraphSchema.parse(reviewGraph());
    expect(parsed.nodes[3]).toMatchObject({ type: 'approval', note: 'optional' });
  });

  it('lets a draft be saved incomplete but reports what publishing needs', () => {
    const graph = reviewGraph();
    (graph.nodes[1] as { goal: string }).goal = '';
    expect(workflowGraphSchema.safeParse(graph).success).toBe(true);
    expect(validateWorkflowGraph(graph).problems).toContainEqual(
      expect.objectContaining({ code: 'field_required', nodeId: 'review' }),
    );
  });

  it('refuses a cron that does not parse', () => {
    const graph = emptyWorkflowGraph();
    graph.nodes = [
      {
        id: 'clock',
        type: 'trigger.schedule',
        schedule: { kind: 'CRON', cron: 'every sunday', timeZone: 'Europe/Berlin' },
      },
    ];
    expect(codes(graph)).toContain('schedule_invalid');
  });
});

describe('workflowProgress', () => {
  const graph = workflowGraphSchema.parse(reviewGraph());
  const done = (nodeId: string, firedHandles: string[]): WorkflowNodeExecutionState => ({
    nodeId,
    attempt: 1,
    status: 'succeeded',
    firedHandles,
  });

  it('starts at the trigger the run was started by', () => {
    expect(workflowProgress(graph, 'start', [])).toMatchObject({
      runnable: ['start'],
      settled: false,
    });
  });

  it('follows the taken branch and marks the other one dead', () => {
    const progress = workflowProgress(graph, 'start', [
      done('start', ['next']),
      done('review', ['next']),
      done('decide', ['false']),
    ]);
    expect(progress.runnable).toEqual(['done']);
    expect(progress.dead).toEqual(['approve']);
  });

  it('reports a waiting node as active and the run as unsettled', () => {
    const progress = workflowProgress(graph, 'start', [
      done('start', ['next']),
      { nodeId: 'review', attempt: 1, status: 'waiting', firedHandles: [] },
    ]);
    expect(progress).toMatchObject({ runnable: [], active: ['review'], settled: false });
  });

  it('reads the latest attempt of a retried node', () => {
    const progress = workflowProgress(graph, 'start', [
      done('start', ['next']),
      { nodeId: 'review', attempt: 1, status: 'failed', firedHandles: [] },
      { ...done('review', ['next']), attempt: 2 },
    ]);
    expect(progress.runnable).toEqual(['decide']);
  });

  it('settles once nothing more can run', () => {
    const progress = workflowProgress(graph, 'start', [
      done('start', ['next']),
      { nodeId: 'review', attempt: 1, status: 'failed', firedHandles: [] },
    ]);
    expect(progress).toMatchObject({ runnable: [], settled: true });
    expect(progress.dead).toEqual(['decide', 'approve', 'done']);
  });

  it('joins all branches once, and gives up on a join whose branch died', () => {
    const fan = workflowGraphSchema.parse({
      schemaVersion: 1,
      nodes: [
        { id: 'start', type: 'trigger.manual' },
        { id: 'fan', type: 'parallel' },
        { id: 'a', type: 'agent', goal: 'A' },
        { id: 'b', type: 'agent', goal: 'B' },
        { id: 'meet', type: 'join', policy: 'all' },
      ],
      edges: [
        edge('e1', 'start', 'next', 'fan'),
        edge('e2', 'fan', 'branch', 'a'),
        edge('e3', 'fan', 'branch', 'b'),
        edge('e4', 'a', 'next', 'meet'),
        edge('e5', 'b', 'next', 'meet'),
      ],
    });
    const base = [done('start', ['next']), done('fan', ['branch'])];
    expect(workflowProgress(fan, 'start', base).runnable).toEqual(['a', 'b']);
    expect(workflowProgress(fan, 'start', [...base, done('a', ['next'])]).runnable).toEqual(['b']);
    expect(
      workflowProgress(fan, 'start', [...base, done('a', ['next']), done('b', ['next'])]).runnable,
    ).toEqual(['meet']);
    const failed = workflowProgress(fan, 'start', [
      ...base,
      done('a', ['next']),
      { nodeId: 'b', attempt: 1, status: 'failed', firedHandles: [] },
    ]);
    expect(failed).toMatchObject({ runnable: [], dead: ['meet'], settled: true });
  });

  it('continues a join that waits for any input once, whichever branch arrives', () => {
    const fan = workflowGraphSchema.parse({
      schemaVersion: 1,
      nodes: [
        { id: 'start', type: 'trigger.manual' },
        { id: 'fan', type: 'parallel' },
        { id: 'a', type: 'agent', goal: 'A' },
        { id: 'b', type: 'agent', goal: 'B' },
        { id: 'first', type: 'join', policy: 'any' },
      ],
      edges: [
        edge('e1', 'start', 'next', 'fan'),
        edge('e2', 'fan', 'branch', 'a'),
        edge('e3', 'fan', 'branch', 'b'),
        edge('e4', 'a', 'next', 'first'),
        edge('e5', 'b', 'next', 'first'),
      ],
    });
    const base = [done('start', ['next']), done('fan', ['branch'])];
    const failedA = { nodeId: 'a', attempt: 1, status: 'failed' as const, firedHandles: [] };
    // A failed branch alone does not continue it; the other branch still can.
    expect(workflowProgress(fan, 'start', [...base, failedA]).runnable).toEqual(['b']);
    expect(
      workflowProgress(fan, 'start', [...base, failedA, done('b', ['next'])]).runnable,
    ).toEqual(['first']);
    // Once it has an execution it is never runnable again, whatever else arrives.
    const joined = workflowProgress(fan, 'start', [
      ...base,
      done('a', ['next']),
      done('first', ['next']),
      done('b', ['next']),
    ]);
    expect(joined).toMatchObject({ runnable: [], settled: true });
  });
});
