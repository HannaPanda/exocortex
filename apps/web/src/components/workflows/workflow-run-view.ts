import {
  type WorkflowNodeExecution,
  type WorkflowNodeExecutionStatus,
  type WorkflowRunResponse,
} from '@exocortex/contracts';

/**
 * What a run looks like on its graph (issue #164).
 *
 * The debugger draws the version the run started on and colours it from the
 * run's own rows: the latest attempt of every node, the edges whose source
 * took their handle, and `workflowProgress`'s answer about what may run
 * next. Nothing here is inferred from timing or from the history's order, so
 * the picture is the same one the worker acts on.
 */

/** A node's state in one run, as the canvas shows it. */
export type WorkflowNodeRunState =
  | WorkflowNodeExecutionStatus
  /** Its inputs have fired and the runtime has not queued it yet. */
  | 'runnable'
  /** Nothing has reached it (yet, or ever). */
  | 'untouched';

export interface WorkflowNodeRunView {
  state: WorkflowNodeRunState;
  /** Every attempt, oldest first. */
  attempts: WorkflowNodeExecution[];
  /** More than one attempt: a retry or a recovered worker. */
  retried: boolean;
}

export interface WorkflowRunView {
  nodes: ReadonlyMap<string, WorkflowNodeRunView>;
  /** Edges whose source succeeded and took their handle. */
  takenEdgeIds: ReadonlySet<string>;
}

export function workflowRunView(response: WorkflowRunResponse): WorkflowRunView {
  const byNode = new Map<string, WorkflowNodeExecution[]>();
  for (const execution of response.nodeExecutions) {
    const list = byNode.get(execution.nodeId) ?? [];
    list.push(execution);
    byNode.set(execution.nodeId, list);
  }
  const runnable = new Set(response.progress.runnable);
  const nodes = new Map<string, WorkflowNodeRunView>();
  for (const node of response.graph.nodes) {
    const attempts = [...(byNode.get(node.id) ?? [])].sort((a, b) => a.attempt - b.attempt);
    const latest = attempts.at(-1);
    nodes.set(node.id, {
      state: latest?.status ?? (runnable.has(node.id) ? 'runnable' : 'untouched'),
      attempts,
      retried: attempts.length > 1,
    });
  }
  const takenEdgeIds = new Set<string>();
  for (const edge of response.graph.edges) {
    const latest = nodes.get(edge.source.nodeId)?.attempts.at(-1);
    if (latest?.status === 'succeeded' && latest.firedHandles.includes(edge.source.handle)) {
      takenEdgeIds.add(edge.id);
    }
  }
  return { nodes, takenEdgeIds };
}

/** How long an attempt took or has been going, in milliseconds; null before it started. */
export function attemptDurationMs(execution: WorkflowNodeExecution, now: number): number | null {
  if (execution.startedAt === null) return null;
  const end = execution.finishedAt === null ? now : Date.parse(execution.finishedAt);
  return Math.max(0, end - Date.parse(execution.startedAt));
}
