import { type AnyToolDefinition, type ToolSurface } from './tool.js';
import { ATTACHMENT_TOOLS } from './tools/attachments.js';
import { DATABASE_TOOLS } from './tools/databases.js';
import { PAGE_TOOLS } from './tools/pages.js';
import { RULES_TOOLS } from './tools/rules.js';
import { SEARCH_TOOLS } from './tools/search.js';
import { WORKSPACE_TOOLS } from './tools/workspaces.js';

export const EXOCORTEX_TOOLS: readonly AnyToolDefinition[] = [
  ...WORKSPACE_TOOLS,
  ...PAGE_TOOLS,
  ...SEARCH_TOOLS,
  ...DATABASE_TOOLS,
  ...ATTACHMENT_TOOLS,
  ...RULES_TOOLS,
];

/** Tools offered on a given surface, optionally excluding mutating ones. */
export function toolsFor(
  surface: ToolSurface,
  options?: { includeMutating?: boolean },
): readonly AnyToolDefinition[] {
  const includeMutating = options?.includeMutating ?? true;
  return EXOCORTEX_TOOLS.filter(
    (tool) => tool.surfaces.includes(surface) && (includeMutating || !tool.mutating),
  );
}

export function findTool(name: string): AnyToolDefinition | null {
  return EXOCORTEX_TOOLS.find((tool) => tool.name === name) ?? null;
}

/** MCP `tools/list` shape. */
export function toMcpToolList(
  tools: readonly AnyToolDefinition[],
): { name: string; description: string; inputSchema: unknown }[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.jsonSchema,
  }));
}

/** OpenAI/OpenRouter `tools` array shape. */
export function toOpenAiToolList(
  tools: readonly AnyToolDefinition[],
): { type: 'function'; function: { name: string; description: string; parameters: unknown } }[] {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.jsonSchema,
    },
  }));
}
