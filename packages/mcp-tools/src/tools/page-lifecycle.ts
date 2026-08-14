import { z } from 'zod';

import {
  archiveDocumentResponseSchema,
  deleteDocumentsResponseSchema,
  documentActivityResponseSchema,
  documentDeletionPreviewSchema,
  documentSnapshotListResponseSchema,
  documentSummarySchema,
  idSchema,
  type TrashEntry,
  trashResponseSchema,
} from '@exocortex/contracts';

import { restoreSnapshotResultSchema } from '../local-schemas.js';
import { type AnyToolDefinition, defineTool } from '../tool.js';

import { formatDocumentSummary } from './page-render.js';

/**
 * What happens to a page after it exists: archiving, the trash, deletion, and
 * the history a write leaves behind.
 *
 * These share one property that sets them apart from the rest of the catalogue:
 * every one of them is about a page's lifetime rather than its content, and
 * four of them cannot be undone.
 */

export const pageArchiveTool: AnyToolDefinition = defineTool({
  name: 'exo_page_archive',
  description:
    'Verschiebt eine Seite in den Papierkorb (archivieren). Achtung: alle Unterseiten wandern ' +
    'mit. Wer nur die Seite selbst wegräumen will, verschiebt die Unterseiten vorher mit ' +
    'exo_page_move woanders hin.',
  inputSchema: z.object({ documentId: idSchema }),
  surfaces: ['mcp', 'ai'],
  mutating: true,
  destructive: true,
  target: (input) => `document:${input.documentId}`,
  async execute(client, input) {
    const result = await client.request({
      method: 'POST',
      path: `/api/documents/${input.documentId}/archive`,
      responseSchema: archiveDocumentResponseSchema,
    });
    const cascade =
      result.archivedDescendants.length === 0
        ? []
        : [
            `Mit archiviert wurden ${result.archivedDescendants.length} Unterseite(n):`,
            ...result.archivedDescendants.map((child) => `- ${formatDocumentSummary(child)}`),
            'Falls das nicht gewollt war: exo_page_restore holt jede einzeln zurück.',
          ];
    return {
      text: [`Seite archiviert: ${formatDocumentSummary(result)}`, ...cascade].join('\n'),
      data: result,
    };
  },
});

export const pageRestoreTool: AnyToolDefinition = defineTool({
  name: 'exo_page_restore',
  description: 'Stellt eine archivierte Seite aus dem Papierkorb wieder her.',
  inputSchema: z.object({ documentId: idSchema }),
  surfaces: ['mcp', 'ai'],
  mutating: true,
  target: (input) => `document:${input.documentId}`,
  async execute(client, input) {
    const result = await client.request({
      method: 'POST',
      path: `/api/documents/${input.documentId}/restore`,
      responseSchema: documentSummarySchema,
    });
    return { text: `Seite wiederhergestellt: ${formatDocumentSummary(result)}`, data: result };
  },
});

/** Enough to read a trash of a few hundred pages, short of pasting a workspace. */
const MAX_TRASH_LINES = 200;

/** `2026-08-11T19:22:36.000Z` → `2026-08-11 19:22`. Unambiguous, and short. */
function formatArchivedAt(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

function renderTrashEntries(
  entries: readonly TrashEntry[],
  depth: number,
  budget: { left: number },
): string[] {
  const lines: string[] = [];
  for (const entry of entries) {
    if (budget.left <= 0) break;
    budget.left -= 1;
    const cascade = entry.reason === 'cascade' ? ', mit archiviert' : '';
    const below =
      entry.descendantCount === 0
        ? ''
        : `, ${entry.descendantCount} archivierte Seite(n) darunter`;
    lines.push(
      `${'  '.repeat(depth)}- ${entry.title} (id: ${entry.id}, type: ${entry.type}, ` +
        `archiviert ${formatArchivedAt(entry.archivedAt)}${cascade}${below})`,
    );
    lines.push(...renderTrashEntries(entry.children, depth + 1, budget));
  }
  return lines;
}

export const pageTrashTool: AnyToolDefinition = defineTool({
  name: 'exo_page_trash',
  description:
    'Liest den Papierkorb eines Arbeitsbereichs als Baum: was archiviert wurde, was dabei ' +
    'mitgegangen ist und wann. Eingerückte Einträge hingen unter dem Eintrag darüber. ' +
    '"mit archiviert" heißt: diese Seite wurde nie selbst gewählt, sie kam mit ihrer ' +
    'Elternseite mit. exo_page_restore holt eine Seite zurück, exo_page_delete löscht sie ' +
    'endgültig.',
  inputSchema: z.object({ workspaceId: idSchema }),
  surfaces: ['mcp', 'ai'],
  mutating: false,
  async execute(client, input) {
    const result = await client.request({
      method: 'GET',
      path: `/api/workspaces/${input.workspaceId}/trash`,
      responseSchema: trashResponseSchema,
    });
    if (result.totalCount === 0) {
      return { text: 'Der Papierkorb ist leer.', data: result };
    }
    const budget = { left: MAX_TRASH_LINES };
    const lines = renderTrashEntries(result.entries, 0, budget);
    const omitted = result.totalCount - lines.length;
    const notice =
      omitted <= 0
        ? ''
        : `\n… ${omitted} weitere archivierte Seite(n) hier nicht angezeigt (gekürzt).`;
    return {
      text:
        `${result.totalCount} archivierte Seite(n), davon ${result.entries.length} eigenständig ` +
        `archiviert:\n${lines.join('\n')}${notice}`,
      data: result,
    };
  },
});

export const pageDeleteTool: AnyToolDefinition = defineTool({
  name: 'exo_page_delete',
  description:
    'Löscht eine archivierte Seite endgültig, mit allem, was unter ihr hängt: Inhalt, ' +
    'Versionsstände, Kommentare, Anhänge und Dateien. Das ist der einzige Vorgang in ' +
    'eXocortex, den nichts rückgängig macht, auch kein Snapshot. Die Seite muss vorher im ' +
    'Papierkorb liegen (exo_page_archive), und es braucht Adminrechte im Arbeitsbereich. ' +
    'Verweise anderer Seiten auf sie bleiben stehen und werden zu unaufgelösten Verweisen. ' +
    'Der Aufruf verändert Daten: der erste Aufruf sagt, wie viele Seiten mitgehen, und führt ' +
    'nichts aus; erst der identisch wiederholte löscht.',
  inputSchema: z.object({ documentId: idSchema }),
  // `mcp` only, deliberately. The built-in AI's tool loop has no confirmation
  // gate -- it is governed by the `ai.mutatingToolsEnabled` switch, which is one
  // decision for every write there is. The single operation nothing can undo
  // does not belong behind a switch somebody flipped once, so it stays with the
  // surfaces that ask twice.
  surfaces: ['mcp'],
  mutating: true,
  destructive: true,
  irreversible: true,
  target: (input) => `document:${input.documentId}`,
  async preview(client, input) {
    const preview = await client.request({
      method: 'GET',
      path: `/api/documents/${input.documentId}/deletion-preview`,
      responseSchema: documentDeletionPreviewSchema,
    });
    const names = preview.documents
      .slice(1, 11)
      .map((document) => `- ${formatDocumentSummary(document)}`);
    return [
      `Endgültig gelöscht würden ${preview.documents.length} Seite(n): „${preview.title}“` +
        (preview.descendantCount === 0
          ? ' (keine Unterseiten).'
          : ` und ${preview.descendantCount} Seite(n) darunter.`),
      ...(names.length === 0 ? [] : names),
      ...(preview.descendantCount > names.length
        ? [`… und ${preview.descendantCount - names.length} weitere.`]
        : []),
      ...(preview.attachmentCount === 0
        ? []
        : [`Dazu ${preview.attachmentCount} Anhang/Anhänge samt Dateien.`]),
      ...(preview.incomingLinkCount === 0
        ? []
        : [
            `${preview.incomingLinkCount} Verweis(e) anderer Seiten zeigen darauf und werden ` +
              'unaufgelöst.',
          ]),
      'Das ist nicht rückgängig zu machen.',
    ].join('\n');
  },
  async execute(client, input) {
    const result = await client.request({
      method: 'DELETE',
      path: `/api/documents/${input.documentId}`,
      responseSchema: deleteDocumentsResponseSchema,
    });
    const extras = [
      result.attachmentCount === 0 ? null : `${result.attachmentCount} Anhang/Anhänge`,
      result.unresolvedLinkCount === 0
        ? null
        : `${result.unresolvedLinkCount} Verweis(e) sind jetzt unaufgelöst`,
    ].filter((part): part is string => part !== null);
    return {
      text:
        `${result.deletedCount} Seite(n) endgültig gelöscht.` +
        (extras.length === 0 ? '' : ` ${extras.join(', ')}.`),
      data: result,
    };
  },
});

export const pageSnapshotsTool: AnyToolDefinition = defineTool({
  name: 'exo_page_snapshots',
  description: 'Listet die gespeicherten Snapshots einer Seite (für Wiederherstellung nach einem Schreibvorgang).',
  inputSchema: z.object({ documentId: idSchema }),
  surfaces: ['mcp', 'ai'],
  mutating: false,
  async execute(client, input) {
    const result = await client.request({
      method: 'GET',
      path: `/api/documents/${input.documentId}/snapshots`,
      responseSchema: documentSnapshotListResponseSchema,
    });
    if (result.snapshots.length === 0) {
      return { text: 'Keine Snapshots vorhanden.', data: result };
    }
    const text = result.snapshots
      .map((snapshot, i) => `${i + 1}. ${snapshot.id} (${snapshot.reason}, ${snapshot.createdAt})`)
      .join('\n');
    return { text, data: result };
  },
});

export const pageRestoreSnapshotTool: AnyToolDefinition = defineTool({
  name: 'exo_page_restore_snapshot',
  description: 'Stellt eine Seite auf den Stand eines früheren Snapshots zurück.',
  inputSchema: z.object({ documentId: idSchema, snapshotId: idSchema }),
  surfaces: ['mcp', 'ai'],
  mutating: true,
  destructive: true,
  target: (input) => `document:${input.documentId}`,
  async execute(client, input) {
    const result = await client.request({
      method: 'POST',
      path: `/api/documents/${input.documentId}/snapshots/${input.snapshotId}/restore`,
      responseSchema: restoreSnapshotResultSchema,
    });
    return { text: `Seite ${result.documentId} auf Snapshot ${result.restoredFrom} zurückgesetzt.`, data: result };
  },
});

/** One-line German summary of an activity entry, for the model's text response. */
function formatActivityEntry(entry: z.infer<typeof documentActivityResponseSchema>['entries'][number]): string {
  const who = entry.actorName ?? 'Unbekannt';
  switch (entry.type) {
    case 'created':
      return `${entry.occurredAt}: Seite angelegt von ${who}`;
    case 'renamed':
      return `${entry.occurredAt}: umbenannt von ${who} ("${entry.previousTitle ?? '?'}" → "${entry.nextTitle ?? '?'}")`;
    case 'moved':
      return `${entry.occurredAt}: verschoben von ${who}${entry.acrossWorkspace ? ' (anderer Workspace)' : ''}`;
    case 'archived':
      return `${entry.occurredAt}: archiviert von ${who}`;
    case 'restored':
      return `${entry.occurredAt}: wiederhergestellt von ${who}`;
    case 'snapshotRestored':
      return `${entry.occurredAt}: auf Snapshot ${entry.restoredFromSnapshotId} zurückgesetzt von ${who}`;
    case 'snapshot':
      return `${entry.occurredAt}: Snapshot ${entry.id} (${entry.reason}) von ${who}`;
    case 'editingSession':
      return entry.startedAt === entry.endedAt
        ? `${entry.endedAt}: bearbeitet von ${who}`
        : `${entry.startedAt} – ${entry.endedAt}: bearbeitet von ${who}`;
  }
}

export const pageActivityTool: AnyToolDefinition = defineTool({
  name: 'exo_page_activity',
  description:
    'Liest den Verlauf einer Seite: angelegt, umbenannt, verschoben, archiviert, wiederhergestellt, ' +
    'Snapshots (mit exo_page_restore_snapshot wiederherstellbar) und verdichtete Bearbeitungssitzungen. ' +
    'Das ist der Seitenverlauf, kein Prüfprotokoll für die Verwaltung.',
  inputSchema: z.object({ documentId: idSchema }),
  surfaces: ['mcp', 'ai'],
  mutating: false,
  async execute(client, input) {
    const result = await client.request({
      method: 'GET',
      path: `/api/documents/${input.documentId}/activity`,
      responseSchema: documentActivityResponseSchema,
    });
    if (result.entries.length === 0) {
      return { text: 'Kein Verlauf vorhanden.', data: result };
    }
    return { text: result.entries.map(formatActivityEntry).join('\n'), data: result };
  },
});
