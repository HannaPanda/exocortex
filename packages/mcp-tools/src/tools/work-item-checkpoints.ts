import { z } from 'zod';

import {
  idSchema,
  recordWorkCheckpointRequestSchema,
  type WorkCheckpoint,
  workCheckpointListResponseSchema,
  workCheckpointResponseSchema,
} from '@exocortex/contracts';

import { type AnyToolDefinition, defineTool } from '../tool.js';

/**
 * Working states of delegated work (issue #142, ADR-069).
 *
 * What a model has to understand: a checkpoint is where one task stands --
 * what is done, what is left, what was found out -- written so that a later
 * run, perhaps another model on another provider, carries on from it without
 * the old conversation. It is not memory; what should be known for good
 * belongs there, not here.
 */

const STEP_MARKS = { done: 'x', in_progress: '~', open: ' ' } as const;

function formatCheckpoint(checkpoint: WorkCheckpoint): string {
  const by = checkpoint.system
    ? 'von eXocortex festgehalten'
    : `von ${checkpoint.author.name ?? checkpoint.author.kind}`;
  const lines = [
    `Checkpoint ${checkpoint.id} · ${checkpoint.createdAt.slice(0, 16)} · ${checkpoint.trigger} · ${by}` +
      (checkpoint.model === null ? '' : ` · ${checkpoint.model}`),
  ];
  if (checkpoint.summary.length > 0) lines.push(checkpoint.summary);
  if (checkpoint.plan.length > 0) {
    lines.push(
      'Plan:',
      ...checkpoint.plan.map((step) => `- [${STEP_MARKS[step.status]}] ${step.text}`),
    );
  }
  if (checkpoint.assumptions.length > 0) {
    lines.push('Annahmen:', ...checkpoint.assumptions.map((line) => `- ${line}`));
  }
  if (checkpoint.findings.length > 0) {
    lines.push('Erkenntnisse:', ...checkpoint.findings.map((line) => `- ${line}`));
  }
  if (checkpoint.lastAction !== null) lines.push(`Letzte Aktion: ${checkpoint.lastAction}`);
  if (checkpoint.nextStep !== null) lines.push(`Nächster Schritt: ${checkpoint.nextStep}`);
  for (const ref of checkpoint.refs) {
    const state =
      ref.title === null ? ' (gelöscht)' : ref.changedSince ? ' (seitdem geändert)' : '';
    lines.push(`- ${ref.role}: ${ref.title ?? ref.documentId} (id: ${ref.documentId})${state}`);
  }
  for (const decision of checkpoint.pendingDecisions) {
    lines.push(
      `- wartete auf: ${decision.title} (${decision.attentionItemId}, jetzt ${decision.status})`,
    );
  }
  if (checkpoint.interruptionCode !== null)
    lines.push(`Unterbrochen: ${checkpoint.interruptionCode}`);
  return lines.join('\n');
}

export const workItemCheckpointTool: AnyToolDefinition = defineTool({
  name: 'exo_work_item_checkpoint',
  description:
    'Hält fest, wo ein Auftrag gerade steht, damit ein späterer Lauf (auch mit einem anderen ' +
    'Modell) dort weitermacht, ohne den alten Chat zu lesen. summary: der Stand in Worten (beim ' +
    'ersten Mal Pflicht); plan: die Schritte mit status done, in_progress oder open; assumptions, ' +
    'findings: Listen kurzer Sätze; lastAction, nextStep: je eine Zeile; artifactDocumentIds: ' +
    'erzeugte Seiten; sourceDocumentIds: benutzte Quellen (ersetzen die Liste, Seiten werden mit ' +
    'ihrem aktuellen Stand vermerkt). Weggelassene Felder bleiben wie beim letzten Checkpoint, [] ' +
    'leert eine Liste, null eine Zeile. trigger: step (Standard), pause, waiting_for_human, ' +
    'external_wait, budget. Kein Gedächtnis: was dauerhaft gelten soll, gehört dort hin.',
  inputSchema: z.object({ workItemId: idSchema }).extend(recordWorkCheckpointRequestSchema.shape),
  surfaces: ['mcp', 'ai'],
  domain: 'workItems',
  mutating: true,
  writeClass: 'report',
  target: (input) => `work-item:${input.workItemId}`,
  async execute(client, input) {
    const { workItemId, ...body } = input;
    const result = await client.request({
      method: 'POST',
      path: `/api/work-items/${workItemId}/checkpoints`,
      body,
      responseSchema: workCheckpointResponseSchema,
    });
    return {
      text: `Arbeitsstand festgehalten (Checkpoint ${result.checkpoint.id}).`,
      data: result,
    };
  },
});

export const workItemCheckpointsTool: AnyToolDefinition = defineTool({
  name: 'exo_work_item_checkpoints',
  description:
    'Liest die festgehaltenen Arbeitsstände eines Auftrags, neuester zuerst: Stand, Plan, ' +
    'Annahmen, Erkenntnisse, erzeugte Seiten (mit Hinweis, wenn eine seitdem geändert wurde), ' +
    'offene Entscheidungen, Budget, Modell und Anlass. Der erste ist der aktuelle. Ein neuer Lauf ' +
    'mit exo_work_item_start_run setzt standardmäßig am neuesten an.',
  inputSchema: z.object({
    workItemId: idSchema,
    limit: z.number().int().min(1).max(100).optional(),
  }),
  surfaces: ['mcp', 'ai'],
  domain: 'workItems',
  mutating: false,
  async execute(client, input) {
    const result = await client.request({
      method: 'GET',
      path: `/api/work-items/${input.workItemId}/checkpoints`,
      query: { limit: input.limit },
      responseSchema: workCheckpointListResponseSchema,
    });
    if (result.checkpoints.length === 0) {
      return {
        text: 'Für diesen Auftrag ist noch kein Arbeitsstand festgehalten.',
        data: result,
      };
    }
    const more =
      result.total > result.checkpoints.length
        ? `\n\n(${result.total - result.checkpoints.length} ältere nicht gezeigt, limit erhöhen.)`
        : '';
    return {
      text: result.checkpoints.map(formatCheckpoint).join('\n\n') + more,
      data: result,
    };
  },
});

export const WORK_CHECKPOINT_TOOLS: readonly AnyToolDefinition[] = [
  workItemCheckpointTool,
  workItemCheckpointsTool,
];
