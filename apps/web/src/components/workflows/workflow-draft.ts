import {
  WORKFLOW_FAN_OUT_HANDLES,
  WORKFLOW_NODE_HANDLES,
  type WorkflowEdge,
  type WorkflowGraph,
  type WorkflowNode,
  workflowNodeOutputFields,
  type WorkflowNodeType,
} from '@exocortex/contracts';

/**
 * Editing a workflow draft in the browser (issue #164).
 *
 * Pure functions over the contract's own graph type, so the editor never
 * holds a second model of a workflow that would have to be translated back:
 * what the canvas shows is derived from the graph, and every gesture -- a
 * drag, a connection, a choice in the configuration panel -- is one of these
 * functions applied to it. The rules that make a graph publishable stay in
 * `validateWorkflowGraph`; these only keep a gesture from producing something
 * the schema itself would refuse, such as an edge out of a handle the node
 * does not have.
 */

/** The palette's three groups, in the order a workflow is read. */
export const NODE_GROUPS: readonly {
  key: 'trigger' | 'work' | 'control';
  types: readonly WorkflowNodeType[];
}[] = [
  { key: 'trigger', types: ['trigger.manual', 'trigger.schedule', 'trigger.event'] },
  { key: 'work', types: ['agent'] },
  { key: 'control', types: ['condition', 'parallel', 'join', 'approval', 'end'] },
];

/** Where a node lands when no position is given: right of the rightmost one. */
const STEP_X = 280;

/** A readable id for a new node: its type's short name, numbered when taken. */
export function nextNodeId(graph: WorkflowGraph, type: WorkflowNodeType): string {
  const base = type.startsWith('trigger.') ? type.slice('trigger.'.length) : type;
  const taken = new Set(graph.nodes.map((node) => node.id));
  if (!taken.has(base)) return base;
  for (let index = 2; ; index += 1) {
    const candidate = `${base}${String(index)}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export function nextEdgeId(graph: WorkflowGraph): string {
  const taken = new Set(graph.edges.map((edge) => edge.id));
  for (let index = graph.edges.length + 1; ; index += 1) {
    const candidate = `e${String(index)}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * A new node of a type, with the defaults the editor starts from. An agent
 * proposes rather than writes until somebody decides otherwise: the
 * consequential setting starts at the cautious end.
 */
export function newNode(
  type: WorkflowNodeType,
  id: string,
  position: { x: number; y: number },
  timeZone: string,
): WorkflowNode {
  const base = { id, label: null, position };
  switch (type) {
    case 'trigger.manual':
      return { ...base, type };
    case 'trigger.schedule':
      return { ...base, type, schedule: { kind: 'DAILY', time: '07:00', timeZone } };
    case 'trigger.event':
      return { ...base, type, events: ['DOCUMENT_CONTENT_CHANGED'], scopeDocumentId: null };
    case 'agent':
      return {
        ...base,
        type,
        goal: '',
        documentIds: [],
        agentProfileId: null,
        writeMode: 'propose',
        budgetMicroUsd: null,
        outputFields: [],
        completion: 'review',
      };
    case 'condition':
      return {
        ...base,
        type,
        source: { input: 'value' },
        operator: 'present',
        value: null,
      };
    case 'parallel':
      return { ...base, type };
    case 'join':
      return { ...base, type, policy: 'all' };
    case 'approval':
      return {
        ...base,
        type,
        title: '',
        question: '',
        assigneeUserId: null,
        note: 'optional',
      };
    case 'end':
      return { ...base, type, outcome: 'succeeded', summary: null };
  }
}

/** Right of `after`, or right of everything, or the origin of an empty graph. */
export function placeFor(graph: WorkflowGraph, after: string | null): { x: number; y: number } {
  const anchor = after === null ? undefined : graph.nodes.find((node) => node.id === after);
  if (anchor?.position != null) {
    const below = graph.edges.filter((edge) => edge.source.nodeId === anchor.id).length;
    return { x: anchor.position.x + STEP_X, y: anchor.position.y + below * 120 };
  }
  const placed = graph.nodes.flatMap((node) => (node.position == null ? [] : [node.position]));
  if (placed.length === 0) return { x: 0, y: 0 };
  const right = Math.max(...placed.map((position) => position.x));
  const top = Math.min(...placed.map((position) => position.y));
  return { x: right + STEP_X, y: top };
}

/**
 * Adds a node. Placed "after" a node, it is wired in: from the named handle
 * when one is given (the `+` beside a way out), otherwise from that node's
 * first free handle, so building a chain with the keyboard is one choice per
 * step.
 */
export function addNode(
  graph: WorkflowGraph,
  type: WorkflowNodeType,
  options: {
    position?: { x: number; y: number };
    after?: string | null;
    handle?: string;
    timeZone: string;
  },
): { graph: WorkflowGraph; nodeId: string } {
  const id = nextNodeId(graph, type);
  const after = options.after ?? null;
  const source =
    after === null ? undefined : graph.nodes.find((candidate) => candidate.id === after);
  const handle =
    source === undefined || isTriggerType(type)
      ? undefined
      : (options.handle ?? freeHandle(graph, source));
  const position =
    options.position ??
    (source !== undefined && handle !== undefined
      ? placeAfterHandle(graph, source, handle)
      : placeFor(graph, after));
  const node = newNode(type, id, position, options.timeZone);
  let next: WorkflowGraph = { ...graph, nodes: [...graph.nodes, node] };
  if (source !== undefined && handle !== undefined) {
    next = connect(next, { source: source.id, handle, target: id }) ?? next;
  }
  return { graph: next, nodeId: id };
}

/** Right of a node, at the height of the handle the new node hangs from. */
function placeAfterHandle(
  graph: WorkflowGraph,
  source: WorkflowNode,
  handle: string,
): { x: number; y: number } {
  if (source.position == null) return placeFor(graph, source.id);
  const handles = WORKFLOW_NODE_HANDLES[source.type];
  const index = Math.max(0, handles.indexOf(handle));
  // A fan-out stacks its branches; every other handle has its own row.
  const branches =
    WORKFLOW_FAN_OUT_HANDLES[source.type] === handle
      ? graph.edges.filter(
          (edge) => edge.source.nodeId === source.id && edge.source.handle === handle,
        ).length
      : 0;
  const row = handles.length > 1 ? index - (handles.length - 1) / 2 : 0;
  return {
    x: source.position.x + STEP_X,
    y: source.position.y + Math.round((row + branches) * ROW_Y),
  };
}

function isTriggerType(type: WorkflowNodeType): boolean {
  return type.startsWith('trigger.');
}

/** Vertical distance between two rows of a tidied graph. */
const ROW_Y = 150;

/**
 * Lays the graph out in columns by how many steps a node is from a trigger
 * ("Aufräumen"). A node sits one column right of the furthest node leading
 * into it, so a join lands after every branch it waits for; within a column
 * the nodes keep the order their predecessors give them, which keeps "ja"
 * above "nein" and lines from crossing in the common shapes. Only ever run on
 * a person's request: a position somebody chose is not overwritten silently.
 * A node on a cycle (which the check refuses anyway) keeps the column it had
 * when the cycle was found.
 */
export function tidyGraph(graph: WorkflowGraph): WorkflowGraph {
  if (graph.nodes.length === 0) return graph;
  const incoming = new Map<string, string[]>();
  const outgoing = new Map<string, WorkflowEdge[]>();
  for (const edge of graph.edges) {
    incoming.set(edge.target.nodeId, [
      ...(incoming.get(edge.target.nodeId) ?? []),
      edge.source.nodeId,
    ]);
    outgoing.set(edge.source.nodeId, [...(outgoing.get(edge.source.nodeId) ?? []), edge]);
  }

  // Longest path from any root, by a depth-first walk that stops on a cycle.
  const column = new Map<string, number>();
  const visiting = new Set<string>();
  const columnOf = (id: string): number => {
    const known = column.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const sources = incoming.get(id) ?? [];
    const value = sources.length === 0 ? 0 : Math.max(...sources.map(columnOf)) + 1;
    visiting.delete(id);
    column.set(id, value);
    return value;
  };
  for (const node of graph.nodes) columnOf(node.id);

  // Order inside a column: by the rank of the predecessor and the handle the
  // line leaves from, roots by their current height.
  const rank = new Map<string, number>();
  const columns: string[][] = [];
  for (const node of graph.nodes) {
    const index = column.get(node.id) ?? 0;
    (columns[index] ??= []).push(node.id);
  }
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const sortKey = (id: string): number => {
    const parents = graph.edges.filter((edge) => edge.target.nodeId === id);
    if (parents.length === 0) return byId.get(id)?.position?.y ?? 0;
    const keys = parents.map((edge) => {
      const parent = byId.get(edge.source.nodeId);
      const handles = parent === undefined ? [] : WORKFLOW_NODE_HANDLES[parent.type];
      const branch = (outgoing.get(edge.source.nodeId) ?? []).indexOf(edge);
      return (
        (rank.get(edge.source.nodeId) ?? 0) * 100 +
        Math.max(0, handles.indexOf(edge.source.handle)) * 10 +
        Math.max(0, branch)
      );
    });
    return keys.reduce((sum, key) => sum + key, 0) / keys.length;
  };
  for (const ids of columns) {
    if (ids === undefined) continue;
    ids.sort((a, b) => sortKey(a) - sortKey(b));
    ids.forEach((id, index) => rank.set(id, index));
  }

  const positions = new Map<string, { x: number; y: number }>();
  columns.forEach((ids, index) => {
    if (ids === undefined) return;
    const offset = ((ids.length - 1) * ROW_Y) / 2;
    ids.forEach((id, row) => positions.set(id, { x: index * STEP_X, y: row * ROW_Y - offset }));
  });
  return {
    ...graph,
    nodes: graph.nodes.map((node) => ({
      ...node,
      position: positions.get(node.id) ?? node.position,
    })),
  };
}

/** The first handle of a node with nothing connected to it yet, or a fan-out handle. */
export function freeHandle(graph: WorkflowGraph, node: WorkflowNode): string | undefined {
  const fanOut = WORKFLOW_FAN_OUT_HANDLES[node.type];
  return WORKFLOW_NODE_HANDLES[node.type].find(
    (handle) =>
      handle === fanOut ||
      !graph.edges.some((edge) => edge.source.nodeId === node.id && edge.source.handle === handle),
  );
}

/** A copy of a node beside it, unconnected, with a fresh id. */
export function duplicateNode(
  graph: WorkflowGraph,
  nodeId: string,
): { graph: WorkflowGraph; nodeId: string } | null {
  const original = graph.nodes.find((node) => node.id === nodeId);
  if (original === undefined) return null;
  const id = nextNodeId(graph, original.type);
  const position =
    original.position == null
      ? placeFor(graph, null)
      : { x: original.position.x + 40, y: original.position.y + 80 };
  const copy = { ...structuredClone(original), id, position } as WorkflowNode;
  return { graph: { ...graph, nodes: [...graph.nodes, copy] }, nodeId: id };
}

/** Removes nodes and every edge that touches them. */
export function removeNodes(graph: WorkflowGraph, nodeIds: readonly string[]): WorkflowGraph {
  const gone = new Set(nodeIds);
  return {
    ...graph,
    nodes: graph.nodes.filter((node) => !gone.has(node.id)),
    edges: graph.edges.filter(
      (edge) => !gone.has(edge.source.nodeId) && !gone.has(edge.target.nodeId),
    ),
  };
}

export function removeEdges(graph: WorkflowGraph, edgeIds: readonly string[]): WorkflowGraph {
  const gone = new Set(edgeIds);
  return { ...graph, edges: graph.edges.filter((edge) => !gone.has(edge.id)) };
}

/**
 * Connects a handle to a node. A handle that may only lead to one place has
 * its old edge replaced, which is what a person dragging a new line out of
 * it means; a fan-out handle gains another branch. Null for a connection the
 * schema or the shape of a graph rules out on its face: an unknown handle, a
 * node into itself, anything into a trigger, the same edge twice.
 */
export function connect(
  graph: WorkflowGraph,
  connection: { source: string; handle: string; target: string },
): WorkflowGraph | null {
  const source = graph.nodes.find((node) => node.id === connection.source);
  const target = graph.nodes.find((node) => node.id === connection.target);
  if (source === undefined || target === undefined) return null;
  if (!WORKFLOW_NODE_HANDLES[source.type].includes(connection.handle)) return null;
  if (source.id === target.id || isTriggerType(target.type)) return null;
  const duplicate = graph.edges.some(
    (edge) =>
      edge.source.nodeId === source.id &&
      edge.source.handle === connection.handle &&
      edge.target.nodeId === target.id,
  );
  if (duplicate) return null;
  const fanOut = WORKFLOW_FAN_OUT_HANDLES[source.type] === connection.handle;
  const kept = fanOut
    ? graph.edges
    : graph.edges.filter(
        (edge) => !(edge.source.nodeId === source.id && edge.source.handle === connection.handle),
      );
  const edge: WorkflowEdge = {
    id: nextEdgeId({ ...graph, edges: kept }),
    kind: 'flow',
    source: { nodeId: source.id, handle: connection.handle },
    target: { nodeId: target.id },
  };
  return { ...graph, edges: [...kept, edge] };
}

/** Replaces one node; its id, type and position are kept whatever the patch says. */
export function replaceNode(graph: WorkflowGraph, next: WorkflowNode): WorkflowGraph {
  return {
    ...graph,
    nodes: graph.nodes.map((node) =>
      node.id === next.id
        ? ({ ...next, id: node.id, type: node.type, position: node.position } as WorkflowNode)
        : node,
    ),
  };
}

export function moveNode(
  graph: WorkflowGraph,
  nodeId: string,
  position: { x: number; y: number },
): WorkflowGraph {
  const rounded = { x: Math.round(position.x), y: Math.round(position.y) };
  return {
    ...graph,
    nodes: graph.nodes.map((node) => (node.id === nodeId ? { ...node, position: rounded } : node)),
  };
}

/**
 * The nodes upstream of one: every node with a path into it. A condition
 * may only read what has run before it, and a goal placeholder likewise.
 */
export function upstreamOf(graph: WorkflowGraph, nodeId: string): WorkflowNode[] {
  const seen = new Set<string>();
  const queue = [nodeId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const edge of graph.edges) {
      if (edge.target.nodeId === current && !seen.has(edge.source.nodeId)) {
        seen.add(edge.source.nodeId);
        queue.push(edge.source.nodeId);
      }
    }
  }
  return graph.nodes.filter((node) => seen.has(node.id));
}

/** Upstream nodes that have a structured output a condition can read. */
export function readableSources(graph: WorkflowGraph, nodeId: string): WorkflowNode[] {
  return upstreamOf(graph, nodeId).filter((node) => {
    const fields = workflowNodeOutputFields(node);
    return fields !== null && fields.length > 0;
  });
}

/** Two graphs say the same thing; used for "unsaved changes". */
export function sameGraph(a: WorkflowGraph, b: WorkflowGraph): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
