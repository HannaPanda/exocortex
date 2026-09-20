import { type AiProvider } from '@exocortex/ai';
import {
  AUTOMATION_ORIGIN_HEADER,
  type AutomationTrigger,
  commentResponseSchema,
  isWebhookHostAllowed,
  markdownExportResponseSchema,
  markdownImportResponseSchema,
  parseAllowedWebhookHosts,
  type QUEUE_NAMES,
  type Settings,
} from '@exocortex/contracts';
import { type PrismaClient } from '@exocortex/database';
import { type Logger } from '@exocortex/logger';
import { type ExocortexApiClient } from '@exocortex/mcp-tools';
import { type JobContext, type QueueRegistry } from '@exocortex/queue';

import { sendPageToOwner } from './automation/mail';
import { type AutomationRuleRecord, createRunRecorder, loadRule } from './automation/run-recorder';
import { signWebhookBody } from './automation/webhook';
import { createWebhookSender, type WebhookSender } from './automation/webhook-request';

/**
 * Running one automation (issue #50, ADR-024).
 *
 * Everything that *acts* on a rule lives here, and it never throws for a
 * foreseeable outcome. A rule pointing at a host that has gone away, a model
 * that refused, a page deleted between the trigger and the run: all of those are
 * failures of the automation, recorded in its run log, and a BullMQ retry would
 * only repeat them -- or worse, for an AI action, pay for the same prompt twice
 * and write the same comment again.
 *
 * The two actions share a shape on purpose. Both re-read the page rather than
 * trusting the event: the debounce window has swallowed every change after the
 * first, so what matters is what the page says now.
 */

/** The one sender a deployment uses, built once. */
const defaultSender = createWebhookSender();

/** How much of a page's text an AI rule is given. */
const MAX_PAGE_CHARS = 20_000;
/** Cap on the answer. A rule that needs an essay is not a rule. */
const MAX_ANSWER_TOKENS = 1_200;
/** An AI action's own timeout. Nobody is waiting, but nothing may hang. */
const AI_TIMEOUT_MS = 120_000;

export interface AutomationDependencies {
  prisma: PrismaClient;
  /** The deployment's provider. An automation is the deployment's own spend. */
  provider: AiProvider;
  /**
   * An API client acting as a user, optionally stamping the automation origin
   * on every request it makes. `null` when the deployment has no service-token
   * secret, which is the same seam that disables the tool loop.
   */
  apiClientFor:
    ((userId: string, headers?: Readonly<Record<string, string>>) => ExocortexApiClient) | null;
  settings: (workspaceId?: string) => Promise<Settings>;
  /** Fallback model when no rule and no setting name one. */
  defaultModel: string | null;
  /**
   * The deployment's `CREDENTIAL_ENCRYPTION_KEY`, parsed once at boot, or null
   * when it has none. Without it a webhook cannot be signed and the run fails
   * loudly rather than posting unsigned.
   */
  credentialKey: Buffer | null;
  /**
   * The mail queue, for an `EMAIL_SELF` rule (issue #104). The action queues a
   * letter rather than opening an SMTP session here, so a relay having a bad
   * five minutes delays a mail instead of failing a run -- and, five failed
   * runs later, switching a perfectly good rule off.
   */
  queues: QueueRegistry;
  /** Where the link in that mail points. */
  appUrl: string;
  /**
   * How a webhook leaves this process. The default refuses redirects and
   * refuses to connect to an address the deployment may not reach (issue #63);
   * a test injects its own to run a webhook without a network.
   */
  sendWebhook?: WebhookSender;
}

export function createAutomationProcessor(dependencies: AutomationDependencies) {
  return async ({ payload, logger }: JobContext<typeof QUEUE_NAMES.automation>): Promise<void> => {
    const recorder = await createRunRecorder(dependencies.prisma, payload);
    const settings = await dependencies.settings(payload.workspaceId);

    const rule = await loadRule(dependencies.prisma, payload.ruleId);
    const refusal = refuseReason({ rule, settings });
    if (rule === null || refusal !== null) {
      await recorder.skip(refusal ?? 'The rule no longer exists');
      return;
    }

    const started = Date.now();
    try {
      const input = { dependencies, rule, settings, payload, logger };
      const detail = await act(rule.action, input, recorder.runId);
      await recorder.succeed(detail, Date.now() - started);
      await noteSuccess(dependencies.prisma, rule.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await recorder.fail(message, Date.now() - started);
      await noteFailure({
        prisma: dependencies.prisma,
        ruleId: rule.id,
        reason: message,
        limit: settings['automations.maxConsecutiveFailures'],
        logger,
      });
    }
  };
}

/**
 * The one place an action is chosen.
 *
 * A switch over the closed union rather than a chain of ternaries, so a fourth
 * action is a type error here instead of quietly falling into the AI branch --
 * which is what the two-armed conditional this replaced would have done.
 */
async function act(
  action: AutomationRuleRecord['action'],
  input: ActionInput,
  runId: string,
): Promise<Record<string, unknown>> {
  switch (action) {
    case 'WEBHOOK':
      return postWebhook(input);
    case 'AI_RUN':
      return runPrompt(input);
    case 'EMAIL_SELF':
      return sendPageToOwner(
        { dependencies: input.dependencies, rule: input.rule, payload: input.payload },
        runId,
      );
  }
}

/**
 * Why this run must not act, or `null`.
 *
 * Checked again here even though the dispatcher checked most of it: a job sat in
 * a debounce window for up to two minutes, and a rule switched off inside that
 * window must not still fire. The window is exactly long enough for somebody to
 * press the emergency stop and watch it be ignored.
 */
function refuseReason(input: {
  rule: AutomationRuleRecord | null;
  settings: Settings;
}): string | null {
  if (input.rule === null) return 'The rule no longer exists';
  if (!input.settings['automations.enabled']) {
    return 'Automations are switched off for this workspace';
  }
  if (!input.rule.enabled) return 'The rule is switched off';
  if (input.rule.createdById === null) {
    // A rule acts as the person who wrote it. Without one there is no authority
    // to act with, and inventing one would make an automation the one way into
    // this deployment that answers to nobody.
    return 'The rule has no owner to act as';
  }
  return null;
}

export interface ActionInput {
  dependencies: AutomationDependencies;
  rule: AutomationRuleRecord;
  settings: Settings;
  payload: JobContext<typeof QUEUE_NAMES.automation>['payload'];
  logger: Logger;
}

/**
 * A signed POST to the rule's URL.
 *
 * The allowlist is checked here and not only when the rule was written, because
 * narrowing `automations.webhookAllowedHosts` has to stop the rules that already
 * exist -- otherwise the list only governs rules nobody has created yet.
 */
async function postWebhook(input: ActionInput): Promise<Record<string, unknown>> {
  const { rule, settings } = input;
  if (rule.webhookUrl === null) throw new Error('The rule has no target URL');
  const allowed = parseAllowedWebhookHosts(settings['automations.webhookAllowedHosts']);
  if (!isWebhookHostAllowed(rule.webhookUrl, allowed)) {
    throw new Error('The webhook host is no longer on the deployment allowlist');
  }

  const page = await input.dependencies.prisma.document.findUnique({
    where: { id: input.payload.documentId },
    select: { id: true, title: true, type: true, parentId: true },
  });

  // Metadata, never content. A webhook is a message to somebody else's server
  // that a thing happened; what the page says is behind the deployment's own
  // authentication, and the receiver can come and read it if they may.
  const body = JSON.stringify({
    event: 'automation.triggered',
    rule: { id: rule.id, name: rule.name },
    trigger: input.payload.trigger,
    // What started it, which `trigger` alone stopped answering once the clock
    // could: a receiver that acts on the nightly run and ignores the one
    // somebody fired by hand has to be able to tell them apart.
    origin: input.payload.origin,
    workspaceId: input.payload.workspaceId,
    document:
      page === null
        ? { id: input.payload.documentId, deleted: true }
        : { id: page.id, title: page.title, type: page.type, parentId: page.parentId },
    occurredAt: new Date().toISOString(),
    correlationId: input.payload.correlationId,
  });

  const signed = signWebhookBody({ key: input.dependencies.credentialKey, rule, body });
  const send = input.dependencies.sendWebhook ?? defaultSender;
  const response = await send({
    url: rule.webhookUrl,
    headers: { 'content-type': 'application/json', ...signed },
    body,
    timeoutMs: settings['automations.webhookTimeoutSeconds'] * 1_000,
  });

  if (response.status < 200 || response.status >= 300) {
    throw new Error(`The webhook answered ${String(response.status)}`);
  }
  return { status: response.status, url: rule.webhookUrl };
}

/**
 * One prompt against the changed page, written back as a remark.
 *
 * The page's text *is* the input here, which is a deliberate difference from
 * ADR-015: that decision is about the chat quietly sending whatever page happens
 * to be open, and an automation is the opposite -- somebody named this scope and
 * this prompt, in a form, and pressed save. The result is a comment or a child
 * page, never an overwrite: an automation that rewrites content nobody asked it
 * to rewrite is how a page gets quietly destroyed by a rule set up in March.
 */
async function runPrompt(input: ActionInput): Promise<Record<string, unknown>> {
  const { rule, settings, dependencies } = input;
  if (rule.prompt === null) throw new Error('The rule has no prompt');
  if (!settings['ai.enabled']) throw new Error('AI is switched off for this workspace');
  if (dependencies.apiClientFor === null) {
    throw new Error('Automations cannot write: SERVICE_TOKEN_SECRET is not configured');
  }
  const owner = rule.createdById;
  if (owner === null) throw new Error('The rule has no owner to act as');

  // Stamped on every request this action makes, so the write it is about to do
  // cannot trigger this same rule again (issue #50, ADR-024).
  const client = dependencies.apiClientFor(owner, {
    [AUTOMATION_ORIGIN_HEADER]: `${rule.id}:${String(input.payload.depth)}`,
  });

  const page = await client.request({
    method: 'GET',
    path: `/api/documents/${input.payload.documentId}/export/markdown`,
    responseSchema: markdownExportResponseSchema,
  });
  // The export answers with ancestors and children, not with the page's own
  // title. Read separately rather than guessed from `filename`, which is a
  // slug and not a name a model should be shown.
  const titleRow = await dependencies.prisma.document.findUnique({
    where: { id: input.payload.documentId },
    select: { title: true },
  });
  const title = titleRow?.title ?? 'Unbenannt';

  const model =
    rule.modelSlug ?? settings['ai.defaultModelSlug'] ?? dependencies.defaultModel ?? undefined;

  const answer = await dependencies.provider.generate({
    messages: [
      { role: 'system', content: systemPrompt(input.payload.trigger) },
      {
        role: 'user',
        content: [
          rule.prompt,
          '',
          '---',
          `Seite: ${title}`,
          '',
          page.markdown.slice(0, MAX_PAGE_CHARS),
        ].join('\n'),
      },
    ],
    model,
    maxOutputTokens: MAX_ANSWER_TOKENS,
    temperature: 0.2,
    correlationId: input.payload.correlationId,
    timeoutMs: AI_TIMEOUT_MS,
  });

  const text = answer.text.trim();
  if (text.length === 0) throw new Error('The model answered with nothing');

  if (rule.output === 'COMMENT') {
    const created = await client.request({
      method: 'POST',
      path: `/api/documents/${input.payload.documentId}/comments`,
      body: {
        body: `**${rule.name}**\n\n${text}`,
        blockId: null,
        anchorText: null,
        parentId: null,
      },
      responseSchema: commentResponseSchema,
    });
    return { output: 'COMMENT', commentId: created.comment.id, model: model ?? null };
  }

  const created = await client.request({
    method: 'POST',
    path: `/api/workspaces/${input.payload.workspaceId}/import/markdown`,
    body: {
      markdown: text,
      parentId: input.payload.documentId,
      title: `${rule.name}: ${title}`,
    },
    responseSchema: markdownImportResponseSchema,
  });
  return { output: 'CHILD_PAGE', documentId: created.document.id, model: model ?? null };
}

/**
 * What the model is told about its situation.
 *
 * Short, and explicit that it is not writing the page: an automation's answer
 * lands beside the content as a remark, and a model that thinks it is editing
 * writes a replacement instead of an observation.
 */
function systemPrompt(trigger: AutomationTrigger): string {
  const occasion =
    trigger === 'SCHEDULE'
      ? 'weil ein Zeitplan fällig war. Die Seite unten ist dein Material, sie hat sich nicht zwingend geändert.'
      : `weil sich eine Seite geändert hat (Auslöser: ${trigger}).`;
  return [
    'Du bist eine Automation in eXocortex. Eine Regel hat dich ausgelöst,',
    occasion,
    '',
    'Du schreibst die Seite nicht um. Deine Antwort wird als Anmerkung neben der Seite abgelegt.',
    'Antworte knapp und auf Deutsch, ohne Einleitung und ohne Wiederholung der Aufgabe.',
    'Wenn es nichts Erwähnenswertes gibt, sage das in einem Satz.',
    'Keine Gedankenstriche: Punkt, Komma, Doppelpunkt oder Klammern.',
  ].join('\n');
}

/** Clears the failure streak. A rule that worked is not one failure from off. */
async function noteSuccess(prisma: PrismaClient, ruleId: string): Promise<void> {
  await prisma.automationRule.updateMany({
    where: { id: ruleId },
    data: { consecutiveFailures: 0, lastTriggeredAt: new Date() },
  });
}

/**
 * Counts a failure, and switches the rule off once there have been enough.
 *
 * A rule pointing at a host that has gone away does not get better by being
 * retried every minute for a week. It fills the run log, and the one signal
 * that something is wrong drowns in the noise it makes.
 */
async function noteFailure(input: {
  prisma: PrismaClient;
  ruleId: string;
  reason: string;
  limit: number;
  logger: Logger;
}): Promise<void> {
  const updated = await input.prisma.automationRule.update({
    where: { id: input.ruleId },
    data: { consecutiveFailures: { increment: 1 }, lastTriggeredAt: new Date() },
    select: { consecutiveFailures: true },
  });
  if (updated.consecutiveFailures < input.limit) return;

  await input.prisma.automationRule.update({
    where: { id: input.ruleId },
    data: {
      enabled: false,
      disabledAt: new Date(),
      disabledReason: input.reason.slice(0, 500),
    },
  });
  input.logger.warn('Automation rule switched itself off after repeated failures', {
    ruleId: input.ruleId,
    failures: updated.consecutiveFailures,
    reason: input.reason,
  });
}
