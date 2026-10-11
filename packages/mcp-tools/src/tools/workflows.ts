import { z } from 'zod';

import {
  cancelWorkflowRunRequestSchema,
  createWorkflowRequestSchema,
  deleteWorkflowResponseSchema,
  duplicateWorkflowRequestSchema,
  idSchema,
  startWorkflowRunRequestSchema,
  updateWorkflowRequestSchema,
  WORKFLOW_NODE_HANDLES,
  type WorkflowAuthor,
  type WorkflowEnvelope,
  type WorkflowGraph,
  workflowListResponseSchema,
  type WorkflowProblem,
  workflowResponseSchema,
  workflowRunListResponseSchema,
  type WorkflowRunResponse,
  workflowRunResponseSchema,
  workflowRunStartResponseSchema,
  type WorkflowSummary,
  workflowValidationResponseSchema,
  workflowVersionListResponseSchema,
  workflowVersionResponseSchema,
} from '@exocortex/contracts';

import { type AnyToolDefinition, defineTool } from '../tool.js';

/**
 * Agent workflows (issue #160, ADR-075).
 *
 * A workflow is a versioned graph: triggers start it, agent nodes hand work
 * to the built-in AI, control nodes branch, fan out, join, ask a person and
 * end it. Reading workflows, their versions and runs and checking a graph is
 * on both agent surfaces, and so is writing a draft (issue #165, ADR-080):
 * create, revise, duplicate, validate, repair. A run of the built-in AI may
 * not put an agent under a looser profile into it than its own. Publishing
 * and switching on are no tools at all, and the API refuses them to any
 * agent: a person decides what becomes a version and what may start by
 * itself, and the draft says who wrote it. Starting and cancelling a run by
 * hand (issue #161) and deleting are MCP only and an admin's, because a run
 * spends what its agents spend.
 */

const GRAPH_HELP =
  'Graph: {schemaVersion: 1, nodes, edges, limits}. Knotentypen und ihre Ausgänge: ' +
  Object.entries(WORKFLOW_NODE_HANDLES)
    .map(([type, handles]) => `${type} (${handles.join('/') || 'keine'})`)
    .join(', ') +
  '. Eine Kante: {id, kind: "flow", source: {nodeId, handle}, target: {nodeId}}. Nur ein join ' +
  'hat mehrere Eingänge, nur parallel.branch mehrere Ausgänge; keine Zyklen. trigger.schedule: ' +
  'schedule {kind: DAILY|WEEKLY|MONTHLY|ONCE|CRON, time "HH:MM", weekday 0-6 (0 Sonntag), ' +
  'dayOfMonth, at, cron, timeZone}. agent: goal, ' +
  'documentIds, agentProfileId, writeMode, budgetMicroUsd, outputFields [{name, type: ' +
  'string|number|boolean|enum, values, required}], completion review|done (weiter, sobald der ' +
  'Auftrag abgegeben ist, oder erst, wenn ein Mensch ihn erledigt hat). Ein agent-Knoten legt ' +
  'einen gewöhnlichen Auftrag an und startet die eingebaute KI darauf; im goal setzen ' +
  '{{knoten.feld}} ein Feld eines vorgelagerten agent-Knotens und {{input.schlüssel}} einen ' +
  'Startwert ein. Sein Ergebnis für spätere Knoten: fields, workItemId, aiRunId, summary, ' +
  'resultDocumentIds, spentMicroUsd. condition: source {nodeId, field} eines vorgelagerten ' +
  'agent- oder approval-Knotens oder {input: schlüssel} des Startwerts, operator (eq, neq, gt, ' +
  'gte, lt, lte, present, absent, is_true, is_false), value; entscheidet ohne Modell. parallel: ' +
  'zwei oder mehr branch-Kanten laufen gleichzeitig. join: policy all (wartet auf jeden ' +
  'Eingang) oder any (weiter beim ersten; ein gescheiterter anderer Zweig lässt den Lauf dann ' +
  'nicht scheitern). approval: title, question, assigneeUserId, note none|optional|required; ' +
  'fragt einen Menschen über "Wartet auf dich" und wartet ohne Worker, Tage lang wenn nötig; ' +
  'Ergebnis fields.approved (boolean) und fields.note, Ausgang approved oder rejected; nur ' +
  'ein Mensch kann antworten, kein Agent. end: outcome succeeded|failed|cancelled, summary; ' +
  'beendet den Lauf sofort und bricht ab, was auf anderen Zweigen noch läuft. Ein Entwurf ' +
  'darf unvollständig sein; exo_workflow_validate nennt, was vor dem Veröffentlichen fehlt.';

/**
 * A small graph that publishes as it is, and the repair loop around it. Kept
 * beside the help so an agent copies a shape that works rather than one it
 * reconstructed from prose (issue #165).
 */
/** Sunday evening: read the open ideas, propose five next tasks, ask a person. */
export const EXAMPLE_WORKFLOW_GRAPH = {
  schemaVersion: 1,
  nodes: [
    {
      id: 'start',
      type: 'trigger.schedule',
      schedule: { kind: 'WEEKLY', time: '18:00', weekday: 0, timeZone: 'Europe/Berlin' },
    },
    {
      id: 'sichten',
      type: 'agent',
      goal: 'Lies die offenen technischen Ideen und schlage die fünf besten nächsten Aufgaben vor.',
      writeMode: 'propose',
      outputFields: [{ name: 'anzahl', type: 'number', required: true }],
    },
    {
      id: 'pruefen',
      type: 'approval',
      title: 'Vorschläge ansehen',
      question: 'Passen die fünf Aufgaben?',
    },
    { id: 'ende', type: 'end', outcome: 'succeeded' },
  ],
  edges: [
    {
      id: 'e1',
      kind: 'flow',
      source: { nodeId: 'start', handle: 'next' },
      target: { nodeId: 'sichten' },
    },
    {
      id: 'e2',
      kind: 'flow',
      source: { nodeId: 'sichten', handle: 'next' },
      target: { nodeId: 'pruefen' },
    },
    {
      id: 'e3',
      kind: 'flow',
      source: { nodeId: 'pruefen', handle: 'approved' },
      target: { nodeId: 'ende' },
    },
  ],
  limits: {},
} as const;

const GRAPH_EXAMPLE =
  'Beispiel, jeden Sonntag um 18 Uhr offene Ideen sichten und fünf nächste Aufgaben vorschlagen: ' +
  JSON.stringify(EXAMPLE_WORKFLOW_GRAPH) +
  '. Reparieren: exo_workflow_validate mit dem geänderten graph aufrufen, bis valid true ist; ' +
  'jedes Problem nennt code und nodeId, edgeId oder path. "[edge_invalid_handle] e3: A approval ' +
  'node has no handle yes" heißt etwa: handle auf approved oder rejected setzen. Dann mit ' +
  'exo_workflow_update und expectedRevision speichern.';

function formatAuthor(author: WorkflowAuthor): string {
  const name = author.account?.name ?? 'unbekannt';
  if (author.kind === 'agent') return `Agent ${author.agentLabel ?? 'ohne Namen'} für ${name}`;
  if (author.kind === 'assistant') return `eingebaute KI für ${name}`;
  return name;
}

function formatSummary(workflow: WorkflowSummary): string {
  const published =
    workflow.publishedVersion === null
      ? 'unveröffentlicht'
      : `Version ${workflow.publishedVersion.version}`;
  return (
    `${workflow.name} (id: ${workflow.id}) · ${published} · ` +
    `${workflow.enabled ? 'eingeschaltet' : 'aus'} · Entwurf Stand ${workflow.draftRevision}` +
    (workflow.hasUnpublishedChanges ? ', unveröffentlichte Änderungen' : '') +
    (workflow.draftValid ? '' : ', Entwurf unvollständig') +
    ` (geschrieben von ${formatAuthor(workflow.draftAuthor)})` +
    ` · Auslöser: ${workflow.triggerTypes.join(', ') || 'keine'}` +
    (workflow.activeRunCount > 0 ? ` · ${workflow.activeRunCount} laufend` : '')
  );
}

/** What the workspace holds every run to, which the graph can only narrow. */
function formatEnvelope(envelope: WorkflowEnvelope): string {
  const { limits } = envelope;
  return (
    `Rahmen des Arbeitsbereichs: Workflows ${envelope.workflowsEnabled ? 'eingeschaltet' : 'ausgeschaltet'}` +
    ` · Schreibmodus höchstens ${envelope.writeMode}` +
    ` · ein Lauf jetzt: ${limits.maxNodeExecutions} Schritte, ${limits.maxParallelBranches} parallel, ` +
    `${limits.maxLifetimeSeconds} s, ${limits.budgetMicroUsd} µ$`
  );
}

function formatGraph(graph: WorkflowGraph): string {
  const nodes = graph.nodes.map(
    (node) => `- ${node.id} [${node.type}]${node.label ? ` ${node.label}` : ''}`,
  );
  const edges = graph.edges.map(
    (edge) => `- ${edge.source.nodeId}.${edge.source.handle} → ${edge.target.nodeId}`,
  );
  return ['Knoten:', ...nodes, 'Kanten:', ...(edges.length > 0 ? edges : ['- keine'])].join('\n');
}

function formatProblems(problems: readonly WorkflowProblem[]): string {
  if (problems.length === 0) return 'Keine Probleme: der Entwurf lässt sich veröffentlichen.';
  return [
    `${problems.length} Problem(e):`,
    ...problems.map((problem) => {
      const at = problem.nodeId ?? problem.edgeId ?? problem.path?.join('.') ?? 'Graph';
      return `- [${problem.code}] ${at}: ${problem.message}`;
    }),
  ].join('\n');
}

export const workflowListTool: AnyToolDefinition = defineTool({
  name: 'exo_workflow_list',
  description:
    'Listet die Agenten-Workflows eines Arbeitsbereichs: versionierte Graphen aus Auslösern, ' +
    'Agentenschritten, Bedingungen, Verzweigungen und Freigaben, mit veröffentlichter Version, ' +
    'Schalter und laufenden Läufen.',
  inputSchema: z.object({ workspaceId: idSchema }),
  surfaces: ['mcp', 'ai'],
  domain: 'workflows',
  mutating: false,
  async execute(client, input) {
    const result = await client.request({
      method: 'GET',
      path: `/api/workspaces/${input.workspaceId}/workflows`,
      responseSchema: workflowListResponseSchema,
    });
    return {
      text:
        result.workflows.length === 0
          ? 'Dieser Arbeitsbereich hat noch keine Workflows.'
          : result.workflows.map(formatSummary).join('\n'),
      data: result,
    };
  },
});

export const workflowGetTool: AnyToolDefinition = defineTool({
  name: 'exo_workflow_get',
  description:
    'Liest einen Workflow mit seinem Entwurf (Knoten und Kanten als Graph) und den Problemen, ' +
    'die vor dem Veröffentlichen noch zu lösen sind.',
  inputSchema: z.object({ workflowId: idSchema }),
  surfaces: ['mcp', 'ai'],
  domain: 'workflows',
  mutating: false,
  async execute(client, input) {
    const result = await client.request({
      method: 'GET',
      path: `/api/workflows/${input.workflowId}`,
      responseSchema: workflowResponseSchema,
    });
    return {
      text: [
        formatSummary(result.workflow),
        formatEnvelope(result.envelope),
        formatGraph(result.draft),
        formatProblems(result.problems),
      ].join('\n\n'),
      data: result,
    };
  },
});

export const workflowValidateTool: AnyToolDefinition = defineTool({
  name: 'exo_workflow_validate',
  description:
    'Prüft einen Workflow-Graphen, ohne etwas zu speichern: den mitgeschickten oder, ohne graph, ' +
    'den gespeicherten Entwurf. Jedes Problem hat einen festen code und nennt Knoten, Kante ' +
    `oder Pfad, damit sich der Graph gezielt reparieren lässt. ${GRAPH_HELP} ${GRAPH_EXAMPLE}`,
  inputSchema: z.object({ workflowId: idSchema, graph: z.unknown().optional() }),
  surfaces: ['mcp', 'ai'],
  domain: 'workflows',
  mutating: false,
  async execute(client, input) {
    const result = await client.request({
      method: 'POST',
      path: `/api/workflows/${input.workflowId}/validate`,
      body: input.graph === undefined ? {} : { graph: input.graph },
      responseSchema: workflowValidationResponseSchema,
    });
    return { text: formatProblems(result.problems), data: result };
  },
});

export const workflowVersionsTool: AnyToolDefinition = defineTool({
  name: 'exo_workflow_versions',
  description:
    'Listet die veröffentlichten Versionen eines Workflows, neueste zuerst. Eine Version ist ' +
    'unveränderlich; ein Lauf liest immer die Version, mit der er begonnen hat.',
  inputSchema: z.object({ workflowId: idSchema }),
  surfaces: ['mcp', 'ai'],
  domain: 'workflows',
  mutating: false,
  async execute(client, input) {
    const result = await client.request({
      method: 'GET',
      path: `/api/workflows/${input.workflowId}/versions`,
      responseSchema: workflowVersionListResponseSchema,
    });
    return {
      text:
        result.versions.length === 0
          ? 'Noch keine Version veröffentlicht.'
          : result.versions
              .map(
                (version) =>
                  `Version ${version.version} (id: ${version.id}) vom ${version.publishedAt.slice(0, 16)}` +
                  ` von ${version.publishedBy?.name ?? 'unbekannt'}, Entwurfsstand ${version.draftRevision}` +
                  ` geschrieben von ${formatAuthor(version.draftAuthor)}`,
              )
              .join('\n'),
      data: result,
    };
  },
});

export const workflowVersionGetTool: AnyToolDefinition = defineTool({
  name: 'exo_workflow_version_get',
  description: 'Liest eine veröffentlichte Workflow-Version samt ihrem unveränderlichen Graphen.',
  inputSchema: z.object({ versionId: idSchema }),
  surfaces: ['mcp', 'ai'],
  domain: 'workflows',
  mutating: false,
  async execute(client, input) {
    const result = await client.request({
      method: 'GET',
      path: `/api/workflow-versions/${input.versionId}`,
      responseSchema: workflowVersionResponseSchema,
    });
    return {
      text: `Version ${result.version.version} (Hash ${result.version.graphHash.slice(0, 12)})\n${formatGraph(result.version.graph)}`,
      data: result,
    };
  },
});

export const workflowRunsTool: AnyToolDefinition = defineTool({
  name: 'exo_workflow_runs',
  description:
    'Listet die letzten Läufe eines Workflows mit Status, Version, Herkunft, Kosten und Fehler.',
  inputSchema: z.object({ workflowId: idSchema }),
  surfaces: ['mcp', 'ai'],
  domain: 'workflows',
  mutating: false,
  async execute(client, input) {
    const result = await client.request({
      method: 'GET',
      path: `/api/workflows/${input.workflowId}/runs`,
      responseSchema: workflowRunListResponseSchema,
    });
    return {
      text:
        result.runs.length === 0
          ? 'Dieser Workflow ist noch nie gelaufen.'
          : result.runs
              .map(
                (run) =>
                  `${run.id}: ${run.status} · Version ${run.version} · ${run.origin} · ` +
                  `${run.nodeExecutionCount} Schritte · ${run.createdAt.slice(0, 16)}` +
                  (run.errorCode === null ? '' : ` · Fehler ${run.errorCode}`),
              )
              .join('\n'),
      data: result,
    };
  },
});

export const workflowRunGetTool: AnyToolDefinition = defineTool({
  name: 'exo_workflow_run_get',
  description:
    'Liest einen Workflow-Lauf: jeden Knotenversuch mit Status, genommenen Ausgängen, Wartegrund ' +
    'und Fehlerklasse, dazu was als Nächstes laufen kann (runnable), was übersprungen wird (dead) ' +
    'und was gerade läuft oder wartet (active).',
  inputSchema: z.object({ runId: idSchema }),
  surfaces: ['mcp', 'ai'],
  domain: 'workflows',
  mutating: false,
  async execute(client, input) {
    const result = await client.request({
      method: 'GET',
      path: `/api/workflow-runs/${input.runId}`,
      responseSchema: workflowRunResponseSchema,
    });
    return { text: formatRun(result), data: result };
  },
});

/** A run as text: status, limits, every attempt, what comes next, the path taken. */
function formatRun(result: WorkflowRunResponse): string {
  const { run, progress } = result;
  const steps = result.nodeExecutions.map(
    (step) =>
      `- ${step.nodeId} #${step.attempt}: ${step.status}` +
      (step.firedHandles.length > 0 ? ` → ${step.firedHandles.join(', ')}` : '') +
      (step.waitingOn === null ? '' : ` (wartet auf ${step.waitingOn.kind})`) +
      (step.errorClass === null ? '' : ` [${step.errorClass}: ${step.errorCode ?? ''}]`),
  );
  const edges = result.events
    .filter((event) => event.type === 'edge.taken')
    .map((event) => String(event.detail?.edgeId ?? '?'));
  const limits =
    run.limits === null
      ? ''
      : ` · Grenzen: ${run.limits.maxNodeExecutions} Schritte, ${run.limits.maxParallelBranches} parallel, ` +
        `${run.limits.budgetMicroUsd} µ$, bis ${run.deadlineAt ?? '–'}`;
  return [
    `Lauf ${run.id}: ${run.status}, Version ${run.version}, ${run.origin}` +
      (run.writeMode === null ? '' : `, Schreibmodus höchstens ${run.writeMode}`) +
      (run.errorCode === null ? '' : ` [${run.errorCode}]`) +
      ` · ${run.nodeExecutionCount} Versuche, ${run.spentMicroUsd} µ$ ausgegeben` +
      limits,
    'Schritte:',
    ...steps,
    `Als Nächstes: ${progress.runnable.join(', ') || '–'} · aktiv: ${progress.active.join(', ') || '–'}` +
      ` · übersprungen: ${progress.dead.join(', ') || '–'}`,
    `Genommene Kanten: ${edges.join(', ') || '–'} · ${result.events.length} Ereignisse im Verlauf`,
  ].join('\n');
}

export const workflowRunStartTool: AnyToolDefinition = defineTool({
  name: 'exo_workflow_run_start',
  description:
    'Startet einen Lauf der veröffentlichten Version eines Workflows von Hand (nur Admins, und nur ' +
    'wenn Workflows im Arbeitsbereich eingeschaltet sind). Ohne triggerNodeId vom einzigen ' +
    'manuellen Auslöser; input wird dem Lauf als Auslöser-Daten mitgegeben. test: true ist ein ' +
    'Probelauf, der auch von einem Zeitplan- oder Ereignis-Auslöser starten darf und dessen ' +
    'Agent-Knoten nur vorschlagen, solange writeMode nichts anderes sagt. writeMode verschärft ' +
    'nur: jeder Agent-Knoten arbeitet mit dem strengeren von writeMode und seinem eigenen. Der ' +
    'Lauf arbeitet im Hintergrund weiter; den Stand liest exo_workflow_run_get.',
  inputSchema: z.object({ workflowId: idSchema }).extend(startWorkflowRunRequestSchema.shape),
  surfaces: ['mcp'],
  domain: 'workflows',
  mutating: true,
  target: (input) => `workflow:${input.workflowId}`,
  async execute(client, input) {
    const { workflowId, ...body } = input;
    const result = await client.request({
      method: 'POST',
      path: `/api/workflows/${workflowId}/runs`,
      body,
      responseSchema: workflowRunStartResponseSchema,
    });
    return {
      text:
        `Lauf ${result.run.id} gestartet (Version ${result.run.version}, Status ${result.run.status}). ` +
        'Den Fortschritt liest exo_workflow_run_get.',
      data: result,
    };
  },
});

export const workflowRunCancelTool: AnyToolDefinition = defineTool({
  name: 'exo_workflow_run_cancel',
  description:
    'Bricht einen Workflow-Lauf ab, der noch läuft oder wartet (nur Admins). Was eingereiht ist ' +
    'oder wartet, endet sofort; ein Schritt, der gerade läuft, wird nicht mehr verbucht. reason ' +
    'steht danach am Lauf.',
  inputSchema: z.object({ runId: idSchema }).extend(cancelWorkflowRunRequestSchema.shape),
  surfaces: ['mcp'],
  domain: 'workflows',
  mutating: true,
  destructive: true,
  target: (input) => `workflow-run:${input.runId}`,
  async execute(client, input) {
    const { runId, ...body } = input;
    const result = await client.request({
      method: 'POST',
      path: `/api/workflow-runs/${runId}/cancel`,
      body,
      responseSchema: workflowRunResponseSchema,
    });
    return { text: `Abgebrochen.\n${formatRun(result)}`, data: result };
  },
});

export const workflowCreateTool: AnyToolDefinition = defineTool({
  name: 'exo_workflow_create',
  description:
    'Legt einen Workflow als Entwurf an (nur Admins). Ohne graph beginnt er mit einem manuellen ' +
    'Auslöser. Ein Entwurf startet nichts: Veröffentlichen und Einschalten entscheidet ein Mensch ' +
    'im Browser, und der Entwurf zeigt, welcher Agent ihn geschrieben hat. Ein KI-Lauf darf ' +
    'keinem Agent-Knoten ein lockereres Profil geben als sein eigenes ' +
    '(workflow_exceeds_author nennt die Knoten). ' +
    GRAPH_HELP +
    ' ' +
    GRAPH_EXAMPLE,
  inputSchema: z.object({ workspaceId: idSchema }).extend(createWorkflowRequestSchema.shape),
  surfaces: ['mcp', 'ai'],
  domain: 'workflows',
  mutating: true,
  target: (input) => `workspace:${input.workspaceId}:workflows`,
  async execute(client, input) {
    const { workspaceId, ...body } = input;
    const result = await client.request({
      method: 'POST',
      path: `/api/workspaces/${workspaceId}/workflows`,
      body,
      responseSchema: workflowResponseSchema,
    });
    return {
      text: `Workflow angelegt:\n${formatSummary(result.workflow)}\n\n${formatProblems(result.problems)}`,
      data: result,
    };
  },
});

export const workflowUpdateTool: AnyToolDefinition = defineTool({
  name: 'exo_workflow_update',
  description:
    'Ändert Name, Beschreibung oder den Entwurfsgraphen eines Workflows (nur Admins). graph ' +
    'ersetzt den ganzen Entwurf; expectedRevision verhindert, eine fremde Änderung zu ' +
    'überschreiben. Laufende Läufe und veröffentlichte Versionen bleiben unberührt; was du ' +
    'änderst, wird erst wirksam, wenn ein Mensch es veröffentlicht. ' +
    GRAPH_HELP,
  inputSchema: z.object({ workflowId: idSchema }).extend(updateWorkflowRequestSchema.shape),
  surfaces: ['mcp', 'ai'],
  domain: 'workflows',
  mutating: true,
  destructive: true,
  target: (input) => `workflow:${input.workflowId}`,
  async execute(client, input) {
    const { workflowId, ...body } = input;
    const result = await client.request({
      method: 'PATCH',
      path: `/api/workflows/${workflowId}`,
      body,
      responseSchema: workflowResponseSchema,
    });
    return {
      text: `Workflow geändert:\n${formatSummary(result.workflow)}\n\n${formatProblems(result.problems)}`,
      data: result,
    };
  },
});

export const workflowDuplicateTool: AnyToolDefinition = defineTool({
  name: 'exo_workflow_duplicate',
  description:
    'Kopiert den Entwurf eines Workflows in einen neuen Workflow (nur Admins), als Ausgangspunkt ' +
    'für eine Variante. Ohne name heißt er "<Name> (Kopie)". Die Kopie ist nur ein Entwurf: keine ' +
    'Versionen, keine Läufe, ausgeschaltet.',
  inputSchema: z.object({ workflowId: idSchema }).extend(duplicateWorkflowRequestSchema.shape),
  surfaces: ['mcp', 'ai'],
  domain: 'workflows',
  mutating: true,
  target: (input) => `workflow:${input.workflowId}`,
  async execute(client, input) {
    const { workflowId, ...body } = input;
    const result = await client.request({
      method: 'POST',
      path: `/api/workflows/${workflowId}/duplicate`,
      body,
      responseSchema: workflowResponseSchema,
    });
    return {
      text: `Workflow kopiert:\n${formatSummary(result.workflow)}\n\n${formatProblems(result.problems)}`,
      data: result,
    };
  },
});

export const workflowDeleteTool: AnyToolDefinition = defineTool({
  name: 'exo_workflow_delete',
  description:
    'Löscht einen Workflow endgültig, mit seinen Versionen und abgeschlossenen Läufen (nur ' +
    'Admins). Solange ein Lauf nicht fertig ist, wird das abgelehnt.',
  inputSchema: z.object({ workflowId: idSchema }),
  surfaces: ['mcp'],
  domain: 'workflows',
  mutating: true,
  destructive: true,
  irreversible: true,
  target: (input) => `workflow:${input.workflowId}`,
  async execute(client, input) {
    const result = await client.request({
      method: 'DELETE',
      path: `/api/workflows/${input.workflowId}`,
      responseSchema: deleteWorkflowResponseSchema,
    });
    return {
      text: `Workflow gelöscht, mit ${result.deletedRuns} abgeschlossenen Lauf/Läufen.`,
      data: result,
    };
  },
});

export const WORKFLOW_TOOLS: readonly AnyToolDefinition[] = [
  workflowListTool,
  workflowGetTool,
  workflowValidateTool,
  workflowVersionsTool,
  workflowVersionGetTool,
  workflowRunsTool,
  workflowRunGetTool,
  workflowRunStartTool,
  workflowRunCancelTool,
  workflowCreateTool,
  workflowUpdateTool,
  workflowDuplicateTool,
  workflowDeleteTool,
];
