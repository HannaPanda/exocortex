import { describe, expect, it } from 'vitest';

import {
  emptyWorkflowGraph,
  validateWorkflowGraph,
  type WorkflowGraph,
  type WorkflowRunResponse,
} from '@exocortex/contracts';

import {
  addNode,
  connect,
  duplicateNode,
  freeHandle,
  nextNodeId,
  readableSources,
  removeNodes,
  sameGraph,
  tidyGraph,
} from './workflow-draft';
import { workflowRunView } from './workflow-run-view';

const ZONE = 'Europe/Berlin';

/** start → agent → condition → (true) approval, (false) end. */
function chain(): WorkflowGraph {
  let graph = emptyWorkflowGraph();
  graph = addNode(graph, 'agent', { after: 'start', timeZone: ZONE }).graph;
  graph = addNode(graph, 'condition', { after: 'agent', timeZone: ZONE }).graph;
  graph = addNode(graph, 'approval', { after: 'condition', timeZone: ZONE }).graph;
  graph = addNode(graph, 'end', { after: 'condition', timeZone: ZONE }).graph;
  return graph;
}

describe('workflow draft editing', () => {
  it('names new nodes after their type and numbers a second one', () => {
    const graph = chain();
    expect(graph.nodes.map((node) => node.id)).toEqual([
      'start',
      'agent',
      'condition',
      'approval',
      'end',
    ]);
    expect(nextNodeId(graph, 'agent')).toBe('agent2');
    expect(nextNodeId(graph, 'trigger.schedule')).toBe('schedule');
  });

  it('wires a node added after another into its next free handle', () => {
    const graph = chain();
    expect(
      graph.edges.map(
        (edge) => `${edge.source.nodeId}.${edge.source.handle}>${edge.target.nodeId}`,
      ),
    ).toEqual([
      'start.next>agent',
      'agent.next>condition',
      'condition.true>approval',
      'condition.false>end',
    ]);
    // Both handles of the condition are taken now.
    expect(
      freeHandle(
        graph,
        graph.nodes.find((node) => node.id === 'condition')!,
      ),
    ).toBeUndefined();
  });

  it('starts an agent node in the proposing mode', () => {
    const agent = chain().nodes.find((node) => node.id === 'agent')!;
    expect(agent).toMatchObject({ type: 'agent', writeMode: 'propose', completion: 'review' });
  });

  it('produces a graph the contract parses, and only the expected problems', () => {
    const { problems } = validateWorkflowGraph(chain());
    // The new agent and approval still have to be written; nothing else is wrong.
    expect(new Set(problems.map((problem) => problem.code))).toEqual(new Set(['field_required']));
  });

  it('replaces the edge of a single handle and keeps adding branches to a fan-out', () => {
    let graph = chain();
    graph = connect(graph, { source: 'condition', handle: 'false', target: 'approval' })!;
    expect(
      graph.edges.filter(
        (edge) => edge.source.nodeId === 'condition' && edge.source.handle === 'false',
      ),
    ).toHaveLength(1);

    graph = addNode(graph, 'parallel', { timeZone: ZONE }).graph;
    graph = connect(graph, { source: 'parallel', handle: 'branch', target: 'agent' })!;
    graph = connect(graph, { source: 'parallel', handle: 'branch', target: 'end' })!;
    expect(graph.edges.filter((edge) => edge.source.nodeId === 'parallel')).toHaveLength(2);
  });

  it('refuses a connection the shape rules out', () => {
    const graph = chain();
    expect(connect(graph, { source: 'agent', handle: 'maybe', target: 'end' })).toBeNull();
    expect(connect(graph, { source: 'agent', handle: 'next', target: 'agent' })).toBeNull();
    expect(connect(graph, { source: 'agent', handle: 'next', target: 'start' })).toBeNull();
    expect(connect(graph, { source: 'start', handle: 'next', target: 'agent' })).toBeNull();
  });

  it('removes a node with its edges and duplicates one unconnected', () => {
    const removed = removeNodes(chain(), ['condition']);
    expect(removed.edges.map((edge) => edge.source.nodeId)).toEqual(['start']);
    const copied = duplicateNode(chain(), 'agent')!;
    expect(copied.nodeId).toBe('agent2');
    expect(copied.graph.edges.some((edge) => edge.target.nodeId === 'agent2')).toBe(false);
    expect(sameGraph(chain(), chain())).toBe(true);
  });

  it('offers a condition only the upstream nodes that have fields to read', () => {
    const graph = chain();
    // The agent has no fields yet; the approval is downstream of the condition.
    expect(readableSources(graph, 'condition').map((node) => node.id)).toEqual([]);
    expect(readableSources(graph, 'end').map((node) => node.id)).toEqual([]);
    expect(readableSources(graph, 'approval').map((node) => node.id)).toEqual([]);
    const withFields = {
      ...graph,
      nodes: graph.nodes.map((node) =>
        node.type === 'agent'
          ? {
              ...node,
              outputFields: [
                {
                  name: 'score',
                  type: 'number' as const,
                  values: [],
                  required: true,
                  description: null,
                },
              ],
            }
          : node,
      ),
    };
    expect(readableSources(withFields, 'condition').map((node) => node.id)).toEqual(['agent']);
  });
});

describe('workflow run view', () => {
  it('marks the taken path, retries and what may run next', () => {
    const graph = chain();
    const execution = (
      nodeId: string,
      attempt: number,
      status: 'succeeded' | 'failed' | 'waiting',
      firedHandles: string[] = [],
    ) => ({
      id: `${nodeId}-${String(attempt)}`,
      nodeId,
      nodeType: 'x',
      attempt,
      status,
      idempotencyKey: `r:${nodeId}:${String(attempt)}`,
      firedHandles,
      input: null,
      output: null,
      waitingOn: null,
      errorClass: null,
      errorCode: null,
      errorMessage: null,
      workItemId: null,
      aiRunId: null,
      queuedAt: '2026-10-11T10:00:00.000Z',
      startedAt: '2026-10-11T10:00:00.000Z',
      finishedAt: null,
    });
    const response = {
      graph,
      nodeExecutions: [
        execution('start', 1, 'succeeded', ['next']),
        execution('agent', 1, 'failed'),
        execution('agent', 2, 'succeeded', ['next']),
        execution('condition', 1, 'succeeded', ['true']),
        execution('approval', 1, 'waiting'),
      ],
      progress: { runnable: [], dead: ['end'], active: ['approval'], settled: false },
    } as unknown as WorkflowRunResponse;
    const view = workflowRunView(response);
    expect(view.nodes.get('agent')).toMatchObject({ state: 'succeeded', retried: true });
    expect(view.nodes.get('approval')?.state).toBe('waiting');
    expect(view.nodes.get('end')?.state).toBe('untouched');
    expect([...view.takenEdgeIds].sort()).toEqual(['e1', 'e2', 'e3']);
  });
});

describe('adding from a way out and tidying (issue #198)', () => {
  it('wires a node to the handle it was added from, not the first free one', () => {
    let graph = chain();
    graph = removeNodes(graph, ['approval', 'end']);
    const added = addNode(graph, 'end', { after: 'condition', handle: 'false', timeZone: ZONE });
    expect(
      added.graph.edges
        .filter((edge) => edge.source.nodeId === 'condition')
        .map((edge) => `${edge.source.handle}>${edge.target.nodeId}`),
    ).toEqual(['false>end']);
    // "nein" is the lower of the two ways out, so the node lands below.
    const condition = added.graph.nodes.find((node) => node.id === 'condition')!;
    const end = added.graph.nodes.find((node) => node.id === 'end')!;
    expect(end.position!.y).toBeGreaterThan(condition.position!.y);
  });

  it('lays nodes out in columns by distance from the trigger, ja above nein', () => {
    const scrambled: WorkflowGraph = {
      ...chain(),
      nodes: chain().nodes.map((node, index) => ({
        ...node,
        position: { x: 1000 - index * 37, y: index * 91 },
      })),
    };
    const tidy = tidyGraph(scrambled);
    const at = (id: string) => tidy.nodes.find((node) => node.id === id)!.position!;
    expect([at('start').x, at('agent').x, at('condition').x]).toEqual([0, 280, 560]);
    expect(at('approval').x).toBe(560 + 280);
    expect(at('end').x).toBe(560 + 280);
    expect(at('approval').y).toBeLessThan(at('end').y);
    // Nothing but positions changes.
    expect(tidy.edges).toEqual(scrambled.edges);
    expect(validateWorkflowGraph(tidy).problems).toEqual(validateWorkflowGraph(scrambled).problems);
  });

  it('puts a join after the longest branch leading into it', () => {
    let graph = emptyWorkflowGraph();
    graph = addNode(graph, 'parallel', { after: 'start', timeZone: ZONE }).graph;
    graph = addNode(graph, 'agent', { after: 'parallel', timeZone: ZONE }).graph;
    graph = addNode(graph, 'agent', { after: 'agent', timeZone: ZONE }).graph;
    graph = addNode(graph, 'join', { after: 'agent2', timeZone: ZONE }).graph;
    graph = connect(graph, { source: 'parallel', handle: 'branch', target: 'join' })!;
    const tidy = tidyGraph(graph);
    const x = (id: string) => tidy.nodes.find((node) => node.id === id)!.position!.x;
    expect(x('join')).toBeGreaterThan(x('agent2'));
  });
});
