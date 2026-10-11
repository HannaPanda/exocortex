import { z } from 'zod';

import {
  createWorkflowRequestSchema,
  deleteWorkflowResponseSchema,
  idSchema,
  updateWorkflowRequestSchema,
  WORKFLOW_NODE_HANDLES,
  type WorkflowGraph,
  workflowListResponseSchema,
  type WorkflowProblem,
  workflowResponseSchema,
  workflowRunListResponseSchema,
  workflowRunResponseSchema,
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
 * on both agent surfaces. Writing a draft is MCP only and an admin's; the
 * built-in AI's own authoring is issue #165. Publishing and switching on
 * are no tools at all: a person decides what becomes a version and what may
 * start by itself.
 */

const GRAPH_HELP =
  'Graph: {schemaVersion: 1, nodes, edges, limits}. Knotentypen und ihre Ausgänge: ' +
  Object.entries(WORKFLOW_NODE_HANDLES)
    .map(([type, handles]) => `${type} (${handles.join('/') || 'keine'})`)
    .join(', ') +
  '. Eine Kante: {id, kind: "flow", source: {nodeId, handle}, target: {nodeId}}. Nur ein join ' +
  'hat mehrere Eingänge, nur parallel.branch mehrere Ausgänge; keine Zyklen. agent: goal, ' +
  'documentIds, agentProfileId, writeMode, budgetMicroUsd, outputFields [{name, type: ' +
  'string|number|boolean|enum, values, required}]. condition: source {nodeId, field} eines ' +
  'vorgelagerten agent-Knotens, operator (eq, neq, gt, gte, lt, lte, present, absent, is_true, ' +
  'is_false), value. join: policy all|any. approval: title, question, assigneeUserId. end: ' +
  'outcome succeeded|failed|cancelled. Ein Entwurf darf unvollständig sein; ' +
  'exo_workflow_validate nennt, was vor dem Veröffentlichen fehlt.';

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
    ` · Auslöser: ${workflow.triggerTypes.join(', ') || 'keine'}` +
    (workflow.activeRunCount > 0 ? ` · ${workflow.activeRunCount} laufend` : '')
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
    `oder Pfad, damit sich der Graph gezielt reparieren lässt. ${GRAPH_HELP}`,
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
                  ` von ${version.publishedBy?.name ?? 'unbekannt'}, Entwurfsstand ${version.draftRevision}`,
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
    const steps = result.nodeExecutions.map(
      (step) =>
        `- ${step.nodeId} #${step.attempt}: ${step.status}` +
        (step.firedHandles.length > 0 ? ` → ${step.firedHandles.join(', ')}` : '') +
        (step.waitingOn === null ? '' : ` (wartet auf ${step.waitingOn.kind})`) +
        (step.errorClass === null ? '' : ` [${step.errorClass}: ${step.errorCode ?? ''}]`),
    );
    const { progress } = result;
    return {
      text: [
        `Lauf ${result.run.id}: ${result.run.status}, Version ${result.run.version}, ${result.run.origin}`,
        'Schritte:',
        ...steps,
        `Als Nächstes: ${progress.runnable.join(', ') || '–'} · aktiv: ${progress.active.join(', ') || '–'}` +
          ` · übersprungen: ${progress.dead.join(', ') || '–'}`,
      ].join('\n'),
      data: result,
    };
  },
});

export const workflowCreateTool: AnyToolDefinition = defineTool({
  name: 'exo_workflow_create',
  description:
    'Legt einen Workflow als Entwurf an (nur Admins). Ohne graph beginnt er mit einem manuellen ' +
    'Auslöser. Veröffentlichen und Einschalten entscheidet ein Mensch. ' +
    GRAPH_HELP,
  inputSchema: z.object({ workspaceId: idSchema }).extend(createWorkflowRequestSchema.shape),
  surfaces: ['mcp'],
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
    'überschreiben. Laufende Läufe und veröffentlichte Versionen bleiben unberührt. ' +
    GRAPH_HELP,
  inputSchema: z.object({ workflowId: idSchema }).extend(updateWorkflowRequestSchema.shape),
  surfaces: ['mcp'],
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
  workflowCreateTool,
  workflowUpdateTool,
  workflowDeleteTool,
];
