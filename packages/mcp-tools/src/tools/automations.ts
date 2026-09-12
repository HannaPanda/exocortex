import { z } from 'zod';

import {
  AUTOMATION_MAX_DEBOUNCE_SECONDS,
  AUTOMATION_MIN_DEBOUNCE_SECONDS,
  automationOutputSchema,
  type AutomationRule,
  automationRuleListResponseSchema,
  automationRuleResponseSchema,
  automationRunListResponseSchema,
  automationScopeSchema,
  automationTriggerSchema,
  createAutomationRuleResponseSchema,
  deleteAutomationRuleResponseSchema,
  idSchema,
  triggerAutomationRuleResponseSchema,
} from '@exocortex/contracts';

import { renderMarkdownTable } from '../format.js';
import { type AnyToolDefinition, defineTool } from '../tool.js';

/**
 * Automations (issue #50, ADR-024).
 *
 * The catalogue carries these for the ordinary reason (CLAUDE.md rule 11): a
 * person can write a rule in the browser, so an agent has to be able to as
 * well. But the set is chosen rather than mirrored. Creating, changing,
 * listing, reading the run log and firing a rule by hand are all here, because
 * together they are the loop an agent needs to actually get a rule working:
 * write it, try it, read why it failed, fix it.
 *
 * Every write here needs an `admin`-scoped token, the same bar as managing
 * credentials. That is not this file's decision -- `requiredScopeForRequest`
 * puts every mutating `/automations` route there, because a rule keeps acting
 * long after the token that made it has been forgotten about.
 */

/** Runs shown in one listing. The log is for reading, not for exporting. */
const MAX_LISTED_RUNS = 25;

function describeRule(rule: AutomationRule): string {
  const scope =
    rule.scope === 'WORKSPACE'
      ? 'ganzer Arbeitsbereich'
      : `${rule.scope === 'SUBTREE' ? 'unter' : 'Datenbank'} „${rule.scopeDocumentTitle ?? rule.scopeDocumentId ?? '?'}"`;
  const action =
    rule.action === 'WEBHOOK'
      ? `Webhook → ${rule.webhookUrl ?? '?'}`
      : `KI-Lauf → ${rule.output === 'COMMENT' ? 'Kommentar' : 'Unterseite'}`;
  const state = rule.enabled
    ? 'an'
    : `aus${rule.disabledReason === null ? '' : ` (${rule.disabledReason})`}`;
  return `${rule.name} [${state}] ${scope}, ${rule.triggers.join('/')}, ${action}, Entprellung ${String(rule.debounceSeconds)}s (id: ${rule.id})`;
}

const ruleBodySchema = z.object({
  name: z.string().min(1).max(200).describe('Name der Regel, für Menschen'),
  enabled: z.boolean().default(true),
  scope: automationScopeSchema
    .default('WORKSPACE')
    .describe(
      'WORKSPACE beobachtet alles, SUBTREE eine Seite samt Unterseiten, DATABASE eine Datenbank',
    ),
  scopeDocumentId: idSchema
    .nullable()
    .default(null)
    .describe('Wurzel des Teilbaums bzw. die Datenbank. Bei WORKSPACE weglassen.'),
  triggers: z
    .array(automationTriggerSchema)
    .min(1)
    .describe(
      'Worauf die Regel reagiert. DATABASE_ROW_CHANGED geht nur im DATABASE-Geltungsbereich.',
    ),
  debounceSeconds: z
    .number()
    .int()
    .min(AUTOMATION_MIN_DEBOUNCE_SECONDS)
    .max(AUTOMATION_MAX_DEBOUNCE_SECONDS)
    .default(60)
    .describe(
      'Wie lange eine Seite ruhig sein muss, bevor die Regel läuft. Schützt vor einem Lauf pro Tastendruck.',
    ),
  webhookUrl: z
    .string()
    .url()
    .nullable()
    .default(null)
    .describe('Ziel des Webhooks. Der Host muss auf der Positivliste der Installation stehen.'),
  prompt: z
    .string()
    .min(1)
    .max(4_000)
    .nullable()
    .default(null)
    .describe('Was das Modell gefragt wird. Die geänderte Seite ist sein Material.'),
  modelSlug: z.string().min(1).max(200).nullable().default(null),
  output: automationOutputSchema
    .default('COMMENT')
    .describe('Wohin die Antwort geht. Eine Automation überschreibt niemals den Seiteninhalt.'),
});

export const automationListTool: AnyToolDefinition = defineTool({
  name: 'exo_automation_list',
  description:
    'Listet die Automationsregeln eines Arbeitsbereichs: Geltungsbereich, Auslöser, Aktion und ob ' +
    'die Regel gerade läuft. Sagt außerdem, ob Automationen in diesem Arbeitsbereich überhaupt ' +
    'eingeschaltet sind und auf welche Hosts ein Webhook zeigen darf.',
  inputSchema: z.object({ workspaceId: idSchema }),
  surfaces: ['mcp', 'ai'],
  mutating: false,
  async execute(client, input) {
    const result = await client.request({
      method: 'GET',
      path: `/api/workspaces/${input.workspaceId}/automations`,
      responseSchema: automationRuleListResponseSchema,
    });
    const header = result.enabledForWorkspace
      ? `Automationen sind eingeschaltet. Erlaubte Webhook-Hosts: ${result.allowedWebhookHosts.length === 0 ? 'keine' : result.allowedWebhookHosts.join(', ')}.`
      : 'Automationen sind für diesen Arbeitsbereich ABGESCHALTET. Keine Regel läuft, egal wie sie eingestellt ist.';
    if (result.rules.length === 0) {
      return { text: `${header}\n\nKeine Regeln.`, data: result };
    }
    const body = result.rules
      .map((rule, index) => `${index + 1}. ${describeRule(rule)}`)
      .join('\n');
    return { text: `${header}\n\n${body}`, data: result };
  },
});

export const automationCreateTool: AnyToolDefinition = defineTool({
  name: 'exo_automation_create',
  description:
    'Legt eine Automationsregel an: „wenn sich hier etwas ändert, dann das tun". Zwei Aktionen: ' +
    'WEBHOOK schickt einen signierten POST an eine URL, AI_RUN stellt einen Prompt gegen die ' +
    'geänderte Seite und legt die Antwort als Kommentar oder Unterseite ab. Braucht die ' +
    'OWNER-Rolle im Arbeitsbereich und einen Token mit admin-Rechten. Das Signiergeheimnis eines ' +
    'Webhooks steht genau einmal in dieser Antwort und lässt sich später nicht mehr auslesen.',
  inputSchema: ruleBodySchema.extend({ workspaceId: idSchema }),
  surfaces: ['mcp', 'ai'],
  mutating: true,
  target: (input) => `workspace:${input.workspaceId}`,
  async execute(client, input) {
    const { workspaceId, ...body } = input;
    const result = await client.request({
      method: 'POST',
      path: `/api/workspaces/${workspaceId}/automations`,
      body,
      responseSchema: createAutomationRuleResponseSchema,
    });
    const secret =
      result.webhookSecret === null
        ? ''
        : `\nSigniergeheimnis (nur jetzt sichtbar): ${result.webhookSecret}`;
    return { text: `Regel angelegt: ${describeRule(result.rule)}${secret}`, data: result };
  },
});

export const automationUpdateTool: AnyToolDefinition = defineTool({
  name: 'exo_automation_update',
  description:
    'Ändert eine Automationsregel. Nur die angegebenen Felder werden angefasst; geprüft wird die ' +
    'Regel als Ganzes, nicht die Änderung allein. enabled: false ist der Not-Aus für diese eine ' +
    'Regel, enabled: true setzt zugleich den Fehlerzähler zurück. Aus einer KI-Regel lässt sich ' +
    'keine Webhook-Regel machen: dafür eine neue Regel anlegen, damit das Signiergeheimnis einmal ' +
    'übergeben werden kann.',
  inputSchema: ruleBodySchema.partial().extend({ ruleId: idSchema }),
  surfaces: ['mcp', 'ai'],
  mutating: true,
  target: (input) => `automation:${input.ruleId}`,
  async execute(client, input) {
    const { ruleId, ...body } = input;
    const result = await client.request({
      method: 'PATCH',
      path: `/api/automations/${ruleId}`,
      body,
      responseSchema: automationRuleResponseSchema,
    });
    return { text: `Regel geändert: ${describeRule(result.rule)}`, data: result };
  },
});

export const automationDeleteTool: AnyToolDefinition = defineTool({
  name: 'exo_automation_delete',
  description:
    'Löscht eine Automationsregel samt ihrem Lauf-Protokoll. Zum vorübergehenden Abschalten ist ' +
    'exo_automation_update mit enabled: false der richtige Weg.',
  inputSchema: z.object({ ruleId: idSchema }),
  surfaces: ['mcp', 'ai'],
  mutating: true,
  destructive: true,
  irreversible: true,
  target: (input) => `automation:${input.ruleId}`,
  async execute(client, input) {
    const result = await client.request({
      method: 'DELETE',
      path: `/api/automations/${input.ruleId}`,
      responseSchema: deleteAutomationRuleResponseSchema,
    });
    return { text: 'Regel gelöscht.', data: result };
  },
});

export const automationRunsTool: AnyToolDefinition = defineTool({
  name: 'exo_automation_runs',
  description:
    'Zeigt, was die Automationen zuletzt getan haben: Regel, Seite, Ergebnis, Dauer und im ' +
    'Fehlerfall der Grund. Ohne ruleId das Protokoll des ganzen Arbeitsbereichs. Das ist der Weg ' +
    'herauszufinden, warum eine Regel nicht tut, was sie soll.',
  inputSchema: z.object({
    workspaceId: idSchema,
    ruleId: idSchema.optional().describe('Nur die Läufe dieser einen Regel.'),
  }),
  surfaces: ['mcp', 'ai'],
  mutating: false,
  async execute(client, input) {
    const result = await client.request({
      method: 'GET',
      path: `/api/workspaces/${input.workspaceId}/automations/runs`,
      query: { ruleId: input.ruleId },
      responseSchema: automationRunListResponseSchema,
    });
    if (result.runs.length === 0) {
      return { text: 'Keine Läufe aufgezeichnet.', data: result };
    }
    const text = renderMarkdownTable(
      ['Zeitpunkt', 'Regel', 'Seite', 'Auslöser', 'Ergebnis', 'Dauer', 'Fehler'],
      result.runs
        .slice(0, MAX_LISTED_RUNS)
        .map((run) => [
          run.createdAt,
          run.ruleName,
          run.documentTitle ?? '(gelöscht)',
          run.trigger,
          run.status,
          run.durationMs === null ? '' : `${String(run.durationMs)} ms`,
          run.error ?? '',
        ]),
    );
    return { text, data: result };
  },
});

export const automationTriggerTool: AnyToolDefinition = defineTool({
  name: 'exo_automation_trigger',
  description:
    'Löst eine Regel sofort gegen eine Seite aus, ohne die Entprellung abzuwarten. Zum ' +
    'Ausprobieren einer frisch angelegten Regel. Die Antwort enthält nur den eingereihten Lauf; ' +
    'das Ergebnis steht kurz darauf in exo_automation_runs.',
  inputSchema: z.object({
    ruleId: idSchema,
    documentId: idSchema.describe('Die Seite, gegen die die Regel laufen soll.'),
    trigger: automationTriggerSchema.default('DOCUMENT_UPDATED'),
  }),
  surfaces: ['mcp', 'ai'],
  mutating: true,
  // It really does act: a webhook fires, or a model is paid and a comment is
  // written. "Trying it out" is not a read.
  target: (input) => `automation:${input.ruleId}`,
  async execute(client, input) {
    const result = await client.request({
      method: 'POST',
      path: `/api/automations/${input.ruleId}/trigger`,
      body: { documentId: input.documentId, trigger: input.trigger },
      responseSchema: triggerAutomationRuleResponseSchema,
    });
    return {
      text: `Lauf eingereiht (id: ${result.run.id}). Ergebnis gleich über exo_automation_runs.`,
      data: result,
    };
  },
});

export const AUTOMATION_TOOLS: readonly AnyToolDefinition[] = [
  automationListTool,
  automationCreateTool,
  automationUpdateTool,
  automationDeleteTool,
  automationRunsTool,
  automationTriggerTool,
];
