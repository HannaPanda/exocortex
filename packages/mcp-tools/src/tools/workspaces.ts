import { z } from 'zod';

import {
  idSchema,
  type OverviewDocument,
  reorderWorkspacesRequestSchema,
  type Workspace,
  workspaceListResponseSchema,
  workspaceOverviewResponseSchema,
  workspaceSchema,
  workspaceSlugSchema,
} from '@exocortex/contracts';

import { type AnyToolDefinition, defineTool } from '../tool.js';

function formatWorkspace(workspace: Workspace): string {
  return `${workspace.name} (id: ${workspace.id}, slug: ${workspace.slug}, Rolle: ${workspace.role})`;
}

export const listWorkspacesTool: AnyToolDefinition = defineTool({
  name: 'exo_list_workspaces',
  description: 'Listet alle Workspaces, auf die der aktuelle Nutzer Zugriff hat.',
  inputSchema: z.object({}),
  surfaces: ['mcp', 'ai'],
  domain: 'core',
  mutating: false,
  async execute(client) {
    const result = await client.request({
      method: 'GET',
      path: '/api/workspaces',
      responseSchema: workspaceListResponseSchema,
    });
    if (result.workspaces.length === 0) {
      return { text: 'Keine Workspaces gefunden.', data: result };
    }
    const text = result.workspaces
      .map((workspace, i) => `${i + 1}. ${formatWorkspace(workspace)}`)
      .join('\n');
    return { text, data: result };
  },
});

const workspaceRenameInputSchema = z.object({
  workspaceId: idSchema,
  name: z.string().trim().min(1).max(120).optional(),
  /**
   * The slug is never derived from `name` here. It appears in URLs and in
   * links people already saved, so changing it is a separate, explicit
   * choice -- only give it when you actually mean to break old links.
   */
  slug: workspaceSlugSchema.optional(),
});

export const workspaceRenameTool: AnyToolDefinition = defineTool({
  name: 'exo_workspace_rename',
  description:
    'Benennt einen Arbeitsbereich um und/oder ändert seinen Slug. Der Slug wandert dabei nicht ' +
    'automatisch mit dem Namen: er steckt in gespeicherten Links, ein geänderter Slug bricht sie. ' +
    'Braucht die Rolle OWNER oder ADMIN im Arbeitsbereich.',
  inputSchema: workspaceRenameInputSchema,
  surfaces: ['mcp', 'ai'],
  domain: 'admin',
  mutating: true,
  destructive: true,
  target: (input) => `workspace:${input.workspaceId}`,
  async execute(client, input) {
    const { workspaceId, ...body } = input;
    const result = await client.request({
      method: 'PATCH',
      path: `/api/workspaces/${workspaceId}`,
      body,
      responseSchema: workspaceSchema,
    });
    return { text: `Arbeitsbereich umbenannt: ${formatWorkspace(result)}`, data: result };
  },
});

export const workspaceReorderTool: AnyToolDefinition = defineTool({
  name: 'exo_workspace_reorder',
  description:
    'Ändert die Reihenfolge der eigenen Arbeitsbereiche. Der erste der Liste öffnet sich beim ' +
    'Start. workspaceIds nennt die Bereiche, die vorne stehen sollen, in dieser Reihenfolge; ' +
    'alle nicht genannten folgen dahinter in ihrer bisherigen Reihenfolge. Einen Bereich ans ' +
    'Ende schieben heißt also: alle anderen in gewünschter Reihenfolge nennen. Gilt nur für ' +
    'dieses Konto, die Liste anderer Mitglieder bleibt, wie sie ist.',
  inputSchema: reorderWorkspacesRequestSchema,
  surfaces: ['mcp', 'ai'],
  domain: 'core',
  mutating: true,
  target: () => 'user-preferences:workspace-order',
  async execute(client, input) {
    const result = await client.request({
      method: 'PATCH',
      path: '/api/workspaces/order',
      body: input,
      responseSchema: workspaceListResponseSchema,
    });
    const text = result.workspaces
      .map((workspace, i) => `${i + 1}. ${formatWorkspace(workspace)}`)
      .join('\n');
    return { text: `Neue Reihenfolge:\n${text}`, data: result };
  },
});

/** "Technik › Server › nginx" — the path is what makes a title an address. */
function formatDocumentLine(document: OverviewDocument): string {
  const where = document.path.map((entry) => entry.title).join(' › ');
  const suffix = where === '' ? '' : ` (in ${where})`;
  return `${document.title}${suffix} [id: ${document.id}]`;
}

export const workspaceOverviewTool: AnyToolDefinition = defineTool({
  name: 'exo_workspace_overview',
  description:
    'Zeigt den Einstieg in einen Arbeitsbereich: zuletzt bearbeitete Seiten, Datenbanken, ' +
    'die obersten Bereiche und was liegen geblieben ist (offene Kommentare, ins Leere ' +
    'zeigende Verweise, hängende Textextraktionen, Seiten mit dem Titel doppelt im Text). ' +
    'Gut als erster Aufruf, um zu sehen, ' +
    'woran zuletzt gearbeitet wurde, ohne den ganzen Seitenbaum zu laden.',
  inputSchema: z.object({ workspaceId: idSchema }),
  surfaces: ['mcp', 'ai'],
  domain: 'core',
  mutating: false,
  async execute(client, input) {
    const result = await client.request({
      method: 'GET',
      path: `/api/workspaces/${input.workspaceId}/overview`,
      responseSchema: workspaceOverviewResponseSchema,
    });

    const sections: string[] = [
      `${result.workspaceName}: ${result.stats.pageCount} Seiten, ` +
        `${result.stats.databaseCount} Datenbanken, ${result.stats.editedThisWeek} davon ` +
        'in den letzten sieben Tagen bearbeitet.',
    ];

    if (result.recentlyEdited.length > 0) {
      sections.push(
        ['Zuletzt bearbeitet:']
          .concat(
            result.recentlyEdited.map(
              (document) => `- ${formatDocumentLine(document)} — ${document.editedAt}`,
            ),
          )
          .join('\n'),
      );
    }
    if (result.databases.length > 0) {
      sections.push(
        ['Datenbanken:']
          .concat(
            result.databases.map(
              (database) => `- ${formatDocumentLine(database)}, ${database.rowCount} Zeilen`,
            ),
          )
          .join('\n'),
      );
    }
    if (result.sections.length > 0) {
      sections.push(
        ['Bereiche:']
          .concat(
            result.sections.map(
              (section) =>
                `- ${section.title} [id: ${section.id}], ` +
                `${section.descendantCount} Unterseiten`,
            ),
          )
          .join('\n'),
      );
    }

    const attention = [
      ['Offene Kommentare', result.attention.openComments] as const,
      ['Verweise ins Leere', result.attention.brokenLinks] as const,
      ['Hängende Textextraktionen', result.attention.stalledAttachments] as const,
      ['Titel gleich nochmal als Überschrift', result.attention.duplicateTitleHeadings] as const,
    ].filter(([, item]) => item.count > 0);
    if (attention.length > 0) {
      sections.push(
        ['Liegen geblieben:']
          .concat(
            attention.map(
              ([label, item]) =>
                `- ${label}: ${item.count} (u. a. ` +
                `${item.documents.map((document) => document.title).join(', ')})`,
            ),
          )
          .join('\n'),
      );
    }

    return { text: sections.join('\n\n'), data: result };
  },
});

export const WORKSPACE_TOOLS: readonly AnyToolDefinition[] = [
  listWorkspacesTool,
  workspaceOverviewTool,
  workspaceRenameTool,
  workspaceReorderTool,
];
