import { z } from 'zod';

import { parseCron } from './automation-schedule';
import {
  isTriggerNode,
  WORKFLOW_EXCLUSIVE_NODE_TYPES,
  WORKFLOW_FAN_OUT_HANDLES,
  WORKFLOW_LIMITS,
  WORKFLOW_NODE_HANDLES,
  type WorkflowEdge,
  type WorkflowGraph,
  workflowGraphSchema,
  type WorkflowNode,
  type WorkflowNodeOf,
} from './workflow-graph';
import { workflowGoalPlaceholders } from './workflow-result';

/**
 * Whether a workflow graph makes sense (issue #160, ADR-075).
 *
 * Pure and total: the API calls it before it publishes, the editor before it
 * offers to, and an agent repairing a draft reads its answer. Every problem
 * names the element it is about (`nodeId`, `edgeId`, or a `path` into the
 * submitted JSON) and carries a stable `code`, because the reader that has to
 * act on it is as often a program as a person.
 *
 * What it cannot know is what lives in the database: whether an agent
 * profile, a page or a person a node names belongs to the workflow's
 * workspace. The API adds those as `reference_not_found` problems, in the
 * same list and the same shape.
 */

export const WORKFLOW_PROBLEM_CODES = [
  'schema_invalid',
  'no_trigger',
  'duplicate_node_id',
  'duplicate_edge_id',
  'duplicate_edge',
  'edge_unknown_node',
  'edge_invalid_handle',
  'edge_into_trigger',
  'edge_self_loop',
  'handle_multiple_targets',
  'node_multiple_inputs',
  'node_unreachable',
  'cycle',
  'join_too_few_inputs',
  'join_impossible',
  'parallel_too_few_branches',
  'parallel_too_many_branches',
  'field_required',
  'output_field_invalid',
  'condition_unknown_source',
  'condition_not_upstream',
  'condition_unknown_field',
  'condition_operator_mismatch',
  'condition_value_invalid',
  'goal_placeholder_invalid',
  'schedule_invalid',
  'reference_not_found',
] as const;
export const workflowProblemCodeSchema = z.enum(WORKFLOW_PROBLEM_CODES);
export type WorkflowProblemCode = z.infer<typeof workflowProblemCodeSchema>;

export const workflowProblemSchema = z.object({
  code: workflowProblemCodeSchema,
  /** English, for logs and agents; the browser renders its own words from `code`. */
  message: z.string(),
  nodeId: z.string().nullable(),
  edgeId: z.string().nullable(),
  /** Into the submitted graph, for `schema_invalid`. */
  path: z.array(z.union([z.string(), z.number()])).nullable(),
});
export type WorkflowProblem = z.infer<typeof workflowProblemSchema>;

export interface WorkflowValidation {
  /** The parsed graph, or null when it did not even have the right shape. */
  graph: WorkflowGraph | null;
  problems: WorkflowProblem[];
}

function problem(
  code: WorkflowProblemCode,
  message: string,
  at: { nodeId?: string; edgeId?: string; path?: (string | number)[] } = {},
): WorkflowProblem {
  return {
    code,
    message,
    nodeId: at.nodeId ?? null,
    edgeId: at.edgeId ?? null,
    path: at.path ?? null,
  };
}

/**
 * Parses and checks a graph. A shape problem stops there: the semantic checks
 * need a graph to walk. Otherwise every problem is reported at once, so one
 * round trip is enough to fix all of them.
 */
export function validateWorkflowGraph(raw: unknown): WorkflowValidation {
  const parsed = workflowGraphSchema.safeParse(raw);
  if (!parsed.success) {
    return { graph: null, problems: parsed.error.issues.map((issue) => schemaProblem(raw, issue)) };
  }
  return { graph: parsed.data, problems: graphProblems(parsed.data) };
}

/** A zod issue as a problem, attributed to the node or edge its path enters. */
function schemaProblem(raw: unknown, issue: z.core.$ZodIssue): WorkflowProblem {
  const path = issue.path.map((segment) =>
    typeof segment === 'number' ? segment : String(segment),
  );
  const [collection, index] = path;
  let element: { nodeId?: string; edgeId?: string } = {};
  if (typeof index === 'number' && (collection === 'nodes' || collection === 'edges')) {
    const list = (raw as Record<string, unknown> | null)?.[collection];
    const id = Array.isArray(list) ? (list[index] as { id?: unknown } | undefined)?.id : undefined;
    if (typeof id === 'string') element = collection === 'nodes' ? { nodeId: id } : { edgeId: id };
  }
  return problem('schema_invalid', issue.message, { ...element, path });
}

/** The semantic checks, over a graph that has the right shape. */
export function graphProblems(graph: WorkflowGraph): WorkflowProblem[] {
  const problems: WorkflowProblem[] = [];
  const nodes = uniqueNodes(graph, problems);
  const edges = usableEdges(graph, nodes, problems);
  problems.push(...nodeFieldProblems(graph.nodes));
  problems.push(...wiringProblems(graph, nodes, edges));

  const order = topologicalOrder(nodes, edges);
  if (order === null) {
    problems.push(problem('cycle', 'The graph has a cycle; loops are not supported'));
    return problems;
  }
  problems.push(...reachabilityProblems(nodes, edges));
  problems.push(...joinProblems(order, nodes, edges));
  problems.push(...conditionProblems(nodes, edges));
  problems.push(...goalPlaceholderProblems(nodes, edges));
  return problems;
}

function uniqueNodes(graph: WorkflowGraph, problems: WorkflowProblem[]): Map<string, WorkflowNode> {
  const nodes = new Map<string, WorkflowNode>();
  for (const node of graph.nodes) {
    if (nodes.has(node.id)) {
      problems.push(
        problem('duplicate_node_id', `Two nodes share the id "${node.id}"`, { nodeId: node.id }),
      );
      continue;
    }
    nodes.set(node.id, node);
  }
  if (![...nodes.values()].some(isTriggerNode)) {
    problems.push(problem('no_trigger', 'A workflow needs at least one trigger'));
  }
  return nodes;
}

/**
 * The edges that point from a real handle to a real node. The rest are
 * reported and left out of every later check, so one broken edge yields one
 * problem rather than a cascade.
 */
function usableEdges(
  graph: WorkflowGraph,
  nodes: ReadonlyMap<string, WorkflowNode>,
  problems: WorkflowProblem[],
): WorkflowEdge[] {
  const seenIds = new Set<string>();
  const seenWires = new Set<string>();
  const usable: WorkflowEdge[] = [];
  for (const edge of graph.edges) {
    const at = { edgeId: edge.id };
    if (seenIds.has(edge.id)) {
      problems.push(problem('duplicate_edge_id', `Two edges share the id "${edge.id}"`, at));
      continue;
    }
    seenIds.add(edge.id);
    const found = edgeEndProblem(edge, nodes);
    if (found !== null) {
      problems.push(problem(found.code, found.message, at));
      continue;
    }
    const wire = `${edge.source.nodeId}:${edge.source.handle}->${edge.target.nodeId}`;
    if (seenWires.has(wire)) {
      problems.push(problem('duplicate_edge', 'The same connection exists twice', at));
      continue;
    }
    seenWires.add(wire);
    usable.push(edge);
  }
  return usable;
}

function edgeEndProblem(
  edge: WorkflowEdge,
  nodes: ReadonlyMap<string, WorkflowNode>,
): { code: WorkflowProblemCode; message: string } | null {
  const source = nodes.get(edge.source.nodeId);
  const target = nodes.get(edge.target.nodeId);
  if (source === undefined || target === undefined) {
    const missing = source === undefined ? edge.source.nodeId : edge.target.nodeId;
    return { code: 'edge_unknown_node', message: `No node has the id "${missing}"` };
  }
  if (!WORKFLOW_NODE_HANDLES[source.type].includes(edge.source.handle)) {
    const offered = WORKFLOW_NODE_HANDLES[source.type].join(', ') || 'none';
    return {
      code: 'edge_invalid_handle',
      message: `A ${source.type} node has no handle "${edge.source.handle}" (offers: ${offered})`,
    };
  }
  if (source.id === target.id) {
    return { code: 'edge_self_loop', message: 'An edge cannot lead back into its own node' };
  }
  if (isTriggerNode(target)) {
    return { code: 'edge_into_trigger', message: 'Nothing leads into a trigger; it starts a run' };
  }
  return null;
}

/** Required texts, output declarations and schedules: what a node needs on its own. */
function nodeFieldProblems(nodes: readonly WorkflowNode[]): WorkflowProblem[] {
  const problems: WorkflowProblem[] = [];
  for (const node of nodes) {
    const at = { nodeId: node.id };
    switch (node.type) {
      case 'agent':
        if (node.goal.trim().length === 0) {
          problems.push(problem('field_required', 'An agent node needs a goal', at));
        }
        problems.push(...outputFieldProblems(node));
        break;
      case 'approval':
        if (node.title.length === 0 || node.question.length === 0) {
          problems.push(problem('field_required', 'An approval needs a title and a question', at));
        }
        break;
      case 'trigger.event':
        if (node.events.length === 0) {
          problems.push(problem('field_required', 'An event trigger needs at least one event', at));
        }
        break;
      case 'trigger.schedule':
        if (node.schedule.kind === 'CRON' && parseCron(node.schedule.cron) === null) {
          problems.push(problem('schedule_invalid', 'The cron expression does not parse', at));
        }
        break;
      default:
        break;
    }
  }
  return problems;
}

function outputFieldProblems(node: WorkflowNodeOf<'agent'>): WorkflowProblem[] {
  const problems: WorkflowProblem[] = [];
  const names = new Set<string>();
  for (const field of node.outputFields) {
    const at = { nodeId: node.id };
    if (names.has(field.name)) {
      problems.push(problem('output_field_invalid', `Output field "${field.name}" twice`, at));
    }
    names.add(field.name);
    if (field.type === 'enum' && field.values.length === 0) {
      problems.push(
        problem('output_field_invalid', `Enum field "${field.name}" needs its values`, at),
      );
    }
    if (field.type !== 'enum' && field.values.length > 0) {
      problems.push(
        problem('output_field_invalid', `Only an enum field lists values ("${field.name}")`, at),
      );
    }
  }
  return problems;
}

/**
 * How many edges go into each node and out of each handle. Only a join is
 * entered more than once, and only a fan-out handle leaves more than once:
 * everywhere else one handle is one next step, which is what makes a path
 * through the graph something the run history can name.
 */
function wiringProblems(
  graph: WorkflowGraph,
  nodes: ReadonlyMap<string, WorkflowNode>,
  edges: readonly WorkflowEdge[],
): WorkflowProblem[] {
  const problems: WorkflowProblem[] = [];
  const inputs = countBy(edges, (edge) => edge.target.nodeId);
  const outputs = countBy(edges, (edge) => `${edge.source.nodeId}:${edge.source.handle}`);
  for (const node of nodes.values()) {
    const at = { nodeId: node.id };
    const entering = inputs.get(node.id) ?? 0;
    if (node.type === 'join' && entering < 2) {
      problems.push(problem('join_too_few_inputs', 'A join needs at least two inputs', at));
    }
    if (node.type !== 'join' && entering > 1) {
      problems.push(
        problem('node_multiple_inputs', 'Only a join can be entered by more than one edge', at),
      );
    }
    for (const handle of WORKFLOW_NODE_HANDLES[node.type]) {
      const leaving = outputs.get(`${node.id}:${handle}`) ?? 0;
      problems.push(...handleProblems(graph, node, handle, leaving));
    }
  }
  return problems;
}

function handleProblems(
  graph: WorkflowGraph,
  node: WorkflowNode,
  handle: string,
  leaving: number,
): WorkflowProblem[] {
  const at = { nodeId: node.id };
  if (WORKFLOW_FAN_OUT_HANDLES[node.type] !== handle) {
    return leaving > 1
      ? [problem('handle_multiple_targets', `Handle "${handle}" leads to more than one node`, at)]
      : [];
  }
  const ceiling = graph.limits.maxParallelBranches ?? WORKFLOW_LIMITS.maxParallelBranches;
  if (leaving < 2) {
    return [problem('parallel_too_few_branches', 'A parallel node needs two branches or more', at)];
  }
  if (leaving > ceiling) {
    return [
      problem(
        'parallel_too_many_branches',
        `A parallel node may open at most ${ceiling} branches`,
        at,
      ),
    ];
  }
  return [];
}

/** Kahn's algorithm; null when a cycle keeps some node from ever being ready. */
function topologicalOrder(
  nodes: ReadonlyMap<string, WorkflowNode>,
  edges: readonly WorkflowEdge[],
): WorkflowNode[] | null {
  const remaining = countBy(edges, (edge) => edge.target.nodeId);
  const ready = [...nodes.values()].filter((node) => !remaining.has(node.id));
  const order: WorkflowNode[] = [];
  while (ready.length > 0) {
    const node = ready.shift()!;
    order.push(node);
    for (const edge of edges) {
      if (edge.source.nodeId !== node.id) continue;
      const left = (remaining.get(edge.target.nodeId) ?? 0) - 1;
      remaining.set(edge.target.nodeId, left);
      if (left === 0) ready.push(nodes.get(edge.target.nodeId)!);
    }
  }
  return order.length === nodes.size ? order : null;
}

function reachabilityProblems(
  nodes: ReadonlyMap<string, WorkflowNode>,
  edges: readonly WorkflowEdge[],
): WorkflowProblem[] {
  const reached = new Set<string>();
  const queue = [...nodes.values()].filter(isTriggerNode).map((node) => node.id);
  while (queue.length > 0) {
    const id = queue.pop()!;
    if (reached.has(id)) continue;
    reached.add(id);
    for (const edge of edges) if (edge.source.nodeId === id) queue.push(edge.target.nodeId);
  }
  return [...nodes.values()]
    .filter((node) => !reached.has(node.id))
    .map((node) =>
      problem('node_unreachable', 'No trigger leads to this node', { nodeId: node.id }),
    );
}

/**
 * Exclusive choices taken on the way to a node: trigger -> which trigger,
 * condition -> which branch. Two inputs of a wait-for-all join that disagree
 * on one of them can never both arrive, so the join could never continue.
 */
type Choices = Map<string, string>;

function joinProblems(
  order: readonly WorkflowNode[],
  nodes: ReadonlyMap<string, WorkflowNode>,
  edges: readonly WorkflowEdge[],
): WorkflowProblem[] {
  const problems: WorkflowProblem[] = [];
  const choices = new Map<string, Choices>();
  for (const node of order) {
    if (isTriggerNode(node)) {
      choices.set(node.id, new Map([['trigger', node.id]]));
      continue;
    }
    const arriving = edges
      .filter((edge) => edge.target.nodeId === node.id)
      .map((edge) => edgeChoices(edge, nodes, choices));
    if (arriving.length === 0) {
      choices.set(node.id, new Map());
      continue;
    }
    if (node.type === 'join' && node.policy === 'all') {
      const merged = mergeAll(arriving);
      if (merged === null) {
        problems.push(
          problem(
            'join_impossible',
            'This join waits for all inputs, but they come from branches that exclude each other',
            { nodeId: node.id },
          ),
        );
      }
      choices.set(node.id, merged ?? new Map());
      continue;
    }
    choices.set(node.id, node.type === 'join' ? intersect(arriving) : arriving[0]!);
  }
  return problems;
}

function edgeChoices(
  edge: WorkflowEdge,
  nodes: ReadonlyMap<string, WorkflowNode>,
  choices: ReadonlyMap<string, Choices>,
): Choices {
  const result = new Map(choices.get(edge.source.nodeId) ?? []);
  const source = nodes.get(edge.source.nodeId);
  if (source !== undefined && WORKFLOW_EXCLUSIVE_NODE_TYPES.includes(source.type)) {
    result.set(source.id, edge.source.handle);
  }
  return result;
}

function mergeAll(sets: readonly Choices[]): Choices | null {
  const merged: Choices = new Map();
  for (const set of sets) {
    for (const [key, value] of set) {
      const existing = merged.get(key);
      if (existing !== undefined && existing !== value) return null;
      merged.set(key, value);
    }
  }
  return merged;
}

function intersect(sets: readonly Choices[]): Choices {
  const [first, ...rest] = sets;
  const result: Choices = new Map();
  for (const [key, value] of first ?? []) {
    if (rest.every((set) => set.get(key) === value)) result.set(key, value);
  }
  return result;
}

/**
 * A condition reads a field an agent node upstream of it declared, with an
 * operator and a value that fit the field's type. Deterministic branching
 * only: a condition never asks a model.
 */
function conditionProblems(
  nodes: ReadonlyMap<string, WorkflowNode>,
  edges: readonly WorkflowEdge[],
): WorkflowProblem[] {
  const problems: WorkflowProblem[] = [];
  for (const node of nodes.values()) {
    if (node.type !== 'condition') continue;
    const at = { nodeId: node.id };
    const source = nodes.get(node.source.nodeId);
    if (source?.type !== 'agent') {
      problems.push(
        problem('condition_unknown_source', 'A condition reads the output of an agent node', at),
      );
      continue;
    }
    if (!upstreamOf(node.id, edges).has(source.id)) {
      problems.push(
        problem('condition_not_upstream', 'The node a condition reads must come before it', at),
      );
    }
    const field = source.outputFields.find((candidate) => candidate.name === node.source.field);
    if (field === undefined) {
      problems.push(
        problem(
          'condition_unknown_field',
          `Node "${source.id}" declares no field "${node.source.field}"`,
          at,
        ),
      );
      continue;
    }
    problems.push(...operatorProblems(node, field));
  }
  return problems;
}

/**
 * A placeholder in a goal names `input` or an agent node upstream of this one
 * and a field it declares (issue #162): a sentence that silently keeps
 * `{{review.socre}}` because of a typo would reach the model as written.
 */
function goalPlaceholderProblems(
  nodes: ReadonlyMap<string, WorkflowNode>,
  edges: readonly WorkflowEdge[],
): WorkflowProblem[] {
  const problems: WorkflowProblem[] = [];
  for (const node of nodes.values()) {
    if (node.type !== 'agent') continue;
    const at = { nodeId: node.id };
    for (const { source, key } of workflowGoalPlaceholders(node.goal)) {
      if (source === 'input') continue;
      const upstream = nodes.get(source);
      if (upstream?.type !== 'agent' || !upstreamOf(node.id, edges).has(source)) {
        problems.push(
          problem(
            'goal_placeholder_invalid',
            `"{{${source}.${key}}}" names no agent node before this one`,
            at,
          ),
        );
        continue;
      }
      if (!upstream.outputFields.some((field) => field.name === key)) {
        problems.push(
          problem('goal_placeholder_invalid', `Node "${source}" declares no field "${key}"`, at),
        );
      }
    }
  }
  return problems;
}

const COMPARISONS_BY_TYPE: Readonly<Record<string, readonly string[]>> = {
  string: ['eq', 'neq'],
  enum: ['eq', 'neq'],
  number: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte'],
  boolean: ['eq', 'neq', 'is_true', 'is_false'],
};

function operatorProblems(
  node: WorkflowNodeOf<'condition'>,
  field: WorkflowNodeOf<'agent'>['outputFields'][number],
): WorkflowProblem[] {
  const at = { nodeId: node.id };
  if (node.operator === 'present' || node.operator === 'absent') return [];
  if (!COMPARISONS_BY_TYPE[field.type]!.includes(node.operator)) {
    return [
      problem(
        'condition_operator_mismatch',
        `Operator "${node.operator}" does not apply to a ${field.type} field`,
        at,
      ),
    ];
  }
  if (node.operator === 'is_true' || node.operator === 'is_false') return [];
  const expected = field.type === 'enum' ? 'string' : field.type;
  if (node.value === null || typeof node.value !== expected) {
    return [problem('condition_value_invalid', `The comparison needs a ${expected} value`, at)];
  }
  if (field.type === 'enum' && !field.values.includes(node.value as string)) {
    return [
      problem('condition_value_invalid', `"${String(node.value)}" is not one of the values`, at),
    ];
  }
  return [];
}

/** Every node an edge path leads from into `nodeId`. */
function upstreamOf(nodeId: string, edges: readonly WorkflowEdge[]): Set<string> {
  const seen = new Set<string>();
  const queue = [nodeId];
  while (queue.length > 0) {
    const id = queue.pop()!;
    for (const edge of edges) {
      if (edge.target.nodeId !== id || seen.has(edge.source.nodeId)) continue;
      seen.add(edge.source.nodeId);
      queue.push(edge.source.nodeId);
    }
  }
  return seen;
}

function countBy<T>(items: readonly T[], key: (item: T) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(key(item), (counts.get(key(item)) ?? 0) + 1);
  return counts;
}
