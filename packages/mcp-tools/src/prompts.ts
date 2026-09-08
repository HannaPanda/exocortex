import {
  aiRuleListResponseSchema,
  type AiRuleSummary,
  markdownExportResponseSchema,
  workspaceListResponseSchema,
} from '@exocortex/contracts';

import { type ExocortexApiClient } from './client.js';
import { truncateText } from './format.js';

/**
 * MCP prompts: the rule pages of this deployment, offered as slash commands.
 *
 * The content already exists — `exo_rules_list` and `exo_rules_load` reach the
 * same pages — but a tool is something the model decides to call. A prompt is
 * something a person picks from a menu before the model says anything, which
 * is what a rule page usually wants to be: "write the way this workspace
 * writes" is a decision, not a retrieval.
 *
 * Rules with mode `off` are not offered. They are switched off, and a menu
 * entry is not a place to argue with that.
 */

/** How many workspaces a listing walks before it stops. */
const MAX_LISTED_WORKSPACES = 20;

/** Rule pages can be long; a prompt is injected whole, so it gets a ceiling. */
const MAX_PROMPT_CHARS = 60_000;

/** MCP `prompts/list` entry. */
export interface McpPrompt {
  name: string;
  title: string;
  description: string;
  /** Rule pages take no parameters, but the field is not optional in clients. */
  arguments: never[];
}

/** MCP `prompts/get` result. */
export interface McpPromptMessages {
  description: string;
  messages: { role: 'user'; content: { type: 'text'; text: string } }[];
}

interface RulePrompt extends McpPrompt {
  documentId: string;
}

const UMLAUTS: Record<string, string> = {
  ä: 'ae',
  ö: 'oe',
  ü: 'ue',
  ß: 'ss',
};

/**
 * A page title as a slash command.
 *
 * Clients show the `name`, so it has to stay readable: `schreibstil` beats
 * `regel-cm9x…`. Two rules that slugify the same get a counter, which is why
 * `getMcpPrompt` re-derives the whole list instead of parsing an id out of the
 * name — the name means nothing on its own, only its position in the list does.
 */
function toPromptName(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[äöüß]/g, (character) => UMLAUTS[character] ?? character)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug === '' ? 'regel' : slug;
}

function describeRule(rule: AiRuleSummary, workspaceName: string): string {
  const trigger = rule.trigger === null || rule.trigger === '' ? null : rule.trigger;
  const scope = rule.mode === 'always' ? 'gilt immer' : 'auf Anfrage';
  return trigger === null
    ? `Regelseite „${rule.title}“ aus ${workspaceName} (${scope}).`
    : `${trigger} (Regelseite aus ${workspaceName}, ${scope})`;
}

/**
 * Every rule page this caller may read, in a stable order.
 *
 * `/api/workspaces` already answers with the readable workspaces only, so a
 * rule page in a workspace the caller has no membership in never reaches this
 * list — not even its title. A workspace whose rules cannot be fetched is
 * skipped rather than failing the whole menu.
 */
async function collectRulePrompts(client: ExocortexApiClient): Promise<RulePrompt[]> {
  const { workspaces } = await client.request({
    method: 'GET',
    path: '/api/workspaces',
    responseSchema: workspaceListResponseSchema,
  });
  const visible = workspaces.slice(0, MAX_LISTED_WORKSPACES);

  const lists = await Promise.allSettled(
    visible.map(async (workspace) =>
      client.request({
        method: 'GET',
        path: `/api/workspaces/${workspace.id}/ai-rules`,
        responseSchema: aiRuleListResponseSchema,
      }),
    ),
  );

  const prompts: RulePrompt[] = [];
  const used = new Map<string, number>();
  lists.forEach((list, index) => {
    const workspace = visible[index];
    if (list.status !== 'fulfilled' || workspace === undefined) return;
    for (const rule of list.value.rules) {
      if (rule.mode === 'off') continue;
      const base = toPromptName(rule.title);
      const seen = used.get(base) ?? 0;
      used.set(base, seen + 1);
      prompts.push({
        name: seen === 0 ? base : `${base}-${String(seen + 1)}`,
        title: rule.title,
        description: describeRule(rule, workspace.name),
        arguments: [],
        documentId: rule.documentId,
      });
    }
  });
  return prompts;
}

export async function listMcpPrompts(client: ExocortexApiClient): Promise<McpPrompt[]> {
  const prompts = await collectRulePrompts(client);
  return prompts.map(({ documentId: _documentId, ...prompt }) => prompt);
}

/** Loads one rule page as a prompt, or `null` when this caller has no such rule. */
export async function getMcpPrompt(
  client: ExocortexApiClient,
  name: string,
): Promise<McpPromptMessages | null> {
  const prompts = await collectRulePrompts(client);
  const prompt = prompts.find((candidate) => candidate.name === name);
  if (prompt === undefined) return null;

  const result = await client.request({
    method: 'GET',
    path: `/api/documents/${prompt.documentId}/export/markdown`,
    responseSchema: markdownExportResponseSchema,
  });
  const { text } = truncateText(result.markdown, MAX_PROMPT_CHARS);

  return {
    description: prompt.description,
    messages: [
      {
        // Not `system`: MCP prompts carry `user` and `assistant` only, and a
        // rule page is instructions the person chose to send, not a role the
        // server gets to claim.
        role: 'user',
        content: {
          type: 'text',
          text: `Halte dich für diese Aufgabe an die folgende Regelseite „${prompt.title}“:\n\n${text}`,
        },
      },
    ],
  };
}
