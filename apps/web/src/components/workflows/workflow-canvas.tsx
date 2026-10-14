'use client';

import {
  applyNodeChanges,
  Background,
  BackgroundVariant,
  type Edge,
  type EdgeChange,
  Handle,
  type Node,
  type NodeChange,
  type NodeProps,
  Position,
  ReactFlow,
  useReactFlow,
} from '@xyflow/react';
import {
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleDotIcon,
  CircleSlashIcon,
  CircleXIcon,
  HourglassIcon,
  LoaderCircleIcon,
  type LucideIcon,
  PlusIcon,
  RotateCcwIcon,
  TimerOffIcon,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import * as React from 'react';

import {
  WORKFLOW_FAN_OUT_HANDLES,
  WORKFLOW_NODE_HANDLES,
  type WorkflowGraph,
  type WorkflowNode,
  type WorkflowNodeType,
} from '@exocortex/contracts';
import { cn, Popover, PopoverContent, PopoverTrigger } from '@exocortex/ui';

import { NodeTypeMark, WorkflowAddMenu } from './workflow-add-menu';
import { connect, moveNode } from './workflow-draft';
import { useWorkflowWording } from './workflow-labels';
import { type WorkflowNodeRunState } from './workflow-run-view';

import '@xyflow/react/dist/style.css';

/**
 * The graph of a workflow on a canvas (issues #164, #198), for editing a
 * draft and for following a run.
 *
 * The canvas holds no workflow of its own. It draws the contract's graph and
 * reports every gesture back as a new graph or a selection; positions are
 * the only state it keeps between renders, so a node follows the pointer
 * while it is dragged and is written into the graph when it is let go.
 *
 * Everything a pointer does here can also be done without one, because a
 * drag is not a feature: nodes are added from the rail, the `A` key or the
 * `+` beside a free way out, connected through a choice per handle in the
 * panel, and the canvas itself is keyboard-focusable node by node (Tab,
 * Enter to select, arrows to move, Delete to remove), which React Flow
 * provides and the labels below translate.
 *
 * A node shows three things that can all be true at once, so each has its
 * own channel (issue #198): selection is a halo outside the card, a problem
 * is a strip along its top and a counted mark in its header, and a run's
 * state is the row at its foot. None of them is a border colour, which is
 * why none of them can hide another.
 */

export const WORKFLOW_NODE_MIME = 'application/x-exocortex-workflow-node';

export type WorkflowSelection = { kind: 'node' | 'edge'; id: string } | null;

/** What the canvas shows on a node beyond its type and name. */
export interface WorkflowNodeDecoration {
  summary: string | null;
  /** A short consequential setting, e.g. the effective write mode. */
  badge: string | null;
  problems: number;
  runState?: WorkflowNodeRunState;
  attempts?: number;
}

interface CardData extends Record<string, unknown> {
  node: WorkflowNode;
  decoration: WorkflowNodeDecoration | undefined;
  /** Handles nothing leads out of yet, plus a fan-out, which takes more. */
  openHandles: readonly string[];
}

type CardNode = Node<CardData, 'workflow'>;

const NODE_TYPES = { workflow: WorkflowNodeCard };

/** Adding a node from a node's way out; absent while the canvas is read-only. */
type AddFrom = (source: string, handle: string, type: WorkflowNodeType) => void;
const AddFromContext = React.createContext<AddFrom | null>(null);

/** The lowest zoom a whole graph is fitted at; below it the cards stop being readable. */
const FIT_MIN_ZOOM = 0.7;

export function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/** A view change that animates, unless the reader asked for no motion. */
export function viewDuration(ms = 200): number {
  return prefersReducedMotion() ? 0 : ms;
}

export function WorkflowCanvas({
  graph,
  mode,
  selection,
  onSelect,
  decorations,
  problemEdgeIds,
  takenEdgeIds,
  onGraphChange,
  onDropType,
  onAddFrom,
  label,
  children,
}: {
  graph: WorkflowGraph;
  mode: 'edit' | 'view';
  selection: WorkflowSelection;
  onSelect: (selection: WorkflowSelection) => void;
  decorations: ReadonlyMap<string, WorkflowNodeDecoration>;
  problemEdgeIds: ReadonlySet<string>;
  takenEdgeIds?: ReadonlySet<string>;
  onGraphChange?: (graph: WorkflowGraph) => void;
  onDropType?: (type: WorkflowNodeType, position: { x: number; y: number }) => void;
  onAddFrom?: AddFrom;
  label: string;
  /** Overlays drawn on the canvas, e.g. `<Panel>`s with controls. */
  children?: React.ReactNode;
}) {
  const t = useTranslations('workflows.canvas');
  const wording = useWorkflowWording();
  const flow = useReactFlow();
  const editing = mode === 'edit';

  const name = React.useCallback(
    (id: string): string => {
      const node = graph.nodes.find((candidate) => candidate.id === id);
      return node?.label ?? id;
    },
    [graph.nodes],
  );

  const derived = React.useMemo<CardNode[]>(
    () =>
      graph.nodes.map((node, index) => ({
        id: node.id,
        type: 'workflow',
        position: node.position ?? { x: index * 280, y: 0 },
        data: {
          node,
          decoration: decorations.get(node.id),
          openHandles: openHandlesOf(graph, node),
        },
        selected: selection?.kind === 'node' && selection.id === node.id,
        // Read as the node's name by a screen reader, instead of its id.
        ariaLabel: `${wording.type(node.type)}: ${node.label ?? node.id}`,
        deletable: editing,
      })),
    [decorations, editing, graph, selection, wording],
  );

  // React Flow writes back what it measured and where a dragged node is; the
  // graph decides everything else. A new graph is merged in while rendering,
  // keeping the measurements and a drag in progress.
  const [nodes, setNodes] = React.useState<CardNode[]>(derived);
  const [mergedFrom, setMergedFrom] = React.useState(derived);
  if (mergedFrom !== derived) {
    setMergedFrom(derived);
    setNodes(mergeNodes(nodes, derived));
  }

  const edges = React.useMemo<Edge[]>(
    () =>
      graph.edges.map((edge) => {
        const source = graph.nodes.find((node) => node.id === edge.source.nodeId);
        const labelled =
          source !== undefined &&
          (WORKFLOW_NODE_HANDLES[source.type].length > 1 ||
            WORKFLOW_FAN_OUT_HANDLES[source.type] !== undefined);
        const taken = takenEdgeIds?.has(edge.id) === true;
        const broken = problemEdgeIds.has(edge.id);
        return {
          id: edge.id,
          source: edge.source.nodeId,
          sourceHandle: edge.source.handle,
          target: edge.target.nodeId,
          type: 'smoothstep',
          selected: selection?.kind === 'edge' && selection.id === edge.id,
          deletable: editing,
          ...(labelled ? { label: wording.handle(edge.source.handle) } : {}),
          className: cn(taken && 'is-taken', broken && 'has-problem'),
          ariaLabel: t('edgeLabel', {
            from: name(edge.source.nodeId),
            handle: wording.handle(edge.source.handle),
            to: name(edge.target.nodeId),
          }),
        };
      }),
    [editing, graph.edges, graph.nodes, name, problemEdgeIds, selection, t, takenEdgeIds, wording],
  );

  const onNodesChange = React.useCallback(
    (changes: NodeChange<CardNode>[]) => {
      // Removal goes through `onDelete`, which sees the edges that go with it.
      const kept = changes.filter((change) => change.type !== 'remove');
      setNodes((current) => applyNodeChanges(kept, current));
      let next = graph;
      for (const change of kept) {
        if (change.type === 'position' && change.position && change.dragging === false) {
          next = moveNode(next, change.id, change.position);
        }
        if (change.type === 'select' && change.selected) onSelect({ kind: 'node', id: change.id });
      }
      if (next !== graph) onGraphChange?.(next);
    },
    [graph, onGraphChange, onSelect],
  );

  const onEdgesChange = React.useCallback(
    (changes: EdgeChange[]) => {
      for (const change of changes) {
        if (change.type === 'select' && change.selected) onSelect({ kind: 'edge', id: change.id });
      }
    },
    [onSelect],
  );

  const onDrop = React.useCallback(
    (event: React.DragEvent) => {
      const type = event.dataTransfer.getData(WORKFLOW_NODE_MIME);
      if (type.length === 0 || onDropType === undefined) return;
      event.preventDefault();
      onDropType(
        type as WorkflowNodeType,
        flow.screenToFlowPosition({ x: event.clientX, y: event.clientY }),
      );
    },
    [flow, onDropType],
  );

  return (
    <AddFromContext.Provider value={editing && onAddFrom !== undefined ? onAddFrom : null}>
      <ReactFlow<CardNode>
        className="exocortex-workflow-canvas"
        aria-label={label}
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        colorMode="dark"
        fitView
        fitViewOptions={{ padding: 0.15, maxZoom: 1, minZoom: FIT_MIN_ZOOM }}
        minZoom={0.25}
        maxZoom={1.5}
        proOptions={{ hideAttribution: true }}
        nodesDraggable={editing}
        nodesConnectable={editing}
        elementsSelectable
        deleteKeyCode={editing ? ['Backspace', 'Delete'] : null}
        multiSelectionKeyCode={null}
        selectionKeyCode={null}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onPaneClick={() => onSelect(null)}
        isValidConnection={(connection) =>
          connection.sourceHandle != null &&
          connect(graph, {
            source: connection.source,
            handle: connection.sourceHandle,
            target: connection.target,
          }) !== null
        }
        onConnect={(connection) => {
          if (connection.sourceHandle == null) return;
          const next = connect(graph, {
            source: connection.source,
            handle: connection.sourceHandle,
            target: connection.target,
          });
          if (next !== null) onGraphChange?.(next);
        }}
        onDelete={({ nodes: gone, edges: cut }) => {
          if (!editing) return;
          const goneIds = new Set(gone.map((node) => node.id));
          const cutIds = new Set(cut.map((edge) => edge.id));
          onGraphChange?.({
            ...graph,
            nodes: graph.nodes.filter((node) => !goneIds.has(node.id)),
            edges: graph.edges.filter(
              (edge) =>
                !cutIds.has(edge.id) &&
                !goneIds.has(edge.source.nodeId) &&
                !goneIds.has(edge.target.nodeId),
            ),
          });
          onSelect(null);
        }}
        onDragOver={(event) => {
          if (!editing) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'copy';
        }}
        onDrop={onDrop}
        ariaLabelConfig={{
          'node.a11yDescription.default': t('a11y.node'),
          'node.a11yDescription.keyboardDisabled': t('a11y.nodeKeyboardDisabled'),
          'node.a11yDescription.ariaLiveMessage': ({ direction, x, y }) =>
            t('a11y.moved', { direction, x: Math.round(x), y: Math.round(y) }),
          'edge.a11yDescription.default': t('a11y.edge'),
          'handle.ariaLabel': t('a11y.handle'),
        }}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
        {children}
      </ReactFlow>
    </AddFromContext.Provider>
  );
}

/** Handles nothing leads out of yet, plus a fan-out, which takes more. */
function openHandlesOf(graph: WorkflowGraph, node: WorkflowNode): string[] {
  const fanOut = WORKFLOW_FAN_OUT_HANDLES[node.type];
  const taken = new Set(
    graph.edges.flatMap((edge) => (edge.source.nodeId === node.id ? [edge.source.handle] : [])),
  );
  return WORKFLOW_NODE_HANDLES[node.type].filter(
    (handle) => handle === fanOut || !taken.has(handle),
  );
}

/** The graph's nodes, keeping what React Flow measured and a drag in progress. */
function mergeNodes(current: readonly CardNode[], derived: readonly CardNode[]): CardNode[] {
  const byId = new Map(current.map((node) => [node.id, node]));
  return derived.map((node) => {
    const previous = byId.get(node.id);
    if (previous === undefined) return node;
    return {
      ...node,
      ...(previous.measured === undefined ? {} : { measured: previous.measured }),
      ...(previous.dragging === true ? { position: previous.position, dragging: true } : {}),
    };
  });
}

/** How a node's state in a run is shown: an icon and a word, never colour alone. */
const STATE_MARKS: Readonly<
  Record<WorkflowNodeRunState, { icon: LucideIcon; tone: string; spin?: boolean }>
> = {
  succeeded: { icon: CircleCheckIcon, tone: 'text-success' },
  failed: { icon: CircleXIcon, tone: 'text-destructive-text' },
  timed_out: { icon: TimerOffIcon, tone: 'text-destructive-text' },
  running: { icon: LoaderCircleIcon, tone: 'text-primary-text', spin: true },
  queued: { icon: CircleDotIcon, tone: 'text-primary-text' },
  waiting: { icon: HourglassIcon, tone: 'text-primary-text' },
  runnable: { icon: CircleDotIcon, tone: 'text-muted-foreground' },
  skipped: { icon: CircleSlashIcon, tone: 'text-muted-foreground' },
  cancelled: { icon: CircleSlashIcon, tone: 'text-muted-foreground' },
  untouched: { icon: CircleDashedIcon, tone: 'text-muted-foreground' },
};

function WorkflowNodeCard({ data, selected }: NodeProps<CardNode>) {
  const { node, decoration, openHandles } = data;
  const problems = decoration?.problems ?? 0;
  const state = decoration?.runState;
  return (
    <div
      className={cn(
        'group/node relative w-60 rounded-lg border border-border-strong bg-card text-card-foreground shadow-sm',
        // Selection is drawn outside the card, so nothing on it can cover it.
        selected && 'outline-2 outline-offset-4 outline-primary',
        state === 'untouched' || state === 'skipped' ? 'opacity-70' : null,
      )}
      data-testid="workflow-node"
      data-node-id={node.id}
      data-node-state={state}
      data-selected={selected ? 'true' : undefined}
      data-problems={problems > 0 ? problems : undefined}
    >
      {problems > 0 ? (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-1 rounded-t-lg bg-destructive"
        />
      ) : null}
      {node.type.startsWith('trigger.') ? null : (
        <Handle type="target" position={Position.Left} className="exocortex-workflow-handle" />
      )}
      <CardHeading node={node} problems={problems} />
      <CardBody node={node} decoration={decoration} />
      {state === undefined ? null : (
        <CardRunState state={state} attempts={decoration?.attempts ?? 0} />
      )}
      <CardHandles node={node} openHandles={openHandles} />
    </div>
  );
}

function CardHeading({ node, problems }: { node: WorkflowNode; problems: number }) {
  const t = useTranslations('workflows.canvas');
  const wording = useWorkflowWording();
  return (
    <div className="flex items-center gap-2 px-3 pt-3">
      <NodeTypeMark type={node.type} />
      <span className="min-w-0 truncate text-meta text-muted-foreground">
        {wording.type(node.type)}
      </span>
      {problems > 0 ? (
        <span
          className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-sm bg-destructive px-1.5 py-0.5 text-micro font-medium text-destructive-foreground"
          data-testid="workflow-node-problems"
        >
          <CircleAlertIcon className="size-3" aria-hidden />
          <span className="exocortex-numeric" aria-hidden>
            {problems}
          </span>
          <span className="exocortex-sr-only">{t('problems', { count: problems })}</span>
        </span>
      ) : null}
    </div>
  );
}

function CardBody({
  node,
  decoration,
}: {
  node: WorkflowNode;
  decoration: WorkflowNodeDecoration | undefined;
}) {
  const name = node.label ?? node.id;
  return (
    <div className="flex flex-col gap-0.5 px-3 pt-1.5 pb-3">
      <span className="truncate text-ui font-semibold" title={name}>
        {name}
      </span>
      {decoration?.summary ? (
        <span className="line-clamp-2 text-meta text-muted-foreground">{decoration.summary}</span>
      ) : null}
      {decoration?.badge ? (
        <span className="mt-1 w-fit rounded-sm bg-secondary px-1.5 py-0.5 text-micro text-secondary-foreground">
          {decoration.badge}
        </span>
      ) : null}
    </div>
  );
}

function CardRunState({ state, attempts }: { state: WorkflowNodeRunState; attempts: number }) {
  const t = useTranslations('workflows.canvas');
  const wording = useWorkflowWording();
  const mark = STATE_MARKS[state];
  return (
    <div
      className="flex items-center gap-1.5 border-t border-border bg-sunken/40 px-3 py-1.5 text-meta"
      data-testid="workflow-node-state"
    >
      <mark.icon
        className={cn('size-3.5 shrink-0', mark.tone, mark.spin && 'motion-safe:animate-spin')}
        aria-hidden
      />
      <span>{wording.nodeState(state)}</span>
      {attempts > 1 ? (
        <span className="ml-auto inline-flex items-center gap-1 text-muted-foreground">
          <RotateCcwIcon className="size-3" aria-hidden />
          <span className="exocortex-numeric">{t('attempts', { count: attempts })}</span>
        </span>
      ) : null}
    </div>
  );
}

/**
 * One way out: a handle on the card's edge. Several, or a fan-out: one
 * labelled row per handle, so "ja" and "nein" are words beside the point a
 * line leaves from rather than two dots to tell apart. A way out with
 * nothing behind it yet carries a `+` that adds the next step right there.
 */
function CardHandles({
  node,
  openHandles,
}: {
  node: WorkflowNode;
  openHandles: readonly string[];
}) {
  const wording = useWorkflowWording();
  const handles = WORKFLOW_NODE_HANDLES[node.type];
  if (handles.length === 0) return null;
  if (handles.length === 1 && WORKFLOW_FAN_OUT_HANDLES[node.type] === undefined) {
    const handle = handles[0]!;
    return (
      <>
        <Handle
          type="source"
          id={handle}
          position={Position.Right}
          className="exocortex-workflow-handle"
        />
        {openHandles.includes(handle) ? (
          <AddFromHandle node={node} handle={handle} className="top-1/2 -translate-y-1/2" />
        ) : null}
      </>
    );
  }
  return (
    <div className="flex flex-col gap-1 border-t border-border py-1.5 pl-3">
      {handles.map((handle) => (
        <span
          key={handle}
          className="relative block pr-3 text-right text-micro text-muted-foreground"
        >
          {wording.handle(handle)}
          <Handle
            type="source"
            id={handle}
            position={Position.Right}
            className="exocortex-workflow-handle"
          />
          {openHandles.includes(handle) ? (
            <AddFromHandle node={node} handle={handle} className="top-1/2 -translate-y-1/2" />
          ) : null}
        </span>
      ))}
    </div>
  );
}

function AddFromHandle({
  node,
  handle,
  className,
}: {
  node: WorkflowNode;
  handle: string;
  className?: string;
}) {
  const t = useTranslations('workflows.canvas');
  const wording = useWorkflowWording();
  const addFrom = React.useContext(AddFromContext);
  const [open, setOpen] = React.useState(false);
  if (addFrom === null) return null;
  const name = node.label ?? node.id;
  const label = t('addFrom', { handle: wording.handle(handle), node: name });
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label={label}
            title={label}
            data-testid={`workflow-add-from-${node.id}-${handle}`}
            className={cn(
              // `nodrag nopan`: React Flow leaves a press on this to the button.
              'nodrag nopan absolute -right-9 grid size-6 place-items-center rounded-full border border-border-strong bg-popover text-foreground shadow-xs',
              'opacity-0 transition-opacity group-hover/node:opacity-100 focus-visible:opacity-100 hover:bg-accent-solid',
              'group-data-[selected=true]/node:opacity-100 data-[popup-open]:opacity-100',
              className,
            )}
          >
            <PlusIcon className="size-3.5" aria-hidden />
          </button>
        }
      />
      <PopoverContent side="right" align="start" className="p-2">
        <WorkflowAddMenu
          withTriggers={false}
          context={t('addFromContext', { handle: wording.handle(handle), node: name })}
          onPick={(type) => {
            setOpen(false);
            addFrom(node.id, handle, type);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}
