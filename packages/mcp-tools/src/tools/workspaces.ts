import { z } from 'zod';

import { type Workspace, workspaceListResponseSchema } from '@exocortex/contracts';

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

export const WORKSPACE_TOOLS: readonly AnyToolDefinition[] = [listWorkspacesTool];
