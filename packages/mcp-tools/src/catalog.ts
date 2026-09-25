import { type AnyToolDefinition, type ToolDomain, type ToolSurface } from './tool.js';
import { AGENT_MESSAGE_TOOLS } from './tools/agent-messages.js';
import { AGENT_SESSION_TOOLS } from './tools/agent-sessions.js';
import { AI_RUN_TOOLS } from './tools/ai-runs.js';
import { ATTACHMENT_TOOLS } from './tools/attachments.js';
import { AUTOMATION_TOOLS } from './tools/automations.js';
import { CHAT_TOOLS } from './tools/chats.js';
import { COMMENT_TOOLS } from './tools/comments.js';
import { DATABASE_TOOLS } from './tools/databases.js';
import { ENTITY_TOOLS } from './tools/entities.js';
import { FEATURE_TOOLS } from './tools/features.js';
import { INBOX_TOOLS } from './tools/inbox.js';
import { INVITATION_TOOLS } from './tools/invitations.js';
import { LINK_TOOLS } from './tools/links.js';
import { MEMORY_TOOLS } from './tools/memory.js';
import { MEMORY_FACT_TOOLS } from './tools/memory-facts.js';
import { NOTIFICATION_TOOLS } from './tools/notifications.js';
import { OVERVIEW_TOOLS } from './tools/overviews.js';
import { PAGE_TOOLS } from './tools/pages.js';
import { PLACEMENT_TOOLS } from './tools/placement.js';
import { PREFERENCE_TOOLS } from './tools/preferences.js';
import { PROJECT_ARCHIVE_TOOLS } from './tools/project-archives.js';
import { PROJECT_TOOLS } from './tools/projects.js';
import { PUSH_TOOLS } from './tools/push.js';
import { RENDER_TOOLS } from './tools/render.js';
import { RESEARCH_TOOLS } from './tools/research.js';
import { RULES_TOOLS } from './tools/rules.js';
import { SAVED_QUERY_TOOLS } from './tools/saved-queries.js';
import { SEARCH_TOOLS } from './tools/search.js';
import { SHARE_TOOLS } from './tools/shares.js';
import { TEMPLATE_TOOLS } from './tools/templates.js';
import { createToolboxTool } from './tools/toolbox.js';
import { TRANSCLUSION_TOOLS } from './tools/transclusion.js';
import { WEB_TOOLS } from './tools/web.js';
import { WORKSPACE_TOOLS } from './tools/workspaces.js';

/**
 * The catalogue, apart from the one tool that is made out of it.
 *
 * `exo_toolbox` lists and opens the domains of everything below, so it is
 * built from this list and put in front of it (issue #121). Splitting the
 * declaration in two is what keeps `toolbox.ts` and this file from importing
 * each other.
 */
const CATALOGUED_TOOLS: readonly AnyToolDefinition[] = [
  ...WORKSPACE_TOOLS,
  ...FEATURE_TOOLS,
  ...PAGE_TOOLS,
  ...TRANSCLUSION_TOOLS,
  ...INBOX_TOOLS,
  ...TEMPLATE_TOOLS,
  ...PLACEMENT_TOOLS,
  ...OVERVIEW_TOOLS,
  ...LINK_TOOLS,
  ...COMMENT_TOOLS,
  ...SHARE_TOOLS,
  ...SEARCH_TOOLS,
  ...SAVED_QUERY_TOOLS,
  ...WEB_TOOLS,
  ...DATABASE_TOOLS,
  ...ATTACHMENT_TOOLS,
  ...RULES_TOOLS,
  ...AI_RUN_TOOLS,
  ...CHAT_TOOLS,
  ...RESEARCH_TOOLS,
  ...MEMORY_TOOLS,
  ...MEMORY_FACT_TOOLS,
  ...AGENT_MESSAGE_TOOLS,
  ...ENTITY_TOOLS,
  ...INVITATION_TOOLS,
  ...AGENT_SESSION_TOOLS,
  ...AUTOMATION_TOOLS,
  ...PUSH_TOOLS,
  ...NOTIFICATION_TOOLS,
  ...PREFERENCE_TOOLS,
  ...RENDER_TOOLS,
  ...PROJECT_TOOLS,
  ...PROJECT_ARCHIVE_TOOLS,
];

export const EXOCORTEX_TOOLS: readonly AnyToolDefinition[] = [
  createToolboxTool(CATALOGUED_TOOLS),
  ...CATALOGUED_TOOLS,
];

/**
 * Tools offered on a given surface.
 *
 * `domains` narrows the answer to a subset of the catalogue and is what the
 * built-in loop passes (issue #121); every other caller leaves it out and gets
 * the surface whole, which is what an MCP handshake is. Narrowing is a
 * description of what a model is told about, never of what it is allowed to
 * do: the authorization is the service token and `decideMutation`, and both
 * run whatever this returned.
 */
export function toolsFor(
  surface: ToolSurface,
  options?: { includeMutating?: boolean; domains?: readonly ToolDomain[] },
): readonly AnyToolDefinition[] {
  const includeMutating = options?.includeMutating ?? true;
  const domains = options?.domains === undefined ? null : new Set(options.domains);
  return EXOCORTEX_TOOLS.filter(
    (tool) =>
      tool.surfaces.includes(surface) &&
      (includeMutating || !tool.mutating) &&
      (domains === null || domains.has(tool.domain)),
  );
}

/**
 * Characters of JSON the tool list weighs on the wire.
 *
 * The number issue #121 is about, measured rather than estimated: it is what
 * `toOpenAiToolList` serializes to, which is what the provider is sent on
 * every single turn. Recorded per run so a change here is visible as money
 * rather than as an intention.
 */
export function toolSchemaChars(tools: readonly AnyToolDefinition[]): number {
  return JSON.stringify(toOpenAiToolList(tools)).length;
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
