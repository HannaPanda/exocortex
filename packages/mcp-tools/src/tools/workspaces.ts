import { z } from 'zod';

import { idSchema, type Workspace, workspaceListResponseSchema, workspaceSchema, workspaceSlugSchema } from '@exocortex/contracts';

import { type AnyToolDefinition, defineTool } from '../tool.js';

function formatWorkspace(workspace: Workspace): string {
  return `${workspace.name} (id: ${workspace.id}, slug: ${workspace.slug}, Rolle: ${workspace.role})`;
}

export const listWorkspacesTool: AnyToolDefinition = defineTool({
  name: 'exo_list_workspaces',
  description: 'Listet alle Workspaces, auf die der aktuelle Nutzer Zugriff hat.',
  inputSchema: z.object({}),
  surfaces: ['mcp', 'ai'],
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
    const text = result.workspaces.map((workspace, i) => `${i + 1}. ${formatWorkspace(workspace)}`).join('\n');
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
  mutating: true,
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

export const WORKSPACE_TOOLS: readonly AnyToolDefinition[] = [listWorkspacesTool, workspaceRenameTool];
