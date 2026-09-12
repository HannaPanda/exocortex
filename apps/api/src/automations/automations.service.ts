import { randomBytes } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import {
  assertPolicy,
  canManageAutomations,
  canReadWorkspace,
  encryptCredential,
  parseCredentialKey,
  WorkspaceAccessService,
} from '@exocortex/auth';
import { type ApiEnv } from '@exocortex/config';
import {
  type AutomationAction,
  type AutomationOutput,
  type AutomationRule,
  type AutomationRuleListResponse,
  automationRuleProblems,
  type AutomationRunListResponse,
  type AutomationScope,
  type AutomationTrigger,
  type CreateAutomationRuleRequest,
  type CreateAutomationRuleResponse,
  isWebhookHostAllowed,
  parseAllowedWebhookHosts,
  type UpdateAutomationRuleRequest,
} from '@exocortex/contracts';
import { type PrismaClient } from '@exocortex/database';

import { AppError } from '../common/app-error';
import { API_ENV } from '../common/logger.provider';
import { PRISMA } from '../platform/platform-tokens';
import { SettingsService } from '../platform/settings.service';

import {
  AUTOMATION_RULE_SELECT,
  AUTOMATION_RUN_SELECT,
  mapAutomationRule,
  mapAutomationRun,
} from './automation-mapper';

/** Purpose bound into the AES-GCM tag, so a row cannot be reused elsewhere. */
const WEBHOOK_SECRET_PURPOSE = 'automation-webhook';

/** Runs returned by one list call. A log is for reading, not for exporting. */
const MAX_LISTED_RUNS = 100;

/**
 * Automation rules (issue #50, ADR-024).
 *
 * The service owns three things nothing else may decide: who may write a rule
 * (the workspace's OWNER, `canManageAutomations`), where a webhook may point
 * (`automations.webhookAllowedHosts`, checked here *and* again in the worker),
 * and the fact that a signing secret is written once and never read back.
 *
 * It deliberately owns nothing about *running* a rule. Matching an event against
 * a scope happens in the outbox dispatcher and acting happens in the worker,
 * because both are things that must keep working when nobody is holding a
 * request open.
 */
@Injectable()
export class AutomationsService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(API_ENV) private readonly env: ApiEnv,
    private readonly access: WorkspaceAccessService,
    private readonly settings: SettingsService,
  ) {}

  async list(workspaceId: string, userId: string): Promise<AutomationRuleListResponse> {
    const role = await this.access.findRole(workspaceId, userId);
    assertPolicy(canReadWorkspace(role));

    const [rows, settings] = await Promise.all([
      this.prisma.automationRule.findMany({
        where: { workspaceId },
        select: AUTOMATION_RULE_SELECT,
        orderBy: { createdAt: 'desc' },
      }),
      this.settings.getForWorkspace(workspaceId),
    ]);

    return {
      rules: rows.map(mapAutomationRule),
      enabledForWorkspace: settings['automations.enabled'],
      allowedWebhookHosts: parseAllowedWebhookHosts(settings['automations.webhookAllowedHosts']),
    };
  }

  async create(input: {
    workspaceId: string;
    userId: string;
    request: CreateAutomationRuleRequest;
  }): Promise<CreateAutomationRuleResponse> {
    const role = await this.access.findRole(input.workspaceId, input.userId);
    assertPolicy(canManageAutomations(role));

    const request = input.request;
    this.assertCoherent(request);
    await this.assertScopeDocument(input.workspaceId, input.userId, request.scopeDocumentId);
    await this.assertWebhookAllowed(input.workspaceId, request.webhookUrl);

    // The secret exists for exactly as long as this call: it is encrypted into
    // the row, handed back once in the response, and then it is gone from this
    // process. There is no read path for it anywhere in the API.
    const secret = request.action === 'WEBHOOK' ? generateWebhookSecret() : null;
    const encrypted =
      secret === null
        ? null
        : encryptCredential({
            key: this.requireEncryptionKey(),
            purpose: WEBHOOK_SECRET_PURPOSE,
            plaintext: secret,
          });

    const row = await this.prisma.automationRule.create({
      data: {
        workspaceId: input.workspaceId,
        name: request.name,
        enabled: request.enabled,
        scope: request.scope,
        scopeDocumentId: request.scopeDocumentId,
        triggers: request.triggers,
        debounceSeconds: request.debounceSeconds,
        action: request.action,
        webhookUrl: request.webhookUrl,
        secretCiphertext: encrypted?.ciphertext ?? null,
        secretIv: encrypted?.iv ?? null,
        secretAuthTag: encrypted?.authTag ?? null,
        secretKeyVersion: encrypted?.keyVersion ?? null,
        prompt: request.prompt,
        modelSlug: request.modelSlug,
        output: request.output,
        createdById: input.userId,
      },
      select: AUTOMATION_RULE_SELECT,
    });

    return { rule: mapAutomationRule(row), webhookSecret: secret };
  }

  /**
   * Applies a patch to a rule.
   *
   * The patch is merged onto the stored row *before* it is checked, never
   * validated on its own. `PATCH { action: 'AI_RUN' }` against a webhook rule
   * has to fail for the right reason -- "an AI rule needs a prompt" -- and a
   * check that only ever sees the patch cannot say that.
   */
  async update(input: {
    ruleId: string;
    userId: string;
    request: UpdateAutomationRuleRequest;
  }): Promise<AutomationRule> {
    const { row } = await this.requireManageableRule(input.ruleId, input.userId);
    const merged = { ...mergeableFields(row), ...stripUndefined(input.request) };

    // Turning an AI rule into a webhook rule is refused rather than supported.
    // A webhook needs a signing secret, a secret is handed over exactly once at
    // creation, and a PATCH response is not a place to hand one over: the
    // caller would end up with a rule that posts unsigned, or with a secret in
    // a response they were not expecting to have to keep.
    if (merged.action === 'WEBHOOK' && row.action === 'AI_RUN') {
      throw AppError.validation(
        'An AI rule cannot become a webhook rule; create a webhook rule instead, so its signing secret can be handed over once',
      );
    }

    this.assertCoherent(merged);
    await this.assertScopeDocument(row.workspaceId, input.userId, merged.scopeDocumentId);
    await this.assertWebhookAllowed(row.workspaceId, merged.webhookUrl);

    // Switching a rule back on clears the automatic disabling with it. Anything
    // else would mean a rule the person just enabled stays one failure away
    // from switching itself off again, for a reason from last month.
    const reenabled = merged.enabled && !row.enabled;

    const updated = await this.prisma.automationRule.update({
      where: { id: input.ruleId },
      data: {
        ...merged,
        ...(reenabled ? { consecutiveFailures: 0, disabledReason: null, disabledAt: null } : {}),
        // A webhook rule turned into an AI rule keeps no secret it cannot use.
        ...(merged.action === 'AI_RUN' && row.action === 'WEBHOOK'
          ? {
              secretCiphertext: null,
              secretIv: null,
              secretAuthTag: null,
              secretKeyVersion: null,
            }
          : {}),
      },
      select: AUTOMATION_RULE_SELECT,
    });
    return mapAutomationRule(updated);
  }

  async remove(ruleId: string, userId: string): Promise<void> {
    await this.requireManageableRule(ruleId, userId);
    await this.prisma.automationRule.delete({ where: { id: ruleId } });
  }

  /**
   * The run log of one workspace, or of one rule inside it.
   *
   * Membership is enough to read it. What an automation has been doing to the
   * pages people work on is not a secret from those people, and a log only the
   * owner can open is a log nobody looks at until something has gone wrong for
   * a week.
   */
  async listRuns(input: {
    workspaceId: string;
    userId: string;
    ruleId?: string;
  }): Promise<AutomationRunListResponse> {
    const role = await this.access.findRole(input.workspaceId, input.userId);
    assertPolicy(canReadWorkspace(role));

    const rows = await this.prisma.automationRun.findMany({
      where: { workspaceId: input.workspaceId, ...(input.ruleId ? { ruleId: input.ruleId } : {}) },
      select: AUTOMATION_RUN_SELECT,
      orderBy: { createdAt: 'desc' },
      take: MAX_LISTED_RUNS,
    });
    return { runs: rows.map(mapAutomationRun) };
  }

  private async requireManageableRule(ruleId: string, userId: string) {
    const row = await this.prisma.automationRule.findUnique({
      where: { id: ruleId },
      select: AUTOMATION_RULE_SELECT,
    });
    if (row === null) throw AppError.notFound('The automation rule');
    const role = await this.access.findRole(row.workspaceId, userId);
    assertPolicy(canManageAutomations(role));
    return { row };
  }

  /** Turns the shared cross-field rules into one validation error. */
  private assertCoherent(rule: Parameters<typeof automationRuleProblems>[0]): void {
    const problems = automationRuleProblems(rule);
    if (problems.length > 0) {
      throw AppError.validation(problems.join('; '), { problems });
    }
  }

  /**
   * The scope page has to exist, be readable by the caller, and belong to this
   * workspace.
   *
   * The last of the three is the one that matters: without it a rule in a
   * workspace somebody owns could be pointed at a subtree in one they merely
   * read, and every page under it would start feeding a webhook they control.
   */
  private async assertScopeDocument(
    workspaceId: string,
    userId: string,
    scopeDocumentId: string | null,
  ): Promise<void> {
    if (scopeDocumentId === null) return;
    const context = await this.access.findDocumentContext(scopeDocumentId, userId);
    if (context === null || context.workspaceId !== workspaceId) {
      throw new AppError('document_access_denied', 'The scope page is not accessible');
    }
  }

  /**
   * Where a webhook may point.
   *
   * Checked here so a rule cannot be stored pointing somewhere it may not go,
   * and checked again in the worker because this list can be narrowed after the
   * rule exists -- narrowing it has to stop the rules that are already running,
   * not just the ones nobody has written yet.
   */
  private async assertWebhookAllowed(workspaceId: string, url: string | null): Promise<void> {
    if (url === null) return;
    const settings = await this.settings.getForWorkspace(workspaceId);
    const allowed = parseAllowedWebhookHosts(settings['automations.webhookAllowedHosts']);
    if (!isWebhookHostAllowed(url, allowed)) {
      throw AppError.validation(
        'The webhook host is not on this deployment’s allowlist (automations.webhookAllowedHosts)',
        { allowedHosts: allowed },
      );
    }
  }

  private requireEncryptionKey(): Buffer {
    const key = parseCredentialKey(this.env.CREDENTIAL_ENCRYPTION_KEY);
    if (key === null) {
      throw new AppError(
        'credential_storage_unavailable',
        'This deployment has no CREDENTIAL_ENCRYPTION_KEY, so a webhook signing secret cannot be stored',
      );
    }
    return key;
  }
}

/** 32 bytes, the block size HMAC-SHA256 is keyed with. */
function generateWebhookSecret(): string {
  return `exoa_${randomBytes(32).toString('base64url')}`;
}

/**
 * The stored fields a patch may overwrite, in DTO shape.
 *
 * Typed against the contract's unions rather than Prisma's: the two are the
 * same set of strings by construction (the enum and the zod enum are written
 * side by side), and naming the contract here is what makes a divergence a
 * compile error instead of a silent widening.
 */
function mergeableFields(row: {
  name: string;
  enabled: boolean;
  scope: AutomationScope;
  scopeDocumentId: string | null;
  triggers: AutomationTrigger[];
  debounceSeconds: number;
  action: AutomationAction;
  webhookUrl: string | null;
  prompt: string | null;
  modelSlug: string | null;
  output: AutomationOutput;
}) {
  return {
    name: row.name,
    enabled: row.enabled,
    scope: row.scope,
    scopeDocumentId: row.scopeDocumentId,
    triggers: row.triggers,
    debounceSeconds: row.debounceSeconds,
    action: row.action,
    webhookUrl: row.webhookUrl,
    prompt: row.prompt,
    modelSlug: row.modelSlug,
    output: row.output,
  };
}

/**
 * Drops the keys a zod `.partial()` left as `undefined`.
 *
 * Without this, spreading a patch over the stored row would blank every field
 * the caller did not mention, which is the difference between a PATCH and a
 * very destructive PUT.
 */
function stripUndefined<TValue extends object>(value: TValue): Partial<TValue> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as Partial<TValue>;
}
