import { type AnyToolDefinition, type ToolSurface } from './tool.js';
import { AGENT_SESSION_TOOLS } from './tools/agent-sessions.js';
import { AI_RUN_TOOLS } from './tools/ai-runs.js';
import { ATTACHMENT_TOOLS } from './tools/attachments.js';
import { AUTOMATION_TOOLS } from './tools/automations.js';
import { CHAT_TOOLS } from './tools/chats.js';
import { COMMENT_TOOLS } from './tools/comments.js';
import { DATABASE_TOOLS } from './tools/databases.js';
import { ENTITY_TOOLS } from './tools/entities.js';
import { INBOX_TOOLS } from './tools/inbox.js';
import { INVITATION_TOOLS } from './tools/invitations.js';
import { LINK_TOOLS } from './tools/links.js';
import { MEMORY_TOOLS } from './tools/memory.js';
import { MEMORY_FACT_TOOLS } from './tools/memory-facts.js';
import { OVERVIEW_TOOLS } from './tools/overviews.js';
import { PAGE_TOOLS } from './tools/pages.js';
import { PLACEMENT_TOOLS } from './tools/placement.js';
import { PROJECT_ARCHIVE_TOOLS } from './tools/project-archives.js';
import { PROJECT_TOOLS } from './tools/projects.js';
import { RENDER_TOOLS } from './tools/render.js';
import { RESEARCH_TOOLS } from './tools/research.js';
import { RULES_TOOLS } from './tools/rules.js';
import { SEARCH_TOOLS } from './tools/search.js';
import { TEMPLATE_TOOLS } from './tools/templates.js';
import { WEB_TOOLS } from './tools/web.js';
import { WORKSPACE_TOOLS } from './tools/workspaces.js';

export const EXOCORTEX_TOOLS: readonly AnyToolDefinition[] = [
  ...WORKSPACE_TOOLS,
  ...PAGE_TOOLS,
  ...INBOX_TOOLS,
  ...TEMPLATE_TOOLS,
  ...PLACEMENT_TOOLS,
  ...OVERVIEW_TOOLS,
  ...LINK_TOOLS,
  ...COMMENT_TOOLS,
  ...SEARCH_TOOLS,
  ...WEB_TOOLS,
  ...DATABASE_TOOLS,
  ...ATTACHMENT_TOOLS,
  ...RULES_TOOLS,
  ...AI_RUN_TOOLS,
  ...CHAT_TOOLS,
  ...RESEARCH_TOOLS,
  ...MEMORY_TOOLS,
  ...MEMORY_FACT_TOOLS,
  ...ENTITY_TOOLS,
  ...INVITATION_TOOLS,
  ...AGENT_SESSION_TOOLS,
  ...AUTOMATION_TOOLS,
  ...RENDER_TOOLS,
  ...PROJECT_TOOLS,
  ...PROJECT_ARCHIVE_TOOLS,
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
