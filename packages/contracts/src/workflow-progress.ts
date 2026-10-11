import { z } from 'zod';

import { isTriggerNode, type WorkflowEdge, type WorkflowGraph } from './workflow-graph';

/**
 * How far a workflow run has come, derived from persisted rows alone (issue
 * #160, ADR-075).
 *
 * A worker holds nothing between transitions (issue #161): whichever worker
 * picks a run up next reads its node executions and asks this function what
 * may run now. So the answer depends on the graph of the run's version and
 * the latest attempt of every node, and on nothing that lived in a process.
 *
 * An edge is in one of three states. It has *fired* when its source
 * succeeded and named the edge's handle among the ones it took. It is *dead*
 * when its source finished without taking that handle (the other branch of a
 * condition, a failure, a skip) or can itself never run. Otherwise it is
 * still *pending*. A node runs once its inputs have fired -- one input for an
 * ordinary node, all or any for a join -- and is dead once they can no longer
 * fire, which is what lets a join waiting for all of its inputs give up on a
 * branch a condition steered away rather than wait for ever.
 */

export const WORKFLOW_NODE_EXECUTION_STATUSES = [
  'queued',
  'running',
  'waiting',
  'succeeded',
  'failed',
  'skipped',
  'cancelled',
  'timed_out',
] as const;
export const workflowNodeExecutionStatusSchema = z.enum(WORKFLOW_NODE_EXECUTION_STATUSES);
export type WorkflowNodeExecutionStatus = z.infer<typeof workflowNodeExecutionStatusSchema>;

/** The statuses a node execution leaves no more. */
export const WORKFLOW_NODE_TERMINAL_STATUSES: readonly WorkflowNodeExecutionStatus[] = [
  'succeeded',
  'failed',
  'skipped',
  'cancelled',
  'timed_out',
];

/** What `workflowProgress` needs of one node execution row. */
export interface WorkflowNodeExecutionState {
  nodeId: string;
  attempt: number;
  status: WorkflowNodeExecutionStatus;
  /** The handles a succeeded node took; empty for every other status. */
  firedHandles: readonly string[];
}

export interface WorkflowProgress {
  /** Nodes whose inputs have fired and that have no execution yet. */
  runnable: string[];
  /** Nodes that can never run in this run; a runtime records them as skipped. */
  dead: string[];
  /** Nodes with an execution that is queued, running or waiting. */
  active: string[];
  /** Nothing is running and nothing more can: the run is over. */
  settled: boolean;
}

type EdgeState = 'fired' | 'dead' | 'pending';
type NodeState = 'done' | 'active' | 'runnable' | 'dead' | 'pending';

/**
 * Derives the next step of a run. `triggerNodeId` is the trigger the run was
 * started by; every other trigger of the graph is dead for this run.
 */
export function workflowProgress(
  graph: WorkflowGraph,
  triggerNodeId: string,
  executions: readonly WorkflowNodeExecutionState[],
): WorkflowProgress {
  const latest = latestAttempts(executions);
  const incoming = new Map<string, WorkflowEdge[]>();
  for (const edge of graph.edges) {
    incoming.set(edge.target.nodeId, [...(incoming.get(edge.target.nodeId) ?? []), edge]);
  }
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const states = new Map<string, NodeState>();

  const edgeState = (edge: WorkflowEdge): EdgeState => {
    const source = stateOf(edge.source.nodeId);
    if (source === 'dead') return 'dead';
    if (source !== 'done') return 'pending';
    const execution = latest.get(edge.source.nodeId)!;
    return execution.status === 'succeeded' && execution.firedHandles.includes(edge.source.handle)
      ? 'fired'
      : 'dead';
  };

  function stateOf(nodeId: string): NodeState {
    const known = states.get(nodeId);
    if (known !== undefined) return known;
    const state = computeState(nodeId);
    states.set(nodeId, state);
    return state;
  }

  function computeState(nodeId: string): NodeState {
    const execution = latest.get(nodeId);
    if (execution !== undefined) {
      return execution.status === 'queued' ||
        execution.status === 'running' ||
        execution.status === 'waiting'
        ? 'active'
        : 'done';
    }
    const node = nodes.get(nodeId);
    if (node === undefined) return 'dead';
    // A trigger runs only by starting the run; the start records its execution.
    if (isTriggerNode(node)) return node.id === triggerNodeId ? 'runnable' : 'dead';
    const inputs = (incoming.get(nodeId) ?? []).map(edgeState);
    if (inputs.length === 0) return 'dead';
    if (node.type === 'join' && node.policy === 'any') {
      if (inputs.includes('fired')) return 'runnable';
      return inputs.every((input) => input === 'dead') ? 'dead' : 'pending';
    }
    // An ordinary node has one input; a join waiting for all needs every one.
    if (inputs.includes('dead')) return 'dead';
    return inputs.every((input) => input === 'fired') ? 'runnable' : 'pending';
  }

  const runnable: string[] = [];
  const dead: string[] = [];
  const active: string[] = [];
  for (const node of graph.nodes) {
    const state = stateOf(node.id);
    if (state === 'runnable') runnable.push(node.id);
    if (state === 'dead' && !isTriggerNode(node)) dead.push(node.id);
    if (state === 'active') active.push(node.id);
  }
  return { runnable, dead, active, settled: runnable.length === 0 && active.length === 0 };
}

function latestAttempts(
  executions: readonly WorkflowNodeExecutionState[],
): Map<string, WorkflowNodeExecutionState> {
  const latest = new Map<string, WorkflowNodeExecutionState>();
  for (const execution of executions) {
    const known = latest.get(execution.nodeId);
    if (known === undefined || execution.attempt > known.attempt) {
      latest.set(execution.nodeId, execution);
    }
  }
  return latest;
}
