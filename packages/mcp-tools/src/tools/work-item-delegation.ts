import { z } from 'zod';

import {
  awaitChildrenRequestSchema,
  awaitChildrenResponseSchema,
  CHILD_RESULT_MAX_CHARS,
  childResultsResponseSchema,
  delegateWorkRequestSchema,
  delegateWorkResponseSchema,
  idSchema,
  type WorkItemChildResult,
} from '@exocortex/contracts';

import { type AnyToolDefinition, defineTool } from '../tool.js';

/**
 * Delegation (issue #144, ADR-072).
 *
 * A subtask is an ordinary work item with a parent, not a hidden loop inside
 * a run. What a model has to understand, and why the descriptions say it: a
 * child has its own run, budget, profile and status; the parent gets back
 * the child's result in words, never its transcript; and a run that waits
 * for children ends, to be carried on when they are back.
 */

function formatChild(child: WorkItemChildResult): string {
  const head = [`- ${child.title} (id: ${child.id})`, child.status];
  if (child.statusReason !== null) head.push(`„${child.statusReason}“`);
  if (child.criteriaTotal > 0) head.push(`Kriterien ${child.criteriaMet}/${child.criteriaTotal}`);
  if (child.spentMicroUsd > 0) head.push(`${child.spentMicroUsd} Mikro-USD`);
  const lines = [head.join(' · ')];
  if (child.result !== null) {
    const cut = child.resultTruncated ? ' (gekürzt)' : '';
    lines.push(`  Ergebnis${cut}: ${child.result}`);
  } else if (child.latestRun?.errorCode != null) {
    lines.push(`  Letzter Lauf ${child.latestRun.status}, Fehler ${child.latestRun.errorCode}`);
  }
  if (child.resultRefs.length > 0) {
    lines.push(
      `  Ergebnisseiten: ${child.resultRefs.map((ref) => `${ref.title} (id: ${ref.documentId})`).join(', ')}`,
    );
  }
  return lines.join('\n');
}

export const workItemDelegateTool: AnyToolDefinition = defineTool({
  name: 'exo_work_item_delegate',
  description:
    'Gibt einen Teil eines Auftrags als Teilauftrag ab (workItemId ist der übergeordnete ' +
    'Auftrag). Der Teilauftrag ist ein eigener Auftrag mit eigenem Lauf, Budget, Profil, Status ' +
    'und Ergebnis. Bearbeiter ist ohne assignee die eingebaute KI, und dann startet sein Lauf ' +
    'sofort (start: false legt ihn nur an); ein Mensch oder Agent als Bearbeiter bekommt ihn nur ' +
    'zugewiesen. goal beschreibt die Aufgabe für sich verständlich, expectedResult die Form des ' +
    'Ergebnisses, contextDocumentIds die nötigen Seiten. budgetMicroUsd wird vom Restbudget des ' +
    'Auftrags abgezogen und kann es nie übersteigen. writeMode ist höchstens so frei wie beim ' +
    'Auftrag selbst; read_only und propose laufen gleichzeitig, direkt schreibende Teilaufträge ' +
    'nacheinander. agentProfileId wählt eine Rolle, die nicht mehr erlaubt als die des Auftrags. ' +
    'Danach mit exo_work_item_await_children warten.',
  inputSchema: z.object({ workItemId: idSchema }).extend(delegateWorkRequestSchema.shape),
  surfaces: ['mcp', 'ai'],
  domain: 'workItems',
  mutating: true,
  writeClass: 'report',
  target: (input) => `work-item:${input.workItemId}`,
  async execute(client, input) {
    const { workItemId, ...body } = input;
    const result = await client.request({
      method: 'POST',
      path: `/api/work-items/${workItemId}/delegate`,
      body,
      responseSchema: delegateWorkResponseSchema,
    });
    const child = result.workItem;
    const started =
      result.run !== null
        ? ` Lauf ${result.run.id} gestartet.`
        : result.startRefused !== null
          ? ` Nicht gestartet (${result.startRefused}); exo_work_item_start_run startet ihn später.`
          : '';
    const budget =
      child.budgetMicroUsd === null ? '' : ` Budget ${child.budgetMicroUsd} Mikro-USD.`;
    return {
      text: `Teilauftrag angelegt: ${child.title} (id: ${child.id}).${budget}${started}`,
      data: result,
    };
  },
});

export const workItemChildResultsTool: AnyToolDefinition = defineTool({
  name: 'exo_work_item_child_results',
  description:
    'Liest, was die Teilaufträge eines Auftrags zurückgegeben haben: Status, Ergebnis in Worten ' +
    '(je Teilauftrag gekürzt auf maxChars, Standard 2000), Ergebnisseiten, Kriterien und Kosten. ' +
    'Nie das Protokoll ihrer Läufe. childIds wählt bestimmte Teilaufträge, sonst alle. Ein ' +
    'Ergebnis ist zurück (returned), sobald der Teilauftrag zur Abnahme steht oder geschlossen ist.',
  inputSchema: z.object({
    workItemId: idSchema,
    childIds: z.array(idSchema).min(1).max(50).optional(),
    maxChars: z.number().int().min(200).max(CHILD_RESULT_MAX_CHARS).optional(),
  }),
  surfaces: ['mcp', 'ai'],
  domain: 'workItems',
  mutating: false,
  async execute(client, input) {
    const result = await client.request({
      method: 'GET',
      path: `/api/work-items/${input.workItemId}/children/results`,
      query: {
        childIds: input.childIds?.join(','),
        maxChars: input.maxChars,
      },
      responseSchema: childResultsResponseSchema,
    });
    if (result.children.length === 0) {
      return {
        text: 'Dieser Auftrag hat keine Teilaufträge. exo_work_item_delegate gibt einen ab.',
        data: result,
      };
    }
    const back = result.children.filter((child) => child.returned).length;
    const waiting =
      result.awaiting === null
        ? ''
        : `\nWartet auf ${result.awaiting.pendingChildIds.length} davon.`;
    return {
      text:
        `${back} von ${result.children.length} Teilauftrag/Teilaufträgen zurück:${waiting}\n` +
        result.children.map(formatChild).join('\n'),
      data: result,
    };
  },
});

export const workItemAwaitChildrenTool: AnyToolDefinition = defineTool({
  name: 'exo_work_item_await_children',
  description:
    'Wartet, bis Teilaufträge zurück sind (zur Abnahme oder geschlossen). Ohne childIds auf alle ' +
    'offenen, mit childIds nur auf diese. Ist keiner mehr offen, kommen die Ergebnisse sofort ' +
    'zurück. Sonst endet dein Lauf nach diesem Aufruf; sind alle zurück, setzt ein neuer Lauf im ' +
    'selben Chat die Arbeit mit ihren Ergebnissen fort. Halte vorher mit ' +
    'exo_work_item_checkpoint fest, was du mit den Ergebnissen vorhast. Ein externer Agent fragt ' +
    'den Stand mit exo_work_item_child_results ab.',
  inputSchema: z.object({ workItemId: idSchema }).extend(awaitChildrenRequestSchema.shape),
  surfaces: ['mcp', 'ai'],
  domain: 'workItems',
  mutating: true,
  writeClass: 'report',
  target: (input) => `work-item:${input.workItemId}`,
  async execute(client, input) {
    const { workItemId, ...body } = input;
    const result = await client.request({
      method: 'POST',
      path: `/api/work-items/${workItemId}/await-children`,
      body,
      responseSchema: awaitChildrenResponseSchema,
    });
    if (!result.waiting) {
      return {
        text:
          result.results.length === 0
            ? 'Es gibt keine Teilaufträge, auf die zu warten wäre.'
            : `Alle sind schon zurück:\n${result.results.map(formatChild).join('\n')}`,
        data: result,
      };
    }
    const pending = result.awaiting?.pendingChildIds.length ?? 0;
    return {
      text:
        `Der Auftrag wartet auf ${pending} Teilauftrag/Teilaufträge. Beende diesen Lauf ohne ` +
        'weitere Schritte; sind sie zurück, geht die Arbeit mit ihren Ergebnissen weiter. ' +
        '(Als externer Agent: frag den Stand später mit exo_work_item_child_results ab.)',
      data: result,
      pausesRun: true,
    };
  },
});

export const WORK_ITEM_DELEGATION_TOOLS: readonly AnyToolDefinition[] = [
  workItemDelegateTool,
  workItemChildResultsTool,
  workItemAwaitChildrenTool,
];
