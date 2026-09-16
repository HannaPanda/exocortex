import { z } from 'zod';

import { idSchema, isoDateTimeSchema } from './primitives';

/**
 * Automations: rules that react to page changes (issue #50, ADR-024).
 *
 * A rule is three answers -- where it watches, what it watches for, and what it
 * then does. Everything below is that triple made explicit enough that a person
 * filling in a form and an agent calling a tool describe the same thing.
 */

/** What a rule listens for. Mirrors the `AutomationTrigger` enum. */
export const automationTriggerSchema = z.enum([
  'DOCUMENT_CREATED',
  'DOCUMENT_UPDATED',
  'DOCUMENT_CONTENT_CHANGED',
  'DOCUMENT_MOVED',
  'DOCUMENT_ARCHIVED',
  'DOCUMENT_DELETED',
  'DATABASE_ROW_CHANGED',
]);
export type AutomationTrigger = z.infer<typeof automationTriggerSchema>;

export const automationScopeSchema = z.enum(['WORKSPACE', 'SUBTREE', 'DATABASE']);
export type AutomationScope = z.infer<typeof automationScopeSchema>;

export const automationActionSchema = z.enum(['WEBHOOK', 'AI_RUN']);
export type AutomationAction = z.infer<typeof automationActionSchema>;

export const automationOutputSchema = z.enum(['COMMENT', 'CHILD_PAGE']);
export type AutomationOutput = z.infer<typeof automationOutputSchema>;

export const automationRunStatusSchema = z.enum([
  'PENDING',
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'SKIPPED',
]);
export type AutomationRunStatus = z.infer<typeof automationRunStatusSchema>;

/**
 * The shortest quiet period a rule may ask for, in seconds.
 *
 * Ten seconds is not a performance tuning knob, it is the floor under a cost
 * mistake: a page being typed into is materialized every couple of seconds, and
 * a rule with an AI action and no floor would pay for a model call per
 * paragraph. Anything that genuinely needs to react faster than this wants an
 * event stream, not an automation.
 */
export const AUTOMATION_MIN_DEBOUNCE_SECONDS = 10;
export const AUTOMATION_MAX_DEBOUNCE_SECONDS = 3_600;

/**
 * How many automations deep a chain of writes may go before it stops.
 *
 * A rule whose action writes a page can trigger a rule whose action writes a
 * page. The depth guard is what turns that from an unbounded loop into a
 * bounded one, and it is deliberately small: a chain three deep is already
 * something nobody can reason about, and the honest response to the fourth link
 * is to refuse it and say so in the run log.
 */
export const AUTOMATION_MAX_DEPTH = 3;

/** Header the worker uses to tell the API which rule's action is writing. */
export const AUTOMATION_ORIGIN_HEADER = 'x-exocortex-automation';

/**
 * A URL a webhook may point at.
 *
 * Only the shape is checked here. Whether the *host* is allowed is a deployment
 * decision (`automations.webhookAllowedHosts`) and is checked by the API on
 * write and by the worker on use, because an allowlist can be narrowed after a
 * rule already exists.
 */
export const automationWebhookUrlSchema = z
  .string()
  .url()
  .max(2_000)
  .refine((value) => value.startsWith('https://') || value.startsWith('http://'), {
    message: 'Only http(s) URLs are supported',
  });

/**
 * Splits the `automations.webhookAllowedHosts` setting into hosts.
 *
 * Lower-cased and stripped of anything that is not a host: people write
 * `https://hooks.example.org/` into a field labelled "hosts", and refusing that
 * silently is how an allowlist ends up empty without anybody noticing.
 */
export function parseAllowedWebhookHosts(raw: string): string[] {
  return raw
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const withoutScheme = entry.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
      const withoutPath = withoutScheme.split('/')[0] ?? '';
      // An IPv6 literal keeps its brackets and its colons; anything else loses
      // a trailing port.
      return withoutPath.startsWith('[') ? withoutPath : (withoutPath.split(':')[0] ?? '');
    })
    .filter((entry) => entry.length > 0);
}

/**
 * Whether a URL points at a host the deployment allows.
 *
 * A host matches exactly, or as a subdomain of an allowed host. Nothing is a
 * pattern: `*` is a literal value that will never match, because an allowlist
 * whose entries can be wildcards is one where a typo opens it.
 *
 * Lives in the contracts package because both sides need the identical answer:
 * the API refuses to store a rule pointing somewhere else, and the worker
 * refuses to fire one, since the list can be narrowed after a rule exists.
 */
export function isWebhookHostAllowed(url: string, allowedHosts: readonly string[]): boolean {
  if (allowedHosts.length === 0) return false;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host.length === 0) return false;
  return allowedHosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

/**
 * Why an IP address must not receive a webhook, or `null` (issue #63).
 *
 * The host allowlist answers a different question than this one. It says which
 * *names* a deployment trusts; this says which *addresses* are outside the
 * internet the deployment meant to reach. Both are needed, because a name on
 * the allowlist can resolve into the machine's own network, and then an entry
 * meant to permit one receiver has quietly permitted every internal service.
 *
 * Refused: loopback, the unspecified address, RFC1918 and RFC4193 private
 * space, carrier-grade NAT, link-local, multicast and the reserved ranges. The
 * reason is a sentence rather than a boolean, because it is written into an
 * automation's run log and somebody has to understand it there.
 *
 * Lives in the contracts package so the API can refuse a literal address while
 * a rule is being written and the worker can refuse a resolved one at the
 * moment it connects.
 */
export function disallowedWebhookAddressReason(address: string): string | null {
  const value =
    address.trim().toLowerCase().replace(/^\[/, '').replace(/]$/, '').split('%')[0] ?? '';
  const v4 = parseIpv4(value);
  if (v4 !== null) return refusedIpv4(v4);
  const v6 = parseIpv6(value);
  if (v6 !== null) return refusedIpv6(v6);
  return 'The webhook target is not an IP address';
}

/** Whether a string is an IP literal at all, so a hostname can skip the check. */
export function isIpAddressLiteral(value: string): boolean {
  const bare = value.trim().toLowerCase().replace(/^\[/, '').replace(/]$/, '').split('%')[0] ?? '';
  return parseIpv4(bare) !== null || parseIpv6(bare) !== null;
}

function refusedIpv4(octets: readonly number[]): string | null {
  const [a, b] = [octets[0] ?? 0, octets[1] ?? 0];
  if (a === 0) return 'The webhook target resolves to an unspecified address';
  if (a === 127) return 'The webhook target resolves to a loopback address';
  if (a === 10) return 'The webhook target resolves to a private address';
  if (a === 172 && b >= 16 && b <= 31) return 'The webhook target resolves to a private address';
  if (a === 192 && b === 168) return 'The webhook target resolves to a private address';
  if (a === 169 && b === 254) return 'The webhook target resolves to a link-local address';
  if (a === 100 && b >= 64 && b <= 127)
    return 'The webhook target resolves to a shared NAT address';
  if (a >= 224) return 'The webhook target resolves to a multicast or reserved address';
  return null;
}

function refusedIpv6(groups: readonly number[]): string | null {
  const head = groups.slice(0, 5);
  if (head.every((group) => group === 0)) {
    // ::ffff:a.b.c.d and the deprecated ::a.b.c.d both carry an IPv4 address,
    // and an address that is refused as IPv4 stays refused when it is written
    // this way.
    const isMapped = groups[5] === 0xff_ff;
    if (isMapped || groups[5] === 0) {
      const low = [groups[6] ?? 0, groups[7] ?? 0];
      const v4 = [low[0]! >> 8, low[0]! & 0xff, low[1]! >> 8, low[1]! & 0xff];
      if (groups.every((group) => group === 0)) {
        return 'The webhook target resolves to an unspecified address';
      }
      if (!isMapped && groups[6] === 0 && groups[7] === 1) {
        return 'The webhook target resolves to a loopback address';
      }
      return refusedIpv4(v4);
    }
  }
  const first = groups[0] ?? 0;
  if ((first & 0xff_c0) === 0xfe_80) return 'The webhook target resolves to a link-local address';
  if ((first & 0xfe_00) === 0xfc_00) return 'The webhook target resolves to a private address';
  if ((first & 0xff_00) === 0xff_00) return 'The webhook target resolves to a multicast address';
  return null;
}

function parseIpv4(value: string): number[] | null {
  const parts = value.split('.');
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    octets.push(octet);
  }
  return octets;
}

/** An IPv6 literal expanded to its eight groups, or null when it is not one. */
function parseIpv6(value: string): number[] | null {
  if (!value.includes(':')) return null;
  const halves = value.split('::');
  if (halves.length > 2) return null;
  const head = ipv6Groups(halves[0] ?? '');
  const tail = halves.length === 2 ? ipv6Groups(halves[1] ?? '') : [];
  if (head === null || tail === null) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const missing = 8 - head.length - tail.length;
  if (missing < 1) return null;
  return [...head, ...Array.from({ length: missing }, () => 0), ...tail];
}

function ipv6Groups(part: string): number[] | null {
  if (part.length === 0) return [];
  const chunks = part.split(':');
  const groups: number[] = [];
  for (const [index, chunk] of chunks.entries()) {
    if (index === chunks.length - 1 && chunk.includes('.')) {
      const v4 = parseIpv4(chunk);
      if (v4 === null) return null;
      groups.push((v4[0]! << 8) | v4[1]!, (v4[2]! << 8) | v4[3]!);
      continue;
    }
    if (!/^[0-9a-f]{1,4}$/.test(chunk)) return null;
    groups.push(Number.parseInt(chunk, 16));
  }
  return groups;
}

export const automationRuleSchema = z.object({
  id: idSchema,
  workspaceId: idSchema,
  name: z.string(),
  enabled: z.boolean(),
  scope: automationScopeSchema,
  scopeDocumentId: idSchema.nullable(),
  /** Title of the scope page, for a list that has to read as a sentence. */
  scopeDocumentTitle: z.string().nullable(),
  triggers: z.array(automationTriggerSchema),
  debounceSeconds: z.number().int().positive(),
  action: automationActionSchema,
  webhookUrl: z.string().nullable(),
  /**
   * Whether a signing secret is stored. Never the secret: it is returned once,
   * by `POST`, and this deployment cannot read it back afterwards.
   */
  hasWebhookSecret: z.boolean(),
  prompt: z.string().nullable(),
  modelSlug: z.string().nullable(),
  output: automationOutputSchema,
  consecutiveFailures: z.number().int().nonnegative(),
  /** English, developer-facing; set when the rule switched itself off. */
  disabledReason: z.string().nullable(),
  disabledAt: isoDateTimeSchema.nullable(),
  lastTriggeredAt: isoDateTimeSchema.nullable(),
  createdById: idSchema.nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type AutomationRule = z.infer<typeof automationRuleSchema>;

export const automationRunSchema = z.object({
  id: idSchema,
  ruleId: idSchema,
  ruleName: z.string(),
  documentId: idSchema.nullable(),
  documentTitle: z.string().nullable(),
  trigger: automationTriggerSchema,
  status: automationRunStatusSchema,
  depth: z.number().int().nonnegative(),
  startedAt: isoDateTimeSchema.nullable(),
  finishedAt: isoDateTimeSchema.nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  error: z.string().nullable(),
  /** Small result metadata: an HTTP status, the id of what an AI run wrote. */
  detail: z.record(z.string(), z.unknown()).nullable(),
  createdAt: isoDateTimeSchema,
});
export type AutomationRun = z.infer<typeof automationRunSchema>;

export const automationRuleListResponseSchema = z.object({
  rules: z.array(automationRuleSchema),
  /**
   * Whether automations run at all in this workspace right now
   * (`automations.enabled`, ADR-023). False means every rule below is inert,
   * which a list of cheerfully enabled rules would otherwise not say.
   */
  enabledForWorkspace: z.boolean(),
  /** The hosts a webhook may point at. Empty means webhooks are off. */
  allowedWebhookHosts: z.array(z.string()),
});
export type AutomationRuleListResponse = z.infer<typeof automationRuleListResponseSchema>;

export const automationRunListResponseSchema = z.object({ runs: z.array(automationRunSchema) });
export type AutomationRunListResponse = z.infer<typeof automationRunListResponseSchema>;

/**
 * The fields of a rule a person or an agent writes.
 *
 * Split from the create request so `PATCH` can be the same shape with
 * everything optional, and so the cross-field rules below are written once.
 */
const automationRuleBody = z.object({
  name: z.string().trim().min(1).max(200),
  enabled: z.boolean().default(true),
  scope: automationScopeSchema.default('WORKSPACE'),
  scopeDocumentId: idSchema.nullable().default(null),
  triggers: z.array(automationTriggerSchema).min(1).max(7),
  debounceSeconds: z
    .number()
    .int()
    .min(AUTOMATION_MIN_DEBOUNCE_SECONDS)
    .max(AUTOMATION_MAX_DEBOUNCE_SECONDS)
    .default(60),
  action: automationActionSchema,
  webhookUrl: automationWebhookUrlSchema.nullable().default(null),
  prompt: z.string().trim().min(1).max(4_000).nullable().default(null),
  modelSlug: z.string().trim().min(1).max(200).nullable().default(null),
  output: automationOutputSchema.default('COMMENT'),
});

/**
 * The cross-field rules, applied to a complete rule.
 *
 * Written as one function so create and update cannot disagree: an update is
 * validated against the merged result, never against the patch alone, which is
 * the only way `PATCH { action: 'WEBHOOK' }` on an AI rule can be refused for
 * the right reason.
 */
export function automationRuleProblems(rule: {
  scope: AutomationScope;
  scopeDocumentId: string | null;
  action: AutomationAction;
  webhookUrl: string | null;
  prompt: string | null;
  triggers: readonly AutomationTrigger[];
}): string[] {
  const problems: string[] = [];
  if (rule.scope === 'WORKSPACE' && rule.scopeDocumentId !== null) {
    problems.push('A workspace-wide rule must not name a scope document');
  }
  if (rule.scope !== 'WORKSPACE' && rule.scopeDocumentId === null) {
    problems.push('A subtree or database rule needs a scope document');
  }
  if (rule.action === 'WEBHOOK') {
    if (rule.webhookUrl === null) problems.push('A webhook rule needs a target URL');
    if (rule.prompt !== null) problems.push('A webhook rule has no prompt');
  }
  if (rule.action === 'AI_RUN') {
    if (rule.prompt === null) problems.push('An AI rule needs a prompt');
    if (rule.webhookUrl !== null) problems.push('An AI rule has no target URL');
  }
  if (rule.scope === 'DATABASE' && !rule.triggers.includes('DATABASE_ROW_CHANGED')) {
    problems.push('A database rule that ignores row changes would never fire');
  }
  if (rule.scope !== 'DATABASE' && rule.triggers.includes('DATABASE_ROW_CHANGED')) {
    problems.push('Row changes are only observable inside a database scope');
  }
  return problems;
}

export const createAutomationRuleRequestSchema = automationRuleBody;
export type CreateAutomationRuleRequest = z.infer<typeof createAutomationRuleRequestSchema>;

/**
 * A partial update. Every field optional, including the ones with defaults, so
 * "not mentioned" and "set back to the default" stay different acts.
 */
export const updateAutomationRuleRequestSchema = automationRuleBody.partial();
export type UpdateAutomationRuleRequest = z.infer<typeof updateAutomationRuleRequestSchema>;

export const createAutomationRuleResponseSchema = z.object({
  rule: automationRuleSchema,
  /**
   * The signing secret, in the clear, exactly once. Null for an AI rule.
   *
   * Same bargain as an API token: the receiving end needs it to verify the
   * signature, and a deployment that could hand it back later would be a
   * deployment where one leaked session leaks every webhook's authenticity.
   */
  webhookSecret: z.string().nullable(),
});
export type CreateAutomationRuleResponse = z.infer<typeof createAutomationRuleResponseSchema>;

export const automationRuleResponseSchema = z.object({ rule: automationRuleSchema });
export type AutomationRuleResponse = z.infer<typeof automationRuleResponseSchema>;

export const deleteAutomationRuleResponseSchema = z.object({ deleted: z.literal(true) });
export type DeleteAutomationRuleResponse = z.infer<typeof deleteAutomationRuleResponseSchema>;

/**
 * Firing a rule by hand, against one page.
 *
 * The thing that makes an automation debuggable at all: without it the only way
 * to find out whether a rule works is to change a page and wait for the
 * debounce. It is also the read-write parity the capability rule asks for --
 * an agent that can create a rule but not try it cannot finish the job.
 */
export const triggerAutomationRuleRequestSchema = z.object({
  documentId: idSchema,
  trigger: automationTriggerSchema.default('DOCUMENT_UPDATED'),
});
export type TriggerAutomationRuleRequest = z.infer<typeof triggerAutomationRuleRequestSchema>;

export const triggerAutomationRuleResponseSchema = z.object({
  /** The queued run. Its outcome arrives in the run log, not here. */
  run: automationRunSchema,
});
export type TriggerAutomationRuleResponse = z.infer<typeof triggerAutomationRuleResponseSchema>;

/**
 * The signature headers a webhook POST carries.
 *
 * `sha256=<hex>` over `<timestamp>.<body>`, so a captured body cannot be
 * replayed under a new timestamp. Named here rather than in the worker because
 * the receiving end is somebody else's code and these two strings are the
 * contract with it.
 */
export const AUTOMATION_SIGNATURE_HEADER = 'x-exocortex-signature';
export const AUTOMATION_TIMESTAMP_HEADER = 'x-exocortex-timestamp';
