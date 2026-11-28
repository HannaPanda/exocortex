import { z } from 'zod';

import {
  idSchema,
  type PageHistoryAuthor,
  type PageHistoryGroup,
  pageHistoryResponseSchema,
  type PageHistoryVersion,
  snapshotContentResponseSchema,
} from '@exocortex/contracts';

import { groupDigits } from '../format.js';
import { type AnyToolDefinition, defineTool } from '../tool.js';

/**
 * The page history of issue #235, for agents: the versions of a page with who
 * caused them, grouped the way the browser's "Seitenverlauf" shows them, and
 * one version read back as Markdown. Comparing and restoring are the existing
 * tools (`exo_page_snapshot_diff`, `exo_page_restore_snapshot`,
 * `exo_page_restore_blocks`), which this text names so the loop is closed.
 */

const MAX_VERSION_READ_CHARS = 60_000;

/** Who, in one phrase. */
export function describeAuthor(author: PageHistoryAuthor): string {
  const name = author.kind === 'unknown' ? null : (author.name ?? 'ein gelöschtes Konto');
  switch (author.kind) {
    case 'person':
      return name ?? 'unbekannt';
    case 'agent':
      return `Agent ${author.clientLabel ?? 'ohne Namen'} (für ${name ?? 'unbekannt'}, Sitzung ${author.agentSessionId})`;
    case 'aiRun':
      return `KI-Lauf ${author.runId} (für ${name ?? 'unbekannt'})`;
    case 'unknown':
      return 'unbekannt';
  }
}

/** What a version is, read from its reason: the one thing easy to get backwards. */
function describeReason(reason: PageHistoryVersion['reason']): string {
  switch (reason) {
    case 'scheduled':
      return 'Stand beim Tippen';
    case 'api_write':
      return 'Stand vor einem Schreibvorgang';
    case 'pre_restore':
      return 'Stand vor einer Wiederherstellung';
    case 'restore':
      return 'Wiederherstellung';
    case 'manual':
      return 'von Hand gesichert';
    case 'import':
      return 'Import';
  }
}

const GROUP_LABEL: Record<PageHistoryGroup['kind'], string> = {
  edit: 'Bearbeitung im Editor',
  write: 'Schreibserie von außen',
  restore: 'Wiederherstellung',
  manual: 'Gesicherte Version',
  import: 'Import',
};

function formatGroup(group: PageHistoryGroup, index: number): string {
  const span =
    group.startedAt === group.endedAt ? group.endedAt : `${group.startedAt} bis ${group.endedAt}`;
  const head = `${index + 1}. ${span} · ${GROUP_LABEL[group.kind]} · ${describeAuthor(group.author)}`;
  if (group.versions.length === 1) {
    const only = group.versions[0] as PageHistoryVersion;
    return `${head}\n   ${only.id} (${describeReason(only.reason)})`;
  }
  const members = group.versions
    .map(
      (version) =>
        `   ${version.id === group.representativeId ? '*' : '-'} ${version.id} ${version.createdAt} (${describeReason(version.reason)})`,
    )
    .join('\n');
  return `${head} · ${group.versions.length} Stände, * steht für die Gruppe\n${members}`;
}

export const pageHistoryTool: AnyToolDefinition = defineTool({
  name: 'exo_page_history',
  description:
    'Liest den Seitenverlauf: alle gespeicherten Stände einer Seite mit Zeit und Urheber (Person, ' +
    'Agent mit Sitzung oder KI-Lauf), zu Einträgen gebündelt wie im Browser (eine Tipp-Sitzung, ' +
    'eine Schreibserie). Wichtig für die Richtung: ein "Stand vor einem Schreibvorgang" ist die ' +
    'Seite, bevor der genannte Urheber geschrieben hat; ein "Stand beim Tippen" ist die Seite, wie ' +
    'der Urheber sie hinterlassen hat. Eine Schreibserie steht für ihren ältesten Stand, also die ' +
    'Seite vor der Serie. Lesen mit exo_page_snapshot_read, vergleichen mit ' +
    'exo_page_snapshot_diff, zurücksetzen mit exo_page_restore_snapshot.',
  inputSchema: z.object({
    documentId: idSchema,
    before: z
      .string()
      .datetime({ offset: true })
      .optional()
      .describe('Nur ältere Stände als dieser Zeitpunkt: das nextBefore der vorigen Antwort.'),
    limit: z.number().int().min(1).max(1000).optional(),
  }),
  surfaces: ['mcp', 'ai'],
  domain: 'history',
  mutating: false,
  async execute(client, input) {
    const result = await client.request({
      method: 'GET',
      path: `/api/documents/${input.documentId}/history`,
      query: {
        ...(input.before === undefined ? {} : { before: input.before }),
        ...(input.limit === undefined ? {} : { limit: String(input.limit) }),
      },
      responseSchema: pageHistoryResponseSchema,
    });
    const head = `Aktueller Stand: zuletzt geändert ${result.currentUpdatedAt}.`;
    if (result.groups.length === 0) {
      return { text: `${head}\nKeine gespeicherten Stände.`, data: result };
    }
    const more =
      result.nextBefore === null
        ? ''
        : `\n\nÄltere Stände: noch einmal mit before = ${result.nextBefore}.`;
    return {
      text:
        `${head} ${result.versionCount} gespeicherte Stände in ${result.groups.length} Einträgen, ` +
        `neueste zuerst:\n\n${result.groups.map(formatGroup).join('\n')}${more}`,
      data: result,
    };
  },
});

export const pageSnapshotReadTool: AnyToolDefinition = defineTool({
  name: 'exo_page_snapshot_read',
  description:
    'Liest einen gespeicherten Stand einer Seite als Markdown, so wie die Seite damals aussah. ' +
    'Die Kennung kommt aus exo_page_history oder exo_page_snapshots. Nur lesen: die Seite ändert ' +
    'sich dadurch nicht. Ist der Stand größer als maxChars, kommt seine Gliederung statt Text.',
  inputSchema: z.object({
    documentId: idSchema,
    snapshotId: idSchema,
    maxChars: z.number().int().min(1000).max(400_000).optional(),
  }),
  surfaces: ['mcp', 'ai'],
  domain: 'history',
  mutating: false,
  async execute(client, input) {
    const result = await client.request({
      method: 'GET',
      path: `/api/documents/${input.documentId}/snapshots/${input.snapshotId}`,
      query: { maxChars: String(input.maxChars ?? MAX_VERSION_READ_CHARS) },
      responseSchema: snapshotContentResponseSchema,
    });
    const { version } = result;
    const head =
      `Stand ${version.id} vom ${version.createdAt}: ${describeReason(version.reason)}, ` +
      `${describeAuthor(version.author)}.`;
    const notices = result.notices.map((notice) =>
      notice.code === 'older_schema'
        ? 'Dieser Stand wurde mit einer älteren Schemaversion gespeichert; er ist in die heutige Form gebracht.'
        : 'Gekürzt.',
    );
    if (result.view === 'map' && result.map !== null) {
      // The map's addresses would point a reader at exo_page_block_read, which
      // reads the page as it is now and not this version, so only the shape.
      const outline = result.map.entries
        .map((entry) => `- ${entry.title} (${groupDigits(entry.chars)} Zeichen)`)
        .join('\n');
      return {
        text:
          `${head}\nDieser Stand hat ${groupDigits(result.chars)} Zeichen, mehr als maxChars. ` +
          'Kein Textauszug, sondern seine Gliederung. Was sich seitdem geändert hat, zeigt ' +
          'exo_page_snapshot_diff; den ganzen Text liefert ein höheres maxChars.' +
          `\n\n${outline}`,
        data: result,
      };
    }
    return {
      text: [head, ...notices, '', '---', '', result.markdown].join('\n'),
      data: result,
    };
  },
});

export const PAGE_HISTORY_TOOLS: readonly AnyToolDefinition[] = [
  pageHistoryTool,
  pageSnapshotReadTool,
];
