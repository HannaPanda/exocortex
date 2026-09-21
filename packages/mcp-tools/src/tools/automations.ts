import { z } from 'zod';

import {
  AUTOMATION_MAX_DEBOUNCE_SECONDS,
  AUTOMATION_MIN_DEBOUNCE_SECONDS,
  automationOutputSchema,
  type AutomationRule,
  automationRuleListResponseSchema,
  automationRuleResponseSchema,
  automationRunListResponseSchema,
  automationScheduleKindSchema,
  automationScheduleTimeSchema,
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
  const action = describeAction(rule);
  const state = rule.enabled
    ? 'an'
    : `aus${rule.disabledReason === null ? '' : ` (${rule.disabledReason})`}`;
  const timing = rule.triggers.includes('SCHEDULE')
    ? `Zeitplan ${describeSchedule(rule)}${rule.nextRunAt === null ? '' : `, nächster Lauf ${rule.nextRunAt}`}`
    : `Entprellung ${String(rule.debounceSeconds)}s`;
  return `${rule.name} [${state}] ${scope}, ${rule.triggers.join('/')}, ${action}, ${timing} (id: ${rule.id})`;
}

/** What the rule does, in one clause. */
function describeAction(rule: AutomationRule): string {
  switch (rule.action) {
    case 'WEBHOOK':
      return `Webhook → ${rule.webhookUrl ?? '?'}`;
    case 'AI_RUN':
      return `KI-Lauf → ${rule.output === 'COMMENT' ? 'Kommentar' : 'Unterseite'}`;
    case 'EMAIL_SELF':
      return `E-Mail an den Besitzer der Regel → „${rule.mailSubject ?? rule.name}"`;
  }
}

/** The schedule in one readable clause, in the zone the rule keeps. */
function describeSchedule(rule: AutomationRule): string {
  const zone = rule.scheduleTimeZone ?? '?';
  switch (rule.scheduleKind) {
    case 'ONCE':
      return `einmalig ${rule.scheduleAt ?? '?'}`;
    case 'DAILY':
      return `täglich ${rule.scheduleTime ?? '?'} (${zone})`;
    case 'WEEKLY':
      return `wöchentlich, Wochentag ${String(rule.scheduleWeekday ?? '?')}, ${rule.scheduleTime ?? '?'} (${zone})`;
    case 'MONTHLY':
      return `monatlich am ${String(rule.scheduleDayOfMonth ?? '?')}., ${rule.scheduleTime ?? '?'} (${zone})`;
    case 'CRON':
      return `cron „${rule.scheduleCron ?? '?'}" (${zone})`;
    default:
      return 'ohne Zeitplan';
  }
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
      'Worauf die Regel reagiert. DATABASE_ROW_CHANGED geht nur im DATABASE-Geltungsbereich. ' +
        'SCHEDULE ist die Uhr statt einer Änderung und steht immer allein; eine solche Regel ' +
        'braucht einen Geltungsbereich mit Seite, weil die Uhr keine Seite nennt.',
    ),
  scheduleKind: automationScheduleKindSchema
    .nullable()
    .default(null)
    .describe('Nur bei SCHEDULE: ONCE, DAILY, WEEKLY, MONTHLY oder CRON.'),
  scheduleAt: z
    .string()
    .nullable()
    .default(null)
    .describe('ONCE: der Zeitpunkt als ISO-8601-Stempel.'),
  scheduleTime: automationScheduleTimeSchema
    .nullable()
    .default(null)
    .describe('DAILY/WEEKLY/MONTHLY: Uhrzeit als HH:MM in der Zeitzone der Regel.'),
  scheduleWeekday: z
    .number()
    .int()
    .min(0)
    .max(6)
    .nullable()
    .default(null)
    .describe('WEEKLY: 0 ist Sonntag, 6 ist Samstag.'),
  scheduleDayOfMonth: z
    .number()
    .int()
    .min(1)
    .max(31)
    .nullable()
    .default(null)
    .describe('MONTHLY: 1 bis 31. Ein zu hoher Wert meint den letzten Tag des Monats.'),
  scheduleCron: z
    .string()
    .nullable()
    .default(null)
    .describe(
      'CRON: fünf numerische Felder (Minute Stunde Tag-im-Monat Monat Wochentag). ' +
        'Keine Namen, kein @daily, kein L oder #.',
    ),
  scheduleTimeZone: z
    .string()
    .nullable()
    .default(null)
    .describe('IANA-Zone, zum Beispiel Europe/Berlin. Bei SCHEDULE Pflicht und nie geraten.'),
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
  mailSubject: z
    .string()
    .min(1)
    .max(200)
    .nullable()
    .default(null)
    .describe(
      'Nur bei EMAIL_SELF: die Betreffzeile. Leer lassen für den Namen der Regel. ' +
        'Eine Empfängeradresse gibt es bewusst nicht: die Mail geht immer an das Konto, ' +
        'dem die Regel gehört.',
    ),
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
  domain: 'automations',
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
    'Legt eine Automationsregel an: „wenn sich hier etwas ändert, dann das tun" oder, mit dem ' +
    'Auslöser SCHEDULE, „jeden Sonntag um 07:00 das tun". Drei Aktionen: ' +
    'WEBHOOK schickt einen signierten POST an eine URL, AI_RUN stellt einen Prompt gegen die ' +
    'geänderte Seite und legt die Antwort als Kommentar oder Unterseite ab, EMAIL_SELF schickt ' +
    'die Seite per Mail an das Konto, dem die Regel gehört, und ausdrücklich an kein anderes: ' +
    'es gibt kein Feld für eine Empfängeradresse. Braucht die ' +
    'OWNER-Rolle im Arbeitsbereich und einen Token mit admin-Rechten. Das Signiergeheimnis eines ' +
    'Webhooks steht genau einmal in dieser Antwort und lässt sich später nicht mehr auslesen.',
  inputSchema: ruleBodySchema.extend({ workspaceId: idSchema }),
  surfaces: ['mcp', 'ai'],
  domain: 'automations',
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
  domain: 'automations',
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
  domain: 'automations',
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
  domain: 'automations',
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
      ['Zeitpunkt', 'Regel', 'Seite', 'Start', 'Ergebnis', 'Dauer', 'Fehler'],
      result.runs
        .slice(0, MAX_LISTED_RUNS)
        .map((run) => [
          run.createdAt,
          run.ruleName,
          run.documentTitle ?? '(gelöscht)',
          run.origin === 'EVENT' ? run.trigger : run.origin,
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
    documentId: idSchema
      .nullable()
      .default(null)
      .describe(
        'Die Seite, gegen die die Regel laufen soll. Bei einer Zeitplan-Regel weglassen: ' +
          'die nimmt ihre eigene Seite.',
      ),
    trigger: automationTriggerSchema.default('DOCUMENT_UPDATED'),
  }),
  surfaces: ['mcp', 'ai'],
  domain: 'automations',
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
