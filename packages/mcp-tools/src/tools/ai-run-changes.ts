import { z } from 'zod';

import {
  type AiRunChangedPage,
  type AiRunChangesResponse,
  aiRunChangesResponseSchema,
  idSchema,
} from '@exocortex/contracts';

import { type AnyToolDefinition, defineTool } from '../tool.js';

const STATE_LABEL: Record<AiRunChangedPage['blocks'][number]['state'], string> = {
  revertible: 'steht noch so, wie der Lauf es hinterlassen hat',
  changed_since:
    'seit dem Lauf von jemand anderem geändert, wird beim Zurücknehmen nicht angefasst',
  reverted: 'steht schon wieder wie vor dem Lauf',
};

const CHANGE_LABEL: Record<AiRunChangedPage['blocks'][number]['change'], string> = {
  added: 'neu',
  changed: 'geändert',
  removed: 'entfernt',
};

const SKIP_LABEL: Record<NonNullable<AiRunChangedPage['skipped']>, string> = {
  no_snapshot: 'kein Stand vor dem Lauf vorhanden (etwa nur umbenannt oder verschoben)',
  not_recorded: 'Blöcke dieses Schreibvorgangs wurden nicht aufgezeichnet',
  unavailable: 'Seite nicht mehr vorhanden oder nicht lesbar',
};

function renderPage(page: AiRunChangedPage): string {
  const title = page.title ?? page.documentId;
  if (page.skipped !== null) return `„${title}“ (${page.documentId}): ${SKIP_LABEL[page.skipped]}`;
  const groups = new Map<number, AiRunChangedPage['blocks']>();
  for (const block of page.blocks)
    groups.set(block.group, [...(groups.get(block.group) ?? []), block]);
  const lines = [...groups.values()].map((blocks) => {
    const state = blocks[0]?.state ?? 'changed_since';
    const parts = blocks.map(
      (block) =>
        `${CHANGE_LABEL[block.change]} ^${block.blockId}` +
        (block.excerpt === null ? '' : ` „${block.excerpt}“`),
    );
    return `- ${parts.join('; ')}: ${STATE_LABEL[state]}`;
  });
  return [
    `„${title}“ (${page.documentId}), Stand vor dem Lauf: Snapshot ${page.snapshotId ?? 'keiner'}`,
    ...lines,
  ].join('\n');
}

function renderChanges(changes: AiRunChangesResponse): string {
  if (changes.pages.length === 0) return `Lauf ${changes.runId} hat keine Seite geändert.`;
  return [
    `Lauf ${changes.runId}: ${String(changes.revertible)} Änderung(en) stehen noch so, wie der Lauf sie ` +
      `hinterlassen hat, ${String(changes.changedSince)} wurde(n) seitdem von jemand anderem geändert.`,
    ...changes.pages.map(renderPage),
    'Zurücknehmen kann den ganzen Lauf nur die Person, für die er lief, im Chat. Einzelne Blöcke ' +
      'holt exo_page_restore_blocks mit dem Snapshot und den Blockkennungen zurück.',
  ].join('\n\n');
}

/**
 * What one AI run changed, block by block (issue #248). Reading is a tool on
 * both surfaces; taking the run back in one go is not, for the reason ADR-022
 * gives for a whole agent session: whether a run was a mistake is the
 * judgement of the person it ran for. The answer names the snapshot and the
 * block ids, so an agent asked to undo one specific change can still do that
 * with `exo_page_restore_blocks`, one page and one decision at a time.
 */
export const aiRunChangesTool: AnyToolDefinition = defineTool({
  name: 'exo_ai_run_changes',
  description:
    'Zeigt, welche Seiten und Blöcke ein Lauf der eingebauten KI geändert hat und wie jede Änderung ' +
    'jetzt steht: noch so, wie der Lauf sie hinterlassen hat, seitdem von jemand anderem geändert, ' +
    'oder schon wieder wie vorher. Nennt je Seite den Snapshot vor dem Lauf und die Blockkennungen ' +
    '(für exo_page_restore_blocks). Ändert nichts.',
  inputSchema: z.object({ runId: idSchema }),
  surfaces: ['mcp', 'ai'],
  domain: 'chats',
  mutating: false,
  async execute(client, input) {
    const changes = await client.request({
      method: 'GET',
      path: `/api/ai/runs/${input.runId}/changes`,
      responseSchema: aiRunChangesResponseSchema,
    });
    return { text: renderChanges(changes), data: changes };
  },
});
