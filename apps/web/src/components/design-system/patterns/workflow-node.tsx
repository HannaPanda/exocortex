'use client';

import { ReactFlowProvider } from '@xyflow/react';

import { type WorkflowGraph, type WorkflowNodeType } from '@exocortex/contracts';

import { NodeTypeMark } from '@/components/workflows/workflow-add-menu';
import {
  WorkflowCanvas,
  type WorkflowNodeDecoration,
} from '@/components/workflows/workflow-canvas';
import { CanvasControls } from '@/components/workflows/workflow-canvas-controls';

import { DsExample, DsSection, DsState, DsStates } from '../showcase';

/**
 * A fixed graph in which the states that used to fight over a node's border
 * are all true at once: selected with a problem, running with a problem,
 * waiting, failed after a retry, and untouched.
 */
const GRAPH: WorkflowGraph = {
  schemaVersion: 1,
  limits: {
    maxNodeExecutions: null,
    maxParallelBranches: null,
    maxLifetimeSeconds: null,
    budgetMicroUsd: null,
  },
  nodes: [
    { id: 'start', type: 'trigger.manual', label: 'Von Hand', position: { x: 0, y: 0 } },
    {
      id: 'agent',
      type: 'agent',
      label: 'Ideen bewerten',
      goal: '',
      documentIds: [],
      agentProfileId: null,
      writeMode: 'propose',
      budgetMicroUsd: null,
      outputFields: [],
      completion: 'review',
      position: { x: 280, y: 0 },
    },
    {
      id: 'check',
      type: 'condition',
      label: 'Gut genug?',
      source: { input: 'go' },
      operator: 'is_true',
      value: null,
      position: { x: 560, y: 0 },
    },
    {
      id: 'approval',
      type: 'approval',
      label: 'Plan freigeben',
      title: 'Plan starten?',
      question: 'Soll ich die beste Idee planen?',
      assigneeUserId: null,
      note: 'optional',
      position: { x: 840, y: -110 },
    },
    {
      id: 'stop',
      type: 'end',
      label: 'Abbrechen',
      outcome: 'cancelled',
      summary: null,
      position: { x: 840, y: 130 },
    },
  ],
  edges: [
    {
      id: 'e1',
      kind: 'flow',
      source: { nodeId: 'start', handle: 'next' },
      target: { nodeId: 'agent' },
    },
    {
      id: 'e2',
      kind: 'flow',
      source: { nodeId: 'agent', handle: 'next' },
      target: { nodeId: 'check' },
    },
    {
      id: 'e3',
      kind: 'flow',
      source: { nodeId: 'check', handle: 'true' },
      target: { nodeId: 'approval' },
    },
    {
      id: 'e4',
      kind: 'flow',
      source: { nodeId: 'check', handle: 'false' },
      target: { nodeId: 'stop' },
    },
  ],
};

const DECORATIONS: ReadonlyMap<string, WorkflowNodeDecoration> = new Map([
  [
    'start',
    { summary: 'Startet von Hand', badge: null, problems: 0, runState: 'succeeded', attempts: 1 },
  ],
  [
    'agent',
    {
      summary: 'Ziel fehlt noch',
      badge: 'Schreibt: Nur vorschlagen',
      problems: 1,
      runState: 'failed',
      attempts: 2,
    },
  ],
  [
    'check',
    { summary: 'Eingabe go ist ja', badge: null, problems: 2, runState: 'running', attempts: 1 },
  ],
  [
    'approval',
    { summary: 'Plan starten?', badge: null, problems: 0, runState: 'waiting', attempts: 1 },
  ],
  ['stop', { summary: 'Endet als abgebrochen', badge: null, problems: 0, runState: 'untouched' }],
]);

const TAKEN: ReadonlySet<string> = new Set(['e1', 'e2']);
const NONE: ReadonlySet<string> = new Set();

const FAMILIES: readonly { label: string; types: readonly WorkflowNodeType[] }[] = [
  { label: 'Auslöser: Kreis', types: ['trigger.manual', 'trigger.schedule', 'trigger.event'] },
  { label: 'Arbeit: Quadrat', types: ['agent'] },
  { label: 'Steuerung: Raute', types: ['condition', 'parallel', 'join', 'approval'] },
  { label: 'Ende: Kreis mit Ring', types: ['end'] },
];

/**
 * The workflow canvas's node (issue #198): the family as a shape, and the
 * three states a node can be in at once on three channels of their own.
 */
export function WorkflowNodePattern() {
  return (
    <DsSection
      id="workflow-knoten"
      title="Workflow-Knoten"
      lead="Ein Knoten kann gleichzeitig ausgewählt, unvollständig und mitten im Lauf sein. Jeder dieser Zustände hat deshalb einen eigenen Kanal, und keiner davon ist der Rahmen: Auswahl ist ein Halo außerhalb der Karte, ein Problem ein Streifen oben plus eine gezählte Marke, der Laufstand die Fußzeile mit Symbol und Wort."
    >
      <DsExample
        id="workflow-knoten-zustaende"
        title="Zustände zugleich"
        source="apps/web/src/components/workflows/workflow-canvas.tsx"
        note="„Ideen bewerten“ ist ausgewählt, hat ein Problem und ist nach zwei Versuchen fehlgeschlagen; „Gut genug?“ läuft und hat zwei Probleme. Die genommenen Wege sind dicker und in primary. Nichts davon hängt an der Farbe allein: Das Problem ist gezählt, der Laufstand ist ein Wort."
      >
        <div className="h-80 overflow-hidden rounded-lg border border-border">
          <ReactFlowProvider>
            <WorkflowCanvas
              graph={GRAPH}
              mode="view"
              selection={{ kind: 'node', id: 'agent' }}
              onSelect={() => undefined}
              decorations={DECORATIONS}
              problemEdgeIds={NONE}
              takenEdgeIds={TAKEN}
              label="Beispielgraph"
            >
              <CanvasControls />
            </WorkflowCanvas>
          </ReactFlowProvider>
        </div>
      </DsExample>
      <DsExample
        id="workflow-knoten-familien"
        title="Familien als Form"
        source="apps/web/src/components/workflows/workflow-add-menu.tsx"
        note="Die Form sagt, wozu ein Knoten gehört, weil die One-Signal-Regel keine Farbe dafür übrig lässt. Dieselbe Marke steht in der Leiste, im Hinzufügen-Menü, auf der Karte und im Inspector."
      >
        <DsStates>
          {FAMILIES.map((family) => (
            <DsState key={family.label} label={family.label}>
              <div className="flex gap-2">
                {family.types.map((type) => (
                  <NodeTypeMark key={type} type={type} size="lg" />
                ))}
              </div>
            </DsState>
          ))}
        </DsStates>
      </DsExample>
    </DsSection>
  );
}
