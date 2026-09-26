import { z } from 'zod';

import {
  addWorkItemNoteRequestSchema,
  createWorkItemRequestSchema,
  deleteWorkItemResponseSchema,
  idSchema,
  startWorkItemRunRequestSchema,
  startWorkItemRunResponseSchema,
  updateWorkItemRequestSchema,
  type WorkItemDetail,
  workItemListResponseSchema,
  type WorkItemParticipant,
  workItemResponseSchema,
  workItemStatusSchema,
  type WorkItemSummary,
} from '@exocortex/contracts';

import { type AnyToolDefinition, defineTool } from '../tool.js';

/**
 * Delegated work (issue #138, ADR-066).
 *
 * What a model has to understand, and why the descriptions keep saying it: a
 * work item is the ask, a run is one attempt at it. Its status is a decision
 * somebody records, not something that follows from a run finishing, so an
 * agent that did the work says so with `exo_work_item_update`, and one that is
 * stuck says what it waits on rather than leaving the item `working`.
 */

const STATUS_HELP =
  'Status: queued (angelegt, noch nicht begonnen), working, blocked (hängt an etwas anderem), ' +
  'waiting_for_human (braucht eine Entscheidung oder Information von einem Menschen), review ' +
  '(fertig, wartet auf Abnahme), done, failed, cancelled. Die letzten drei schließen den Auftrag.';

const ASSIGNEE_HELP =
  'Bearbeiter: {"kind":"assistant"} für die eingebaute KI, {"kind":"human","userId":…} für eine ' +
  'Person, {"kind":"agent","userId":…} für ein Agentenkonto (z. B. Claude Code, Hermes), null für ' +
  'niemanden. Personen und Agentenkonten müssen Mitglied des Arbeitsbereichs sein.';

function participant(value: WorkItemParticipant | null): string {
  if (value === null) return 'niemand';
  if (value.kind === 'assistant') return 'eingebaute KI';
  const name = value.name ?? value.userId ?? 'unbekannt';
  return value.kind === 'agent' ? `Agent ${name}` : name;
}

function formatSummary(item: WorkItemSummary): string {
  const parts = [`- ${item.title} (id: ${item.id})`, item.status];
  if (item.statusReason !== null) parts.push(`„${item.statusReason}“`);
  if (item.priority !== 'normal') parts.push(`Priorität ${item.priority}`);
  parts.push(`von ${participant(item.requester)}`, `an ${participant(item.assignee)}`);
  if (item.criteriaTotal > 0) parts.push(`Kriterien ${item.criteriaMet}/${item.criteriaTotal}`);
  if (item.runCount > 0) parts.push(`${item.runCount} Lauf/Läufe`);
  if (item.dueAt !== null) parts.push(`fällig ${item.dueAt.slice(0, 10)}`);
  return parts.join(' · ');
}

function formatDetail(item: WorkItemDetail): string {
  const lines = [formatSummary(item).slice(2), '', `Ziel:\n${item.goal}`];
  if (item.acceptanceCriteria.length > 0) {
    lines.push(
      '',
      'Akzeptanzkriterien:',
      ...item.acceptanceCriteria.map((entry) => `- [${entry.met ? 'x' : ' '}] ${entry.text}`),
    );
  }
  if (item.contextRefs.length > 0) {
    lines.push(
      '',
      'Kontext:',
      ...item.contextRefs.map((ref) => `- ${ref.title} (id: ${ref.documentId})`),
    );
  }
  if (item.result !== null) lines.push('', `Ergebnis:\n${item.result}`);
  if (item.resultRefs.length > 0) {
    lines.push(
      '',
      'Ergebnisseiten:',
      ...item.resultRefs.map((ref) => `- ${ref.title} (id: ${ref.documentId})`),
    );
  }
  if (item.parent !== null)
    lines.push('', `Teil von: ${item.parent.title} (id: ${item.parent.id})`);
  if (item.children.length > 0) {
    lines.push('', 'Teilaufträge:', ...item.children.map(formatSummary));
  }
  if (item.runs.length > 0) {
    lines.push(
      '',
      'Läufe (neueste zuerst):',
      ...item.runs.map(
        (run) =>
          `- ${run.id} · ${run.status} · ${run.model}${run.errorCode === null ? '' : ` · Fehler ${run.errorCode}`}`,
      ),
    );
  }
  if (item.budgetMicroUsd !== null) {
    lines.push('', `Budget: ${item.spentMicroUsd} von ${item.budgetMicroUsd} Mikro-USD verbraucht`);
  }
  if (item.latestCheckpointAt !== null) {
    lines.push(
      '',
      `Arbeitsstände: ${item.checkpointCount}, zuletzt ${item.latestCheckpointAt.slice(0, 16)} ` +
        '(exo_work_item_checkpoints liest sie)',
    );
  }
  const recent = item.events.slice(0, 10).map((event) => {
    const note = event.note === null ? '' : `: ${event.note}`;
    return `- ${event.createdAt.slice(0, 16)} ${event.kind} (${participant(event.actor)})${note}`;
  });
  lines.push('', 'Letzte Historie:', ...recent);
  return lines.join('\n');
}

export const workItemListTool: AnyToolDefinition = defineTool({
  name: 'exo_work_item_list',
  description:
    'Listet die Aufträge (delegierte Arbeit) eines Arbeitsbereichs, offene zuerst. Ohne Filter ' +
    'nur offene; open "all" oder "false" zeigt auch abgeschlossene. assignee: "me", "assistant", ' +
    `"nobody" oder eine Konto-id; requester: "me" oder eine Konto-id; parentId "root" für nur ` +
    `oberste Aufträge. ${STATUS_HELP}`,
  inputSchema: z.object({
    workspaceId: idSchema,
    status: workItemStatusSchema.optional(),
    assignee: z.string().min(2).max(64).optional(),
    requester: z.string().min(2).max(64).optional(),
    parentId: z.string().min(4).max(64).optional(),
    open: z.enum(['true', 'false', 'all']).optional(),
    limit: z.number().int().min(1).max(200).optional(),
  }),
  surfaces: ['mcp', 'ai'],
  domain: 'workItems',
  mutating: false,
  async execute(client, input) {
    const result = await client.request({
      method: 'GET',
      path: `/api/workspaces/${input.workspaceId}/work-items`,
      query: {
        status: input.status,
        assignee: input.assignee,
        requester: input.requester,
        parentId: input.parentId,
        open: input.open,
        limit: input.limit,
      },
      responseSchema: workItemListResponseSchema,
    });
    if (result.workItems.length === 0) {
      return {
        text: 'Keine Aufträge mit diesem Filter. exo_work_item_create legt einen an.',
        data: result,
      };
    }
    const more = result.truncated
      ? '\n(Gekürzt: die Liste hat mehr Einträge, Filter enger fassen.)'
      : '';
    return {
      text: `${result.workItems.length} Auftrag/Aufträge:\n${result.workItems.map(formatSummary).join('\n')}${more}`,
      data: result,
    };
  },
});

export const workItemGetTool: AnyToolDefinition = defineTool({
  name: 'exo_work_item_get',
  description:
    'Liest einen Auftrag vollständig: Ziel, Akzeptanzkriterien, Kontext- und Ergebnisseiten, ' +
    'Teilaufträge, die verknüpften KI-Läufe mit ihrem Stand, Budget und die Historie.',
  inputSchema: z.object({ workItemId: idSchema }),
  surfaces: ['mcp', 'ai'],
  domain: 'workItems',
  mutating: false,
  async execute(client, input) {
    const result = await client.request({
      method: 'GET',
      path: `/api/work-items/${input.workItemId}`,
      responseSchema: workItemResponseSchema,
    });
    return { text: formatDetail(result.workItem), data: result };
  },
});

export const workItemCreateTool: AnyToolDefinition = defineTool({
  name: 'exo_work_item_create',
  description:
    'Legt einen Auftrag an: delegierte Arbeit mit Titel, Ziel und optional Akzeptanzkriterien ' +
    '([{"text":…,"met":false}]), Kontextseiten (contextDocumentIds), Priorität (low, normal, high, ' +
    'urgent), Fälligkeit (dueAt, ISO), Budget in Mikro-USD und übergeordnetem Auftrag (parentId). ' +
    `Du selbst wirst als Auftraggeber eingetragen. ${ASSIGNEE_HELP}`,
  inputSchema: z.object({ workspaceId: idSchema }).extend(createWorkItemRequestSchema.shape),
  surfaces: ['mcp', 'ai'],
  domain: 'workItems',
  mutating: true,
  target: (input) => `workspace:${input.workspaceId}:work-items`,
  async execute(client, input) {
    const { workspaceId, ...body } = input;
    const result = await client.request({
      method: 'POST',
      path: `/api/workspaces/${workspaceId}/work-items`,
      body,
      responseSchema: workItemResponseSchema,
    });
    return {
      text: `Auftrag angelegt: ${result.workItem.title} (id: ${result.workItem.id}).`,
      data: result,
    };
  },
});

export const workItemUpdateTool: AnyToolDefinition = defineTool({
  name: 'exo_work_item_update',
  description:
    'Ändert einen Auftrag. Nur die genannten Felder ändern sich, null leert ein Feld. So trägst du ' +
    'Fortschritt ein: status (mit statusReason, wenn er blockiert ist oder wartet), result (das ' +
    'Ergebnis in Worten), resultDocumentIds (erzeugte Seiten, ersetzt die Liste), ' +
    'acceptanceCriteria (die ganze Liste, erfüllte mit met: true). Außerdem title, goal, priority, ' +
    `assignee, contextDocumentIds, budgetMicroUsd, dueAt, parentId. ${STATUS_HELP} ${ASSIGNEE_HELP}`,
  inputSchema: z.object({ workItemId: idSchema }).extend(updateWorkItemRequestSchema.shape),
  surfaces: ['mcp', 'ai'],
  domain: 'workItems',
  mutating: true,
  target: (input) => `work-item:${input.workItemId}`,
  async execute(client, input) {
    const { workItemId, ...changes } = input;
    const result = await client.request({
      method: 'PATCH',
      path: `/api/work-items/${workItemId}`,
      body: changes,
      responseSchema: workItemResponseSchema,
    });
    return {
      text: `Auftrag aktualisiert: ${formatSummary(result.workItem).slice(2)}`,
      data: result,
    };
  },
});

export const workItemNoteTool: AnyToolDefinition = defineTool({
  name: 'exo_work_item_note',
  description:
    'Hängt eine Notiz an die Historie eines Auftrags: ein Zwischenstand, eine Rückfrage, ein ' +
    'Hinweis für den nächsten Versuch. Notizen werden nie bearbeitet oder gelöscht.',
  inputSchema: z.object({ workItemId: idSchema }).extend(addWorkItemNoteRequestSchema.shape),
  surfaces: ['mcp', 'ai'],
  domain: 'workItems',
  mutating: true,
  target: (input) => `work-item:${input.workItemId}`,
  async execute(client, input) {
    const result = await client.request({
      method: 'POST',
      path: `/api/work-items/${input.workItemId}/notes`,
      body: { note: input.note },
      responseSchema: workItemResponseSchema,
    });
    return { text: `Notiz an „${result.workItem.title}“ gehängt.`, data: result };
  },
});

export const workItemStartRunTool: AnyToolDefinition = defineTool({
  name: 'exo_work_item_start_run',
  description:
    'Lässt die eingebaute KI einen Versuch an einem Auftrag machen: ein neuer KI-Lauf in einer ' +
    'eigenen Unterhaltung, deren erste Nachricht aus dem Auftrag geschrieben wird. Ein Auftrag ohne ' +
    'Bearbeiter geht dabei an die eingebaute KI, ein angelegter wechselt auf working. Abgelehnt, ' +
    'wenn der Auftrag abgeschlossen oder sein Budget verbraucht ist. Gibt es einen festgehaltenen ' +
    'Arbeitsstand, setzt der Lauf dort an (fromCheckpoint: "latest" ist Standard, "none" beginnt ' +
    'beim Ziel, eine Checkpoint-id nimmt einen älteren); modelSlug wählt ein anderes Modell. Den ' +
    'Stand des Laufs liest exo_ai_run_get mit der zurückgegebenen id.',
  inputSchema: z.object({ workItemId: idSchema }).extend(startWorkItemRunRequestSchema.shape),
  surfaces: ['mcp', 'ai'],
  domain: 'workItems',
  mutating: true,
  target: (input) => `work-item:${input.workItemId}`,
  async execute(client, input) {
    const { workItemId, ...body } = input;
    const result = await client.request({
      method: 'POST',
      path: `/api/work-items/${workItemId}/runs`,
      body,
      responseSchema: startWorkItemRunResponseSchema,
    });
    const from = result.checkpointId === null ? '' : ` am Arbeitsstand ${result.checkpointId}`;
    return {
      text:
        `Lauf ${result.run.id} gestartet${from} (Unterhaltung ${result.conversationId}). ` +
        'exo_ai_run_get zeigt, wie weit er ist.',
      data: result,
    };
  },
});

export const workItemDeleteTool: AnyToolDefinition = defineTool({
  name: 'exo_work_item_delete',
  description:
    'Löscht einen Auftrag endgültig, samt Historie. Nur für den Auftraggeber und Admins. ' +
    'Teilaufträge bleiben und stehen danach für sich, verknüpfte Läufe bleiben im Verbrauch. ' +
    'Der gewöhnliche Weg, einen Auftrag zu beenden, ist status cancelled mit exo_work_item_update.',
  inputSchema: z.object({ workItemId: idSchema }),
  surfaces: ['mcp', 'ai'],
  domain: 'workItems',
  mutating: true,
  destructive: true,
  irreversible: true,
  target: (input) => `work-item:${input.workItemId}`,
  async execute(client, input) {
    const result = await client.request({
      method: 'DELETE',
      path: `/api/work-items/${input.workItemId}`,
      responseSchema: deleteWorkItemResponseSchema,
    });
    const detached =
      result.detachedChildren === 0
        ? ''
        : ` ${result.detachedChildren} Teilauftrag/Teilaufträge stehen jetzt für sich.`;
    return { text: `Der Auftrag ist gelöscht.${detached}`, data: result };
  },
});

export const WORK_ITEM_TOOLS: readonly AnyToolDefinition[] = [
  workItemListTool,
  workItemGetTool,
  workItemCreateTool,
  workItemUpdateTool,
  workItemNoteTool,
  workItemStartRunTool,
  workItemDeleteTool,
];
