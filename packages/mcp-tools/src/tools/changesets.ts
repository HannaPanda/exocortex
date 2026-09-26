import { z } from 'zod';

import {
  addChangesetChangeResponseSchema,
  type ChangesetChange,
  changesetDecisionResponseSchema,
  type ChangesetDetail,
  changesetListResponseSchema,
  changesetResponseSchema,
  type ChangesetSummary,
  decideChangesetRequestSchema,
  idSchema,
  listChangesetsQuerySchema,
  proposeChangeSchema,
  submitChangesetRequestSchema,
} from '@exocortex/contracts';

import { type AnyToolDefinition, defineTool } from '../tool.js';

/**
 * Proposed changes (issue #141, ADR-070).
 *
 * What a model has to understand: a proposal changes nothing. It is shown to a
 * person as a diff against the page as it was when proposed, and only what
 * that person applies reaches the page. A page that moves in between makes the
 * change stale; it is never applied to a state nobody reviewed. Deciding is a
 * person's, which is why apply and reject are not on the built-in AI's surface.
 */

const CHANGE_HELP =
  'change ist eine Änderung, eine von: {"kind":"section","documentId","heading","markdown",' +
  '"mode":"replace|append|prepend"} (unter einer Überschrift), {"kind":"block","documentId",' +
  '"blockId","markdown","mode"} (ein Block, Kennungen aus exo_page_read mit includeBlockIds), ' +
  '{"kind":"patch","documentId","oldText","newText"} (genau eine Textstelle), {"kind":"page",' +
  '"documentId","markdown","mode":"replace|append"} (ganze Seite), {"kind":"create","parentId",' +
  '"title","markdown"} (neue Seite). Jede darf message tragen (warum diese Änderung) und ' +
  'expectedYjsUpdatedAt (die gelesene Revision).';

function formatChange(change: ChangesetChange): string {
  const where = change.title ?? change.documentId ?? 'neue Seite';
  const parts = [
    `${change.position + 1}. ${change.kind} auf „${where}“ (changeId: ${change.id})`,
    change.status,
  ];
  if (change.status === 'pending')
    parts.push(change.applicable ? 'passt' : 'Seite hat sich geändert');
  const { added, removed, changed } = change.diff.summary;
  parts.push(`+${added} −${removed} ~${changed} Blöcke`);
  if (change.errorCode !== null) parts.push(`Fehler ${change.errorCode}`);
  if (change.decisionNote !== null) parts.push(`„${change.decisionNote}“`);
  return parts.join(' · ');
}

function formatSummary(changeset: ChangesetSummary): string {
  const { counts } = changeset;
  return (
    `${changeset.title} (id: ${changeset.id}) · ${changeset.status} · ` +
    `${counts.total} Änderungen, ${counts.pending} offen, ${counts.applied} übernommen, ` +
    `${counts.rejected} abgelehnt, ${counts.stale} veraltet`
  );
}

function formatDetail(changeset: ChangesetDetail): string {
  const lines = [formatSummary(changeset)];
  if (changeset.message !== null) lines.push(`Begründung: ${changeset.message}`);
  if (changeset.workItem !== null) {
    lines.push(`Auftrag: ${changeset.workItem.title} (id: ${changeset.workItem.id})`);
  }
  if (changeset.revisesId !== null) lines.push(`Überarbeitet: ${changeset.revisesId}`);
  lines.push('', ...changeset.changes.map(formatChange));
  return lines.join('\n');
}

export const changesetProposeTool: AnyToolDefinition = defineTool({
  name: 'exo_changeset_propose',
  description:
    'Schlägt eine Seitenänderung vor, statt sie zu schreiben. Ohne changesetId legt der Aufruf ' +
    'einen neuen Vorschlag an (workspaceId und title nötig, optional message als Begründung, ' +
    'workItemId für den Auftrag, revisesId für einen früheren Vorschlag, den dieser überarbeitet); ' +
    'mit changesetId kommt die Änderung in den bestehenden Entwurf. Die Änderung wird sofort gegen ' +
    'die Seite geprüft und als Diff gespeichert, die Seite bleibt unverändert. Wenn alles ' +
    `vorgeschlagen ist, reiche den Vorschlag mit exo_changeset_submit ein. ${CHANGE_HELP}`,
  inputSchema: z.object({
    changesetId: idSchema.optional(),
    workspaceId: idSchema.optional(),
    title: z.string().trim().min(1).max(300).optional(),
    message: z.string().trim().min(1).max(4_000).optional(),
    workItemId: idSchema.optional(),
    revisesId: idSchema.optional(),
    change: proposeChangeSchema,
  }),
  surfaces: ['mcp', 'ai'],
  domain: 'changesets',
  mutating: true,
  writeClass: 'proposal',
  target: (input) => `changeset:${input.changesetId ?? input.workspaceId ?? 'new'}`,
  async execute(client, input) {
    if (input.changesetId !== undefined) {
      const result = await client.request({
        method: 'POST',
        path: `/api/changesets/${input.changesetId}/changes`,
        body: input.change,
        responseSchema: addChangesetChangeResponseSchema,
      });
      return {
        text: `Änderung vorgeschlagen (changeId: ${result.changeId}).\n${formatDetail(result.changeset)}`,
        data: result,
      };
    }
    if (input.workspaceId === undefined || input.title === undefined) {
      return {
        text: 'Für einen neuen Vorschlag braucht es workspaceId und title, sonst changesetId.',
        isError: true,
      };
    }
    const result = await client.request({
      method: 'POST',
      path: `/api/workspaces/${input.workspaceId}/changesets`,
      body: {
        title: input.title,
        message: input.message,
        workItemId: input.workItemId,
        revisesId: input.revisesId,
        change: input.change,
      },
      responseSchema: addChangesetChangeResponseSchema,
    });
    return {
      text:
        `Vorschlag angelegt (changesetId: ${result.changeset.id}). Weitere Änderungen mit dieser ` +
        `changesetId, dann exo_changeset_submit.\n${formatDetail(result.changeset)}`,
      data: result,
    };
  },
});

export const changesetSubmitTool: AnyToolDefinition = defineTool({
  name: 'exo_changeset_submit',
  description:
    'Reicht einen Vorschlag ein. Danach ist er eingefroren und wartet auf einen Menschen, der jede ' +
    'Änderung einzeln übernimmt oder ablehnt. An einem Auftrag geht der Auftrag dabei in die ' +
    'Prüfung (review: false bittet nur um Freigabe, ohne den Auftrag anzuhalten); die Entscheidung ' +
    'setzt die Arbeit fort. context erklärt der prüfenden Person, was sie wissen muss.',
  inputSchema: z.object({ changesetId: idSchema }).extend(submitChangesetRequestSchema.shape),
  surfaces: ['mcp', 'ai'],
  domain: 'changesets',
  mutating: true,
  writeClass: 'proposal',
  target: (input) => `changeset:${input.changesetId}`,
  async execute(client, input) {
    const { changesetId, ...body } = input;
    const result = await client.request({
      method: 'POST',
      path: `/api/changesets/${changesetId}/submit`,
      body,
      responseSchema: changesetResponseSchema,
    });
    const waits = result.changeset.workItem?.status === 'review' && input.review !== false;
    return {
      text: waits
        ? `Eingereicht: ${formatSummary(result.changeset)}. Der Auftrag wartet jetzt auf die ` +
          'Prüfung. Beende diesen Lauf ohne weitere Schritte; die Entscheidung setzt die Arbeit fort.'
        : `Eingereicht: ${formatSummary(result.changeset)}. Die Entscheidung liest ` +
          'exo_changeset_get.',
      data: result,
      pausesRun: waits,
    };
  },
});

export const changesetRemoveChangeTool: AnyToolDefinition = defineTool({
  name: 'exo_changeset_remove_change',
  description: 'Nimmt eine Änderung wieder aus einem Entwurf, der noch nicht eingereicht ist.',
  inputSchema: z.object({ changesetId: idSchema, changeId: idSchema }),
  surfaces: ['mcp', 'ai'],
  domain: 'changesets',
  mutating: true,
  writeClass: 'proposal',
  target: (input) => `changeset:${input.changesetId}`,
  async execute(client, input) {
    const result = await client.request({
      method: 'DELETE',
      path: `/api/changesets/${input.changesetId}/changes/${input.changeId}`,
      responseSchema: changesetResponseSchema,
    });
    return { text: `Änderung entfernt.\n${formatDetail(result.changeset)}`, data: result };
  },
});

export const changesetDiscardTool: AnyToolDefinition = defineTool({
  name: 'exo_changeset_discard',
  description:
    'Verwirft einen eigenen Entwurf ganz. Nur vor dem Einreichen; ein eingereichter Vorschlag ' +
    'bleibt als Aufzeichnung erhalten.',
  inputSchema: z.object({ changesetId: idSchema }),
  surfaces: ['mcp', 'ai'],
  domain: 'changesets',
  mutating: true,
  writeClass: 'proposal',
  destructive: true,
  irreversible: true,
  target: (input) => `changeset:${input.changesetId}`,
  async execute(client, input) {
    await client.request({
      method: 'DELETE',
      path: `/api/changesets/${input.changesetId}`,
      responseSchema: z.object({ deleted: z.literal(true) }),
    });
    return { text: `Entwurf ${input.changesetId} verworfen.` };
  },
});

export const changesetGetTool: AnyToolDefinition = defineTool({
  name: 'exo_changeset_get',
  description:
    'Liest einen Vorschlag mit allen Änderungen: Status je Änderung (pending, applied, rejected, ' +
    'stale), ob sie noch zur Seite passt, den Diff, wer entschieden hat und warum.',
  inputSchema: z.object({ changesetId: idSchema }),
  surfaces: ['mcp', 'ai'],
  domain: 'changesets',
  mutating: false,
  async execute(client, input) {
    const result = await client.request({
      method: 'GET',
      path: `/api/changesets/${input.changesetId}`,
      responseSchema: changesetResponseSchema,
    });
    return { text: formatDetail(result.changeset), data: result };
  },
});

export const changesetListTool: AnyToolDefinition = defineTool({
  name: 'exo_changeset_list',
  description:
    'Listet Vorschläge eines Arbeitsbereichs. state: open (Entwürfe und alles mit offenen ' +
    'Änderungen, Standard), closed, all. workItemId filtert auf einen Auftrag, proposedBy: "me" auf ' +
    'die eigenen.',
  inputSchema: z.object({ workspaceId: idSchema }).extend(listChangesetsQuerySchema.shape),
  surfaces: ['mcp', 'ai'],
  domain: 'changesets',
  mutating: false,
  async execute(client, input) {
    const { workspaceId, ...query } = input;
    const result = await client.request({
      method: 'GET',
      path: `/api/workspaces/${workspaceId}/changesets`,
      query,
      responseSchema: changesetListResponseSchema,
    });
    const lines = result.changesets.map((changeset) => `- ${formatSummary(changeset)}`);
    return {
      text: lines.length === 0 ? 'Keine Vorschläge.' : lines.join('\n'),
      data: result,
    };
  },
});

function decisionTool(verb: 'apply' | 'reject'): AnyToolDefinition {
  return defineTool({
    name: verb === 'apply' ? 'exo_changeset_apply' : 'exo_changeset_reject',
    description:
      verb === 'apply'
        ? 'Übernimmt Änderungen eines eingereichten Vorschlags in die Seiten, als die Person hinter ' +
          'diesem Zugang. Ohne changeIds alle offenen. Jede wird mit der Revision geschrieben, auf ' +
          'der sie vorgeschlagen wurde; hat sich eine Seite seither geändert, wird die Änderung ' +
          'nicht geschrieben, sondern als veraltet markiert. Vor jeder Übernahme entsteht ein ' +
          'Snapshot. Nur auf ausdrücklichen Wunsch eines Menschen aufrufen.'
        : 'Lehnt Änderungen eines eingereichten Vorschlags ab, ohne changeIds alle offenen; note ' +
          'sagt warum und geht an den Vorschlagenden zurück.',
    inputSchema: z.object({ changesetId: idSchema }).extend(decideChangesetRequestSchema.shape),
    // Deciding is a person's (ADR-070). The built-in AI never decides on a
    // proposal, its own included; an external client holds a person's token.
    surfaces: ['mcp'],
    domain: 'changesets',
    mutating: true,
    destructive: verb === 'apply',
    target: (input) => `changeset:${input.changesetId}`,
    async execute(client, input) {
      const { changesetId, ...body } = input;
      const result = await client.request({
        method: 'POST',
        path:
          verb === 'apply'
            ? `/api/changesets/${changesetId}/apply`
            : `/api/changesets/${changesetId}/reject`,
        body,
        responseSchema: changesetDecisionResponseSchema,
      });
      const outcomes = result.outcomes.map(
        (outcome) =>
          `- ${outcome.changeId}: ${outcome.outcome}` +
          (outcome.errorCode === null ? '' : ` (${outcome.errorCode})`),
      );
      return {
        text: `${formatDetail(result.changeset)}\n\nErgebnis:\n${outcomes.join('\n')}`,
        data: result,
      };
    },
  });
}

export const CHANGESET_TOOLS: readonly AnyToolDefinition[] = [
  changesetProposeTool,
  changesetSubmitTool,
  changesetRemoveChangeTool,
  changesetDiscardTool,
  changesetGetTool,
  changesetListTool,
  decisionTool('apply'),
  decisionTool('reject'),
];
