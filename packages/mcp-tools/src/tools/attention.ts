import { z } from 'zod';

import {
  type AttentionItem,
  attentionItemResponseSchema,
  attentionKindSchema,
  attentionListResponseSchema,
  idSchema,
  requestAttentionSchema,
  resolveAttentionSchema,
  withdrawAttentionSchema,
} from '@exocortex/contracts';

import { type AnyToolDefinition, defineTool } from '../tool.js';

/**
 * What needs a person (issue #139, ADR-067).
 *
 * The two things a model has to understand: an attention item is a need for
 * a person's action, never a report, so asking one is for a real question and
 * not for "I am done"; and the answer arrives later, on the item and in the
 * work item's history, so an agent asks and then reads back rather than
 * waiting in a loop.
 */

const KIND_HELP =
  'Arten: decision (zwischen Optionen wählen), approval (Ja oder Nein zu etwas, das du tun ' +
  'willst), budget (mehr Geld als das Budget des Auftrags), information (eine Auskunft, die nur ' +
  'ein Mensch hat; ohne Optionen, die Antwort ist Text), conflict (Änderungen von Mensch und ' +
  'Agent widersprechen sich). review, blocked und run_failed entstehen nur aus dem Status eines ' +
  'Auftrags und lassen sich nicht direkt anlegen.';

const OPTION_HELP: Record<string, string> = {
  accept: 'abnehmen (Auftrag wird done)',
  return: 'zurückgeben (Auftrag wird working, Notiz wird der Grund)',
  answer: 'antworten (Notiz ist Pflicht, Auftrag geht zurück in die Warteschlange)',
  unblock: 'Hindernis ist weg (Auftrag geht zurück in die Warteschlange)',
  retry: 'neuen Lauf starten',
  give_up: 'aufgeben (Auftrag wird failed, Notiz wird der Grund)',
};

function formatItem(item: AttentionItem): string {
  const parts = [`- ${item.title} (id: ${item.id})`, item.kind, item.status];
  if (item.urgency !== 'normal') parts.push(`Dringlichkeit ${item.urgency}`);
  parts.push(`Arbeitsbereich ${item.workspaceName}`);
  if (item.workItem !== null) {
    parts.push(`Auftrag „${item.workItem.title}“ (${item.workItem.id}, ${item.workItem.status})`);
  }
  if (item.run !== null) parts.push(`Lauf ${item.run.id}`);
  const lines = [parts.join(' · ')];
  if (item.reason !== null) lines.push(`  Grund: ${item.reason}`);
  if (item.status === 'open' && item.options.length > 0) {
    const options = item.options.map((option) =>
      option.label === null
        ? `${option.id} = ${OPTION_HELP[option.id] ?? option.id}`
        : `${option.id} = ${option.label}`,
    );
    lines.push(`  Optionen: ${options.join('; ')}`);
  }
  if (item.status === 'open' && item.noteMode === 'required') {
    lines.push('  Antwort in Worten nötig (note).');
  }
  if (item.resolution !== null) {
    const answer = [
      item.resolution.optionId === undefined ? null : `gewählt: ${item.resolution.optionId}`,
      item.resolution.note === undefined ? null : `„${item.resolution.note}“`,
      item.resolution.reason === undefined ? null : `Grund: ${item.resolution.reason}`,
    ].filter((entry) => entry !== null);
    if (answer.length > 0) lines.push(`  Erledigt: ${answer.join(', ')}`);
  }
  return lines.join('\n');
}

export const attentionListTool: AnyToolDefinition = defineTool({
  name: 'exo_attention_list',
  description:
    'Listet, was auf einen Menschen wartet: offene Entscheidungen, Freigaben, Ergebnisse zur ' +
    'Prüfung, blockierte Aufträge, fehlgeschlagene Läufe, Rückfragen. Über alle Arbeitsbereiche. ' +
    'scope "for_me" (Standard) ist dein Eingang, "raised_by_me" das, was du gefragt hast (so ' +
    'findest du Antworten), "all" alles, was du lesen darfst. status "open" (Standard), ' +
    '"settled" oder "all".',
  inputSchema: z.object({
    scope: z.enum(['for_me', 'raised_by_me', 'all']).optional(),
    status: z.enum(['open', 'settled', 'all']).optional(),
    workspaceId: idSchema.optional(),
    workItemId: idSchema.optional(),
    kind: attentionKindSchema.optional(),
    limit: z.number().int().min(1).max(200).optional(),
  }),
  surfaces: ['mcp', 'ai'],
  domain: 'attention',
  mutating: false,
  async execute(client, input) {
    const result = await client.request({
      method: 'GET',
      path: '/api/attention',
      query: {
        scope: input.scope,
        status: input.status,
        workspaceId: input.workspaceId,
        workItemId: input.workItemId,
        kind: input.kind,
        limit: input.limit,
      },
      responseSchema: attentionListResponseSchema,
    });
    if (result.attentionItems.length === 0) {
      return { text: 'Nichts wartet mit diesem Filter.', data: result };
    }
    const more = result.truncated ? '\n(Gekürzt: Filter enger fassen.)' : '';
    return {
      text: `${result.attentionItems.length} Eintrag/Einträge:\n${result.attentionItems.map(formatItem).join('\n')}${more}`,
      data: result,
    };
  },
});

export const attentionGetTool: AnyToolDefinition = defineTool({
  name: 'exo_attention_get',
  description:
    'Liest einen Eintrag, der auf einen Menschen wartet: Art, Grund, Optionen, und wenn er ' +
    'erledigt ist, wer ihn wie erledigt hat (gewählte Option, Antworttext).',
  inputSchema: z.object({ attentionItemId: idSchema }),
  surfaces: ['mcp', 'ai'],
  domain: 'attention',
  mutating: false,
  async execute(client, input) {
    const result = await client.request({
      method: 'GET',
      path: `/api/attention/${input.attentionItemId}`,
      responseSchema: attentionItemResponseSchema,
    });
    return { text: formatItem(result.attentionItem).slice(2), data: result };
  },
});

export const attentionRequestTool: AnyToolDefinition = defineTool({
  name: 'exo_attention_request',
  description:
    'Fragt einen Menschen etwas, das du nicht selbst entscheiden kannst oder darfst. Nur für echte ' +
    'Rückfragen, nie als Fertigmeldung (dafür status review mit exo_work_item_update). Mit ' +
    'options ([{"id":"global","label":"Global"}, …], höchstens sechs) wird eine Wahl daraus, ohne ' +
    'options eine Antwort in Worten. Mit workItemId wartet der Auftrag dann auf die Antwort ' +
    '(waiting_for_human) und geht danach in die Warteschlange zurück; die Antwort steht in seiner ' +
    'Historie. key macht die Anfrage wiederholbar: derselbe key liefert die offene Anfrage statt ' +
    `einer zweiten. Die Antwort liest exo_attention_get. ${KIND_HELP}`,
  inputSchema: z.object({ workspaceId: idSchema }).extend(requestAttentionSchema.shape),
  surfaces: ['mcp', 'ai'],
  domain: 'attention',
  mutating: true,
  target: (input) => `workspace:${input.workspaceId}:attention`,
  async execute(client, input) {
    const { workspaceId, ...body } = input;
    const result = await client.request({
      method: 'POST',
      path: `/api/workspaces/${workspaceId}/attention`,
      body,
      responseSchema: attentionItemResponseSchema,
    });
    return {
      text:
        `Gefragt: ${result.attentionItem.title} (id: ${result.attentionItem.id}). ` +
        'Die Antwort kommt später; exo_attention_get liest sie.',
      data: result,
    };
  },
});

export const attentionResolveTool: AnyToolDefinition = defineTool({
  name: 'exo_attention_resolve',
  description:
    'Erledigt einen wartenden Eintrag im Namen eines Menschen: optionId wählt eine der ' +
    'angebotenen Optionen, note ist die Antwort in Worten. Nur, wenn der Mensch dir die ' +
    'Entscheidung ausdrücklich gesagt hat; beantworte nie eine Frage, die du selbst gestellt hast. ' +
    'Bei Einträgen aus einem Auftrag ändert die Option den Auftrag: ' +
    Object.entries(OPTION_HELP)
      .map(([id, text]) => `${id} = ${text}`)
      .join(', ') +
    '.',
  inputSchema: z.object({ attentionItemId: idSchema }).extend(resolveAttentionSchema.shape),
  surfaces: ['mcp', 'ai'],
  domain: 'attention',
  mutating: true,
  target: (input) => `attention:${input.attentionItemId}`,
  async execute(client, input) {
    const { attentionItemId, ...body } = input;
    const result = await client.request({
      method: 'POST',
      path: `/api/attention/${attentionItemId}/resolve`,
      body,
      responseSchema: attentionItemResponseSchema,
    });
    return { text: `Erledigt: ${formatItem(result.attentionItem).slice(2)}`, data: result };
  },
});

export const attentionWithdrawTool: AnyToolDefinition = defineTool({
  name: 'exo_attention_withdraw',
  description:
    'Zieht eine eigene Anfrage zurück, weil sie sich erledigt hat: sie wird hinfällig, nicht ' +
    'beantwortet. Nur für den Fragenden und Admins; Einträge aus dem Status eines Auftrags enden, ' +
    'wenn der Auftrag den Status verlässt.',
  inputSchema: z.object({ attentionItemId: idSchema }).extend(withdrawAttentionSchema.shape),
  surfaces: ['mcp', 'ai'],
  domain: 'attention',
  mutating: true,
  target: (input) => `attention:${input.attentionItemId}`,
  async execute(client, input) {
    const { attentionItemId, ...body } = input;
    const result = await client.request({
      method: 'POST',
      path: `/api/attention/${attentionItemId}/withdraw`,
      body,
      responseSchema: attentionItemResponseSchema,
    });
    return { text: `Zurückgezogen: ${result.attentionItem.title}.`, data: result };
  },
});

export const ATTENTION_TOOLS: readonly AnyToolDefinition[] = [
  attentionListTool,
  attentionGetTool,
  attentionRequestTool,
  attentionResolveTool,
  attentionWithdrawTool,
];
