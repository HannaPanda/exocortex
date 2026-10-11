import {
  type AiWriteMode,
  isInputSource,
  type WorkflowConditionSource,
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
    /** A ceiling on every agent node's write mode (issue #164); null: none. */
    writeMode: AiWriteMode | null;
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
 * and reaching it ends the run at once (issue #163): the advance after it
 * reads the outcome and cancels whatever is still in flight.
 */
const endHandler: NodeHandler = {
  idempotent: true,
  execute: async ({ node }) => {
    const end = node as WorkflowNodeOf<'end'>;
    return {
      status: 'succeeded',
      handles: [],
      output: { outcome: end.outcome, summary: end.summary },
    };
  },
};

/**
 * A condition branches on a field of an upstream node's structured output, or
 * on a key of the run's input (issue #163). Its output says what it read, so
 * the history shows why a branch was taken without anybody re-evaluating it.
 */
const conditionHandler: NodeHandler = {
  idempotent: true,
  execute: async ({ node, outputs, run }) => {
    const condition = node as WorkflowNodeOf<'condition'>;
    const value = conditionValue(condition.source, { input: run.input, outputs });
    const holds = evaluateCondition(condition, value);
    return {
      status: 'succeeded',
      handles: [holds ? 'true' : 'false'],
      output: { result: holds, value: scalarOrNull(value) },
    };
  },
};

/**
 * The value a condition reads. An agent and an approval keep their checked
 * values under `fields` (issues #162, #163); the run's input is read as it is.
 */
export function conditionValue(
  source: WorkflowConditionSource,
  values: { input: unknown; outputs: ReadonlyMap<string, Record<string, unknown> | null> },
): unknown {
  const container = isInputSource(source)
    ? values.input
    : values.outputs.get(source.nodeId)?.fields;
  if (typeof container !== 'object' || container === null || Array.isArray(container)) {
    return undefined;
  }
  return (container as Record<string, unknown>)[
    isInputSource(source) ? source.input : source.field
  ];
}

/** Only a scalar is worth recording; anything else is "something", not a value. */
function scalarOrNull(value: unknown): string | number | boolean | null {
  if (typeof value === 'string') return value.slice(0, 200);
  return typeof value === 'number' || typeof value === 'boolean' ? value : null;
}

/**
 * Whether a condition holds for the value it read. A missing output or field
 * is "absent": it makes `absent` true and every comparison false, so a branch
 * on a value nobody produced takes the `false` path rather than failing the
 * run.
 */
export function evaluateCondition(
  condition: Pick<WorkflowNodeOf<'condition'>, 'operator' | 'value'>,
  value: unknown,
): boolean {
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
 * Stands in for a node that needs dependencies where none were handed over;
 * the runtime replaces it (`handlerFor` in `shared.ts`).
 */
function withoutDependencies(code: WorkflowRunErrorCode, message: string): NodeHandler {
  return {
    idempotent: true,
    maxAttempts: 1,
    execute: async () => ({ status: 'failed', errorClass: 'terminal', code, message }),
  };
}

/**
 * The handlers that need nothing but the node. The runtime adds the agent
 * node's (issue #162) and the approval's (issue #163), which need the
 * database (`shared.ts`); a test passes its own registry.
 */
export const DEFAULT_NODE_HANDLERS: NodeHandlerRegistry = {
  'trigger.manual': triggerHandler,
  'trigger.schedule': triggerHandler,
  'trigger.event': triggerHandler,
  agent: withoutDependencies(
    'workflow_agent_refused',
    'This worker was started without a way to create work items',
  ),
  approval: withoutDependencies(
    'workflow_node_not_executable',
    'This worker was started without a way to ask a person',
  ),
  condition: conditionHandler,
  parallel: parallelHandler,
  join: joinHandler,
  end: endHandler,
};
