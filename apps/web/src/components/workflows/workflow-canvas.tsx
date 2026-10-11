'use client';

import {
  applyNodeChanges,
  Background,
  BackgroundVariant,
  Controls,
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
import { cn } from '@exocortex/ui';

import { connect, moveNode } from './workflow-draft';
import { NODE_ICONS, useWorkflowWording } from './workflow-labels';
import { type WorkflowNodeRunState } from './workflow-run-view';

import '@xyflow/react/dist/style.css';

/**
 * The graph of a workflow on a canvas (issue #164), for editing a draft and
 * for following a run.
 *
 * The canvas holds no workflow of its own. It draws the contract's graph and
 * reports every gesture back as a new graph or a selection; positions are
 * the only state it keeps between renders, so a node follows the pointer
 * while it is dragged and is written into the graph when it is let go.
 *
 * Everything a pointer does here can also be done from the configuration
 * panel, because a drag is not a feature: nodes are added from the palette
 * buttons, connected through a choice per handle, and the canvas itself is
 * keyboard-focusable node by node (Tab, Enter to select, arrows to move,
 * Delete to remove), which React Flow provides and the labels below translate.
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
}

type CardNode = Node<CardData, 'workflow'>;

const NODE_TYPES = { workflow: WorkflowNodeCard };

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
  label,
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
  label: string;
}) {
  const t = useTranslations('workflows.canvas');
  const wording = useWorkflowWording();
  const flow = useReactFlow();
  const editing = mode === 'edit';

  const derived = React.useMemo<CardNode[]>(
    () =>
      graph.nodes.map((node, index) => ({
        id: node.id,
        type: 'workflow',
        position: node.position ?? { x: index * 280, y: 0 },
        data: { node, decoration: decorations.get(node.id) },
        selected: selection?.kind === 'node' && selection.id === node.id,
        // Read as the node's name by a screen reader, instead of its id.
        ariaLabel: `${wording.type(node.type)}: ${node.label ?? node.id}`,
        deletable: editing,
      })),
    [decorations, editing, graph.nodes, selection, wording],
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
            from: edge.source.nodeId,
            handle: wording.handle(edge.source.handle),
            to: edge.target.nodeId,
          }),
        };
      }),
    [editing, graph.edges, graph.nodes, problemEdgeIds, selection, t, takenEdgeIds, wording],
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
    <ReactFlow<CardNode>
      className="exocortex-workflow-canvas"
      aria-label={label}
      nodes={nodes}
      edges={edges}
      nodeTypes={NODE_TYPES}
      colorMode="dark"
      fitView
      fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
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
        'controls.ariaLabel': t('a11y.controls'),
        'controls.zoomIn.ariaLabel': t('a11y.zoomIn'),
        'controls.zoomOut.ariaLabel': t('a11y.zoomOut'),
        'controls.fitView.ariaLabel': t('a11y.fitView'),
        'controls.interactive.ariaLabel': t('a11y.interactive'),
        'handle.ariaLabel': t('a11y.handle'),
      }}
    >
      <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
      <Controls showInteractive={false} position="bottom-left" />
    </ReactFlow>
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
const STATE_MARKS: Readonly<Record<WorkflowNodeRunState, { icon: LucideIcon; tone: string }>> = {
  succeeded: { icon: CircleCheckIcon, tone: 'text-success' },
  failed: { icon: CircleXIcon, tone: 'text-destructive-text' },
  timed_out: { icon: TimerOffIcon, tone: 'text-destructive-text' },
  running: { icon: LoaderCircleIcon, tone: 'text-primary-text' },
  queued: { icon: CircleDotIcon, tone: 'text-primary-text' },
  waiting: { icon: HourglassIcon, tone: 'text-primary-text' },
  runnable: { icon: CircleDotIcon, tone: 'text-muted-foreground' },
  skipped: { icon: CircleSlashIcon, tone: 'text-muted-foreground' },
  cancelled: { icon: CircleSlashIcon, tone: 'text-muted-foreground' },
  untouched: { icon: CircleDashedIcon, tone: 'text-muted-foreground' },
};

function WorkflowNodeCard({ data, selected }: NodeProps<CardNode>) {
  const { node, decoration } = data;
  const problems = decoration?.problems ?? 0;
  const state = decoration?.runState;
  return (
    <div
      className={cn(
        'relative w-60 rounded-lg border bg-card text-card-foreground shadow-sm',
        problems > 0 ? 'border-destructive' : selected ? 'border-primary' : 'border-border-strong',
        state === 'untouched' || state === 'skipped' ? 'opacity-70' : null,
      )}
      data-testid="workflow-node"
      data-node-id={node.id}
      data-node-state={state}
    >
      {node.type.startsWith('trigger.') ? null : (
        <Handle type="target" position={Position.Left} className="exocortex-workflow-handle" />
      )}
      <CardHeading node={node} problems={problems} />
      <CardBody node={node} decoration={decoration} />
      {state === undefined ? null : (
        <CardRunState state={state} attempts={decoration?.attempts ?? 0} />
      )}
      <CardHandles node={node} />
    </div>
  );
}

function CardHeading({ node, problems }: { node: WorkflowNode; problems: number }) {
  const t = useTranslations('workflows.canvas');
  const wording = useWorkflowWording();
  const Icon = NODE_ICONS[node.type];
  return (
    <div className="flex items-center gap-2 px-3 pt-2.5">
      <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <span className="min-w-0 truncate text-meta text-muted-foreground">
        {wording.type(node.type)}
      </span>
      {problems > 0 ? (
        <span
          className="ml-auto inline-flex shrink-0 items-center gap-1 text-meta text-destructive-text"
          title={t('problems', { count: problems })}
        >
          <CircleAlertIcon className="size-3.5" aria-hidden />
          <span className="exocortex-numeric">{problems}</span>
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
  return (
    <div className="flex flex-col gap-0.5 px-3 pt-1 pb-2.5">
      <span className="truncate text-ui font-medium">{node.label ?? node.id}</span>
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
      className="flex items-center gap-1.5 border-t border-border px-3 py-1.5 text-meta"
      data-testid="workflow-node-state"
    >
      <mark.icon className={cn('size-3.5 shrink-0', mark.tone)} aria-hidden />
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
 * line leaves from rather than two dots to tell apart.
 */
function CardHandles({ node }: { node: WorkflowNode }) {
  const wording = useWorkflowWording();
  const handles = WORKFLOW_NODE_HANDLES[node.type];
  if (handles.length === 0) return null;
  if (handles.length === 1 && WORKFLOW_FAN_OUT_HANDLES[node.type] === undefined) {
    return (
      <Handle
        type="source"
        id={handles[0]}
        position={Position.Right}
        className="exocortex-workflow-handle"
      />
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
        </span>
      ))}
    </div>
  );
}
