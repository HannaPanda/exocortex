import {
  type WorkflowErrorClass,
  type WorkflowGraph,
  type WorkflowNode,
  type WorkflowNodeOf,
  type WorkflowNodeType,
  type WorkflowRunErrorCode,
  type WorkflowWait,
} from '@exocortex/contracts';
import { type Logger } from '@exocortex/logger';

/**
 * What one node type does when the runtime executes it (issue #161).
 *
 * A handler is called with a claimed attempt and answers with an outcome; it
 * never writes the attempt's row itself, so whether a result counts (the
 * lease still held, the run still going) is decided in one place, the
 * runtime. A handler that has a side effect keys it by
 * `execution.idempotencyKey`, which is the same for every delivery of one
 * attempt, and says so with `idempotent`: only then is it run again after its
 * worker vanished, or retried after a `retryable` failure.
 */

export type NodeOutcome =
  | {
      status: 'succeeded';
      /** The outgoing handles taken; what `workflowProgress` follows. */
      handles: string[];
      /** Structured output a later node can read. Never prose meant for nobody. */
      output?: Record<string, unknown> | null;
      workItemId?: string | null;
      aiRunId?: string | null;
      /** What the node's work cost, added to the run's spend (issue #162). */
      spentMicroUsd?: number;
    }
  | {
      status: 'waiting';
      /** The durable thing it waits for; no worker is held meanwhile. */
      wait: WorkflowWait;
      workItemId?: string | null;
      aiRunId?: string | null;
    }
  | {
      status: 'failed';
      errorClass: WorkflowErrorClass;
      code: WorkflowRunErrorCode | (string & {});
      /** For a person; never a stack trace and never page content. */
      message: string;
      /** What the node's work cost before it failed, added to the run's spend. */
      spentMicroUsd?: number;
    };

export interface NodeContext {
  run: {
    id: string;
    workflowId: string;
    workspaceId: string;
    /** Who the run acts as. */
    startedById: string | null;
    chainDepth: number;
    input: unknown;
    correlationId: string | null;
  };
  node: WorkflowNode;
  execution: { id: string; attempt: number; idempotencyKey: string };
  graph: WorkflowGraph;
  /** The output of the latest succeeded attempt of every node, by node id. */
  outputs: ReadonlyMap<string, Record<string, unknown> | null>;
  logger: Logger;
}

export interface NodeHandler {
  /**
   * Running it twice for one attempt is harmless: it has no side effect, or
   * keys every one by the idempotency key. Decides whether an attempt whose
   * worker vanished is run again or failed, and whether `retryable` retries.
   */
  idempotent: boolean;
  /** Attempts in total for a `retryable` failure; `WORKFLOW_DEFAULT_MAX_ATTEMPTS` by default. */
  maxAttempts?: number;
  /** How long a claimed attempt is held before the sweep calls it abandoned. */
  leaseMs?: number;
  execute: (context: NodeContext) => Promise<NodeOutcome>;
  /**
   * Continues a waiting attempt once what it waits for has happened. Without
   * one, a woken attempt fails with `workflow_resume_unsupported`.
   */
  resume?: (context: NodeContext, wake: WorkflowWake) => Promise<NodeOutcome>;
}

/** What woke a waiting attempt: the object it waited for, and what became of it. */
export type WorkflowWake =
  | { kind: 'timer' }
  | { kind: 'work_item'; workItemId: string; payload?: Record<string, unknown> }
  | { kind: 'attention_item'; attentionItemId: string; payload?: Record<string, unknown> };

export type NodeHandlerRegistry = Readonly<Record<WorkflowNodeType, NodeHandler>>;

/** A lease for a handler that does its work in memory and returns. */
export const DEFAULT_LEASE_MS = 60_000;

/** A trigger has run by the time its run exists; executing one again is a bug. */
const triggerHandler: NodeHandler = {
  idempotent: true,
  execute: async () => ({
    status: 'failed',
    errorClass: 'terminal',
    code: 'workflow_node_error',
    message: 'A trigger runs only by starting its run',
  }),
};

/**
 * A node type whose execution belongs to a later issue: approvals are #163.
 * Failing the attempt names that, and the run ends instead of hanging; a
 * graph with such a node can be published and is honestly refused when it
 * gets there.
 */
function notExecutable(issue: string): NodeHandler {
  return {
    idempotent: true,
    maxAttempts: 1,
    execute: async ({ node }) => ({
      status: 'failed',
      errorClass: 'terminal',
      code: 'workflow_node_not_executable',
      message: `Nodes of type ${node.type} cannot be executed yet (issue ${issue})`,
    }),
  };
}

/** A fan-out takes its one handle, which every branch edge hangs off. */
const parallelHandler: NodeHandler = {
  idempotent: true,
  execute: async () => ({ status: 'succeeded', handles: ['branch'], output: null }),
};

/**
 * A join runs once its inputs allow (`workflowProgress` decides that) and
 * passes on; what arrived is in the history, not in its output.
 */
const joinHandler: NodeHandler = {
  idempotent: true,
  execute: async () => ({ status: 'succeeded', handles: ['next'], output: null }),
};

/**
 * An end node succeeds; its configured outcome is what the run ends with,
 * which the runtime reads when the run settles.
 */
const endHandler: NodeHandler = {
  idempotent: true,
  execute: async ({ node }) => {
    const end = node as WorkflowNodeOf<'end'>;
    return { status: 'succeeded', handles: [], output: { outcome: end.outcome } };
  },
};

/** A condition branches on a field of an upstream node's structured output. */
const conditionHandler: NodeHandler = {
  idempotent: true,
  execute: async ({ node, outputs }) => {
    const condition = node as WorkflowNodeOf<'condition'>;
    const holds = evaluateCondition(condition, outputs.get(condition.source.nodeId) ?? null);
    return {
      status: 'succeeded',
      handles: [holds ? 'true' : 'false'],
      output: { result: holds },
    };
  },
};

/**
 * Whether a condition holds. A missing output or field is "absent": it makes
 * `absent` true and every comparison false, so a branch on a value nobody
 * produced takes the `false` path rather than failing the run.
 */
export function evaluateCondition(
  condition: WorkflowNodeOf<'condition'>,
  output: Record<string, unknown> | null,
): boolean {
  // An agent node keeps its checked values under `fields` (issue #162).
  const fields = output?.fields;
  const value =
    typeof fields === 'object' && fields !== null && !Array.isArray(fields)
      ? (fields as Record<string, unknown>)[condition.source.field]
      : undefined;
  const present = value !== undefined && value !== null;
  switch (condition.operator) {
    case 'present':
      return present;
    case 'absent':
      return !present;
    case 'is_true':
      return value === true;
    case 'is_false':
      return value === false;
    case 'eq':
      return present && value === condition.value;
    case 'neq':
      return present && value !== condition.value;
    default:
      return compareNumbers(condition.operator, value, condition.value);
  }
}

/** The ordering operators: both sides numbers, or the comparison is false. */
function compareNumbers(
  operator: 'gt' | 'gte' | 'lt' | 'lte',
  value: unknown,
  expected: unknown,
): boolean {
  if (typeof value !== 'number' || typeof expected !== 'number') return false;
  switch (operator) {
    case 'gt':
      return value > expected;
    case 'gte':
      return value >= expected;
    case 'lt':
      return value < expected;
    case 'lte':
      return value <= expected;
  }
}

/**
 * Stands in for the agent node where nothing to start work with was handed
 * over; the runtime replaces it with `createAgentNodeHandler` (issue #162).
 */
const agentWithoutDependencies: NodeHandler = {
  idempotent: true,
  maxAttempts: 1,
  execute: async () => ({
    status: 'failed',
    errorClass: 'terminal',
    code: 'workflow_agent_refused',
    message: 'This worker was started without a way to create work items',
  }),
};

/**
 * The handlers that need nothing but the node. The runtime adds the agent
 * node's, which needs the database and an API client (`shared.ts`); a test
 * passes its own registry.
 */
export const DEFAULT_NODE_HANDLERS: NodeHandlerRegistry = {
  'trigger.manual': triggerHandler,
  'trigger.schedule': triggerHandler,
  'trigger.event': triggerHandler,
  agent: agentWithoutDependencies,
  approval: notExecutable('#163'),
  condition: conditionHandler,
  parallel: parallelHandler,
  join: joinHandler,
  end: endHandler,
};
