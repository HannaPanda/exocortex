import { z } from 'zod';

import {
  type AgentProfile,
  agentProfileListResponseSchema,
  agentProfileResponseSchema,
  createAgentProfileRequestSchema,
  deleteAgentProfileResponseSchema,
  duplicateAgentProfileRequestSchema,
  idSchema,
  TOOL_DOMAINS,
  updateAgentProfileRequestSchema,
} from '@exocortex/contracts';

import { type AnyToolDefinition, defineTool } from '../tool.js';

/**
 * Agent profiles (issue #143, ADR-071).
 *
 * A profile is the role the built-in AI works in on a work item: what it is
 * told, which model it prefers, which tool domains it may use, how it may
 * write and what it may spend. It only narrows. Reading is on both agent
 * surfaces; writing is not on the built-in AI's, because a run that could
 * edit the rules it runs under would not be held by them.
 */

const FIELDS_HELP =
  'Felder: name, description, instructions (die Rolle in Worten), ruleDocumentIds (Seiten, deren ' +
  'Text an die Rolle angehängt wird), modelSlug (bevorzugtes Modell, kein Anbieter), ' +
  'reasoningLevel, providerRouting (OpenRouter-Schlüssel wie sort, only, ignore, über die ' +
  'Konfiguration gelegt), toolDomains (erlaubte Werkzeugbereiche, null für alle; core bleibt ' +
  `immer: ${TOOL_DOMAINS.join(', ')}), writeMode (read_only, propose, direct), approvalPolicy ` +
  '(none oder review_before_done: dann schließt ein Mensch den Auftrag), budgetMicroUsdPerRun, ' +
  'budgetMicroUsdPerTask, maxToolIterations, maxRunSeconds, confineToWorkspace (Lauf bleibt im ' +
  'Arbeitsbereich), isDefault (gilt für Aufträge ohne eigenes Profil). Jede Grenze wird mit der ' +
  'des Arbeitsbereichs und des Auftrags verglichen, die strengere gilt.';

function money(microUsd: number | null): string {
  return microUsd === null ? 'ohne Grenze' : `${(microUsd / 1_000_000).toFixed(2)} $`;
}

function formatProfile(profile: AgentProfile): string {
  const lines = [
    `${profile.name} (id: ${profile.id}, Stand ${profile.revision})` +
      (profile.isDefault ? ' · Standardprofil' : ''),
  ];
  if (profile.description !== null) lines.push(profile.description);
  lines.push(
    `Schreiben: ${profile.writeMode} · Abnahme: ${profile.approvalPolicy}`,
    `Werkzeugbereiche: ${profile.toolDomains === null ? 'alle' : ['core', ...profile.toolDomains.filter((domain) => domain !== 'core')].join(', ')}`,
    `Modell: ${profile.modelSlug ?? 'Standard'}` +
      (profile.reasoningLevel === null ? '' : ` · Denkstufe ${profile.reasoningLevel}`),
    `Budget je Lauf: ${money(profile.budgetMicroUsdPerRun)} · je Auftrag: ${money(profile.budgetMicroUsdPerTask)}`,
  );
  const limits = [
    profile.maxToolIterations === null ? null : `${profile.maxToolIterations} Werkzeugrunden`,
    profile.maxRunSeconds === null ? null : `${profile.maxRunSeconds} s Laufzeit`,
    profile.confineToWorkspace ? 'nur dieser Arbeitsbereich' : null,
  ].filter((entry) => entry !== null);
  if (limits.length > 0) lines.push(`Grenzen: ${limits.join(' · ')}`);
  if (profile.providerRouting !== null) {
    lines.push(`Anbieter-Routing: ${JSON.stringify(profile.providerRouting)}`);
  }
  if (profile.ruleDocuments.length > 0) {
    lines.push(
      `Regelseiten: ${profile.ruleDocuments.map((rule) => rule.title ?? `${rule.documentId} (fehlt)`).join(', ')}`,
    );
  }
  if (profile.instructions !== null) lines.push('', `Rolle:\n${profile.instructions}`);
  lines.push(`Offene Aufträge mit diesem Profil: ${profile.workItemCount}`);
  return lines.join('\n');
}

export const agentProfileListTool: AnyToolDefinition = defineTool({
  name: 'exo_agent_profile_list',
  description:
    'Listet die Agentenprofile eines Arbeitsbereichs: Rollen, in denen die eingebaute KI an ' +
    'Aufträgen arbeitet (z. B. Entwickler, Rechercheur, Archivar), mit Schreibmodus, ' +
    'Werkzeugbereichen, Modell und Budget. Das Standardprofil steht zuerst.',
  inputSchema: z.object({ workspaceId: idSchema }),
  surfaces: ['mcp', 'ai'],
  domain: 'workItems',
  mutating: false,
  async execute(client, input) {
    const result = await client.request({
      method: 'GET',
      path: `/api/workspaces/${input.workspaceId}/agent-profiles`,
      responseSchema: agentProfileListResponseSchema,
    });
    if (result.profiles.length === 0) {
      return {
        text: 'Dieser Arbeitsbereich hat noch keine Agentenprofile. exo_agent_profile_create legt eines an.',
        data: result,
      };
    }
    return {
      text: result.profiles.map(formatProfile).join('\n\n'),
      data: result,
    };
  },
});

export const agentProfileGetTool: AnyToolDefinition = defineTool({
  name: 'exo_agent_profile_get',
  description:
    'Liest ein Agentenprofil vollständig, mit seiner Rolle und der Änderungshistorie aus dem ' +
    'Audit-Log (wer was wann geändert hat, mit Stand).',
  inputSchema: z.object({ profileId: idSchema }),
  surfaces: ['mcp', 'ai'],
  domain: 'workItems',
  mutating: false,
  async execute(client, input) {
    const result = await client.request({
      method: 'GET',
      path: `/api/agent-profiles/${input.profileId}`,
      responseSchema: agentProfileResponseSchema,
    });
    const history = result.history.map(
      (entry) =>
        `- ${entry.createdAt.slice(0, 16)} ${entry.action}` +
        (entry.revision === null ? '' : ` (Stand ${entry.revision})`) +
        ` von ${entry.actor?.name ?? 'unbekannt'}` +
        (entry.fields.length === 0 ? '' : `: ${entry.fields.join(', ')}`),
    );
    return {
      text: [formatProfile(result.profile), '', 'Historie:', ...history].join('\n'),
      data: result,
    };
  },
});

export const agentProfileCreateTool: AnyToolDefinition = defineTool({
  name: 'exo_agent_profile_create',
  description:
    'Legt ein Agentenprofil an (nur Admins des Arbeitsbereichs). Ohne writeMode beginnt es mit ' +
    `propose. ${FIELDS_HELP}`,
  inputSchema: z.object({ workspaceId: idSchema }).extend(createAgentProfileRequestSchema.shape),
  surfaces: ['mcp'],
  domain: 'workItems',
  mutating: true,
  target: (input) => `workspace:${input.workspaceId}:agent-profiles`,
  async execute(client, input) {
    const { workspaceId, ...body } = input;
    const result = await client.request({
      method: 'POST',
      path: `/api/workspaces/${workspaceId}/agent-profiles`,
      body,
      responseSchema: agentProfileResponseSchema,
    });
    return { text: `Agentenprofil angelegt:\n${formatProfile(result.profile)}`, data: result };
  },
});

export const agentProfileUpdateTool: AnyToolDefinition = defineTool({
  name: 'exo_agent_profile_update',
  description:
    'Ändert ein Agentenprofil (nur Admins). Nur die genannten Felder ändern sich, null leert ' +
    'eines. Jede Änderung erhöht den Stand und landet im Audit-Log; Läufe behalten den Stand, ' +
    `mit dem sie begonnen haben. ${FIELDS_HELP}`,
  inputSchema: z.object({ profileId: idSchema }).extend(updateAgentProfileRequestSchema.shape),
  surfaces: ['mcp'],
  domain: 'workItems',
  mutating: true,
  target: (input) => `agent-profile:${input.profileId}`,
  async execute(client, input) {
    const { profileId, ...body } = input;
    const result = await client.request({
      method: 'PATCH',
      path: `/api/agent-profiles/${profileId}`,
      body,
      responseSchema: agentProfileResponseSchema,
    });
    return { text: `Agentenprofil geändert:\n${formatProfile(result.profile)}`, data: result };
  },
});

export const agentProfileDuplicateTool: AnyToolDefinition = defineTool({
  name: 'exo_agent_profile_duplicate',
  description:
    'Legt eine Kopie eines Agentenprofils unter neuem Namen an (nur Admins). Die Kopie ist nie ' +
    'das Standardprofil.',
  inputSchema: z.object({ profileId: idSchema }).extend(duplicateAgentProfileRequestSchema.shape),
  surfaces: ['mcp'],
  domain: 'workItems',
  mutating: true,
  target: (input) => `agent-profile:${input.profileId}`,
  async execute(client, input) {
    const { profileId, ...body } = input;
    const result = await client.request({
      method: 'POST',
      path: `/api/agent-profiles/${profileId}/duplicate`,
      body,
      responseSchema: agentProfileResponseSchema,
    });
    return { text: `Kopie angelegt:\n${formatProfile(result.profile)}`, data: result };
  },
});

export const agentProfileDeleteTool: AnyToolDefinition = defineTool({
  name: 'exo_agent_profile_delete',
  description:
    'Löscht ein Agentenprofil endgültig (nur Admins). Aufträge, die es nannten, arbeiten danach ' +
    'mit dem Standardprofil des Arbeitsbereichs, Läufe behalten ihren Schnappschuss.',
  inputSchema: z.object({ profileId: idSchema }),
  surfaces: ['mcp'],
  domain: 'workItems',
  mutating: true,
  destructive: true,
  irreversible: true,
  target: (input) => `agent-profile:${input.profileId}`,
  async execute(client, input) {
    const result = await client.request({
      method: 'DELETE',
      path: `/api/agent-profiles/${input.profileId}`,
      responseSchema: deleteAgentProfileResponseSchema,
    });
    return {
      text: `Agentenprofil gelöscht. ${result.detachedWorkItems} Auftrag/Aufträge nutzen jetzt das Standardprofil.`,
      data: result,
    };
  },
});

export const AGENT_PROFILE_TOOLS: readonly AnyToolDefinition[] = [
  agentProfileListTool,
  agentProfileGetTool,
  agentProfileCreateTool,
  agentProfileUpdateTool,
  agentProfileDuplicateTool,
  agentProfileDeleteTool,
];
