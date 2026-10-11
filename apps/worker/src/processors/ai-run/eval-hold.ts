import {
  type AiWriteMode,
  evalCaseDefinitionSchema,
  evalReplayWriteMode,
  evalVariantSchema,
  type ProviderRoutingOverride,
  stricterLimit,
  type ToolDomain,
} from '@exocortex/contracts';
import { type AiRun, type PrismaClient } from '@exocortex/database';

/**
 * What holds a run that is an eval attempt (issue #146, ADR-074).
 *
 * Read from the attempt's frozen case when the run starts, never from the job
 * payload, for the reason the write mode and the profile are (ADR-070,
 * ADR-071): nothing a request carried may loosen it. Every part is laid over
 * what the run is held to anyway by taking the stricter, so an eval can make
 * a run more careful than the workspace and never less.
 */
export interface EvalHold {
  attemptId: string;
  writeMode: AiWriteMode;
  /** The case's profile, already checked to exist in the run's workspace; null for none. */
  agentProfileId: string | null;
  toolDomains: readonly ToolDomain[] | null;
  budgetMicroUsd: number | null;
  maxToolIterations: number | null;
  maxRunSeconds: number | null;
  /** The variant's provider preference, laid over the profile's. */
  providerRouting: ProviderRoutingOverride | null;
  /** `fixture`: the sandbox page the run's credential is confined to. */
  pageRootId: string | null;
}

/** Why an eval run is refused before it starts. Each one fails closed. */
export type EvalHoldRefusal =
  | 'attempt_missing'
  | 'attempt_not_running'
  | 'snapshot_invalid'
  | 'profile_missing'
  | 'sandbox_missing';

export type EvalHoldResult =
  | { kind: 'none' }
  | { kind: 'held'; hold: EvalHold }
  | { kind: 'refused'; reason: EvalHoldRefusal };

export async function resolveEvalHold(input: {
  prisma: PrismaClient;
  run: Pick<AiRun, 'id' | 'evalAttemptId' | 'workspaceId'>;
}): Promise<EvalHoldResult> {
  const { prisma, run } = input;
  if (run.evalAttemptId === null) return { kind: 'none' };

  const attempt = await prisma.evalAttempt.findUnique({
    where: { id: run.evalAttemptId },
    select: {
      id: true,
      workspaceId: true,
      status: true,
      aiRunId: true,
      caseSnapshot: true,
      variant: true,
      sandboxDocumentId: true,
    },
  });
  // A run that says it is an attempt and has none is not an ordinary run: it
  // would run without the limits its case put on it.
  if (attempt === null || attempt.workspaceId !== run.workspaceId) {
    return { kind: 'refused', reason: 'attempt_missing' };
  }
  if (attempt.status !== 'RUNNING' || (attempt.aiRunId !== null && attempt.aiRunId !== run.id)) {
    return { kind: 'refused', reason: 'attempt_not_running' };
  }
  const definition = evalCaseDefinitionSchema.safeParse(attempt.caseSnapshot);
  const variant = evalVariantSchema.safeParse(attempt.variant);
  if (!definition.success || !variant.success) {
    return { kind: 'refused', reason: 'snapshot_invalid' };
  }
  const snapshot = definition.data;

  if (snapshot.agentProfileId !== null) {
    const profile = await prisma.agentProfile.findUnique({
      where: { id: snapshot.agentProfileId },
      select: { workspaceId: true },
    });
    if (profile === null || profile.workspaceId !== run.workspaceId) {
      return { kind: 'refused', reason: 'profile_missing' };
    }
  }

  let pageRootId: string | null = null;
  if (snapshot.replayMode === 'fixture') {
    if (attempt.sandboxDocumentId === null) return { kind: 'refused', reason: 'sandbox_missing' };
    const sandbox = await prisma.document.findUnique({
      where: { id: attempt.sandboxDocumentId },
      select: { workspaceId: true },
    });
    if (sandbox === null || sandbox.workspaceId !== run.workspaceId) {
      return { kind: 'refused', reason: 'sandbox_missing' };
    }
    pageRootId = attempt.sandboxDocumentId;
  }

  return {
    kind: 'held',
    hold: {
      attemptId: attempt.id,
      writeMode: evalReplayWriteMode(snapshot.replayMode),
      agentProfileId: snapshot.agentProfileId,
      toolDomains: snapshot.toolDomains,
      budgetMicroUsd: snapshot.budgetMicroUsd,
      maxToolIterations: snapshot.maxToolIterations,
      maxRunSeconds: snapshot.maxRunSeconds,
      providerRouting: variant.data.providerRouting,
      pageRootId,
    },
  };
}

/** The run's limits with the case's laid over them: each the stricter of the two. */
export function evalLimits(
  hold: EvalHold | null,
  base: { budgetMicroUsd: number; maxToolIterations: number; runBudgetMs: number },
): { budgetMicroUsd: number; maxToolIterations: number; runBudgetMs: number } {
  if (hold === null) return base;
  return {
    budgetMicroUsd: stricterLimit(base.budgetMicroUsd, hold.budgetMicroUsd)!,
    maxToolIterations: stricterLimit(base.maxToolIterations, hold.maxToolIterations)!,
    runBudgetMs: stricterLimit(
      base.runBudgetMs,
      hold.maxRunSeconds === null ? null : hold.maxRunSeconds * 1_000,
    )!,
  };
}

/**
 * The domains a run may use once the case has had its say: the intersection
 * with whatever the profile allowed, plus what the run cannot do without.
 * Null only when neither names any.
 */
export function evalToolDomains(
  allowed: readonly ToolDomain[] | null,
  hold: EvalHold | null,
  required: readonly ToolDomain[],
): ToolDomain[] | null {
  if (hold?.toolDomains == null) return allowed === null ? null : [...allowed];
  const own = new Set<ToolDomain>(['core', ...hold.toolDomains, ...required]);
  const narrowed = allowed === null ? [...own] : allowed.filter((domain) => own.has(domain));
  return [...new Set(narrowed)];
}

/**
 * The variant's provider keys over the profile's: a key the variant names
 * replaces the profile's, `null` removes it, an absent one inherits (ADR-063).
 */
export function evalProviderRouting(
  profileRouting: ProviderRoutingOverride | null,
  hold: EvalHold | null,
): ProviderRoutingOverride | null {
  if (hold?.providerRouting == null) return profileRouting;
  return { ...profileRouting, ...hold.providerRouting };
}
