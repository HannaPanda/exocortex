import { type AutomationRule, type AutomationRun } from '@exocortex/contracts';
import { type Prisma } from '@exocortex/database';

/**
 * Row shapes to DTOs.
 *
 * Its own file for the reason every mapper here has one: the shape a client
 * sees has to be decided in exactly one place, and the single most important
 * decision in this one is a negative -- `secretCiphertext` is turned into the
 * boolean `hasWebhookSecret` and the ciphertext itself never leaves the server,
 * not even in a shape a later refactor could widen.
 */

export const AUTOMATION_RULE_SELECT = {
  id: true,
  workspaceId: true,
  name: true,
  enabled: true,
  scope: true,
  scopeDocumentId: true,
  scopeDocument: { select: { title: true } },
  triggers: true,
  scheduleKind: true,
  scheduleAt: true,
  scheduleTime: true,
  scheduleWeekday: true,
  scheduleDayOfMonth: true,
  scheduleCron: true,
  scheduleTimeZone: true,
  nextRunAt: true,
  debounceSeconds: true,
  action: true,
  webhookUrl: true,
  secretCiphertext: true,
  prompt: true,
  modelSlug: true,
  output: true,
  consecutiveFailures: true,
  disabledReason: true,
  disabledAt: true,
  lastTriggeredAt: true,
  createdById: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.AutomationRuleSelect;

type AutomationRuleRow = Prisma.AutomationRuleGetPayload<{
  select: typeof AUTOMATION_RULE_SELECT;
}>;

export function mapAutomationRule(row: AutomationRuleRow): AutomationRule {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    enabled: row.enabled,
    scope: row.scope,
    scopeDocumentId: row.scopeDocumentId,
    scopeDocumentTitle: row.scopeDocument?.title ?? null,
    triggers: row.triggers,
    scheduleKind: row.scheduleKind,
    scheduleAt: row.scheduleAt?.toISOString() ?? null,
    scheduleTime: row.scheduleTime,
    scheduleWeekday: row.scheduleWeekday,
    scheduleDayOfMonth: row.scheduleDayOfMonth,
    scheduleCron: row.scheduleCron,
    scheduleTimeZone: row.scheduleTimeZone,
    nextRunAt: row.nextRunAt?.toISOString() ?? null,
    debounceSeconds: row.debounceSeconds,
    action: row.action,
    webhookUrl: row.webhookUrl,
    hasWebhookSecret: row.secretCiphertext !== null,
    prompt: row.prompt,
    modelSlug: row.modelSlug,
    output: row.output,
    consecutiveFailures: row.consecutiveFailures,
    disabledReason: row.disabledReason,
    disabledAt: row.disabledAt?.toISOString() ?? null,
    lastTriggeredAt: row.lastTriggeredAt?.toISOString() ?? null,
    createdById: row.createdById,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export const AUTOMATION_RUN_SELECT = {
  id: true,
  ruleId: true,
  rule: { select: { name: true } },
  documentId: true,
  documentTitle: true,
  trigger: true,
  origin: true,
  status: true,
  depth: true,
  startedAt: true,
  finishedAt: true,
  durationMs: true,
  error: true,
  detail: true,
  createdAt: true,
} satisfies Prisma.AutomationRunSelect;

type AutomationRunRow = Prisma.AutomationRunGetPayload<{ select: typeof AUTOMATION_RUN_SELECT }>;

export function mapAutomationRun(row: AutomationRunRow): AutomationRun {
  return {
    id: row.id,
    ruleId: row.ruleId,
    ruleName: row.rule.name,
    documentId: row.documentId,
    documentTitle: row.documentTitle,
    trigger: row.trigger,
    origin: row.origin,
    status: row.status,
    depth: row.depth,
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    durationMs: row.durationMs,
    error: row.error,
    detail: detailObject(row.detail),
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * A stored `detail` in the object shape the DTO promises, or `null`.
 *
 * A JSON column can hold a number or an array, and a row written by an older
 * version of this code is exactly the kind that does. Answering `null` for
 * anything else keeps the contract honest without a migration.
 */
function detailObject(value: Prisma.JsonValue): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value;
}
