import {
  type EvalAssertion,
  evalAssertionResultSchema,
  evalAssertionSchema,
  type EvalAttempt,
  evalAttemptArtifactsSchema,
  evalAttemptMetricsSchema,
  type EvalCase,
  type EvalCaseDefinition,
  evalCaseDefinitionSchema,
  type EvalFixture,
  evalFixtureSchema,
  type EvalOutcome,
  type EvalReplayMode,
  type EvalRun,
  type EvalVariant,
  evalVariantSchema,
} from '@exocortex/contracts';
import { type Prisma, storedToolDomains } from '@exocortex/database';

/** Prisma's spelling of the replay modes and back. */
export const REPLAY_MODE_TO_PRISMA = {
  read_only: 'READ_ONLY',
  propose: 'PROPOSE',
  fixture: 'FIXTURE',
} as const satisfies Record<EvalReplayMode, string>;
export const REPLAY_MODE_FROM_PRISMA: Record<string, EvalReplayMode> = {
  READ_ONLY: 'read_only',
  PROPOSE: 'propose',
  FIXTURE: 'fixture',
};
export const OUTCOME_TO_PRISMA = {
  passed: 'PASSED',
  failed: 'FAILED',
  invariant_violated: 'INVARIANT_VIOLATED',
  error: 'ERROR',
} as const satisfies Record<EvalOutcome, string>;
const OUTCOME_FROM_PRISMA: Record<string, EvalOutcome> = {
  PASSED: 'passed',
  FAILED: 'failed',
  INVARIANT_VIOLATED: 'invariant_violated',
  ERROR: 'error',
};

const ACCOUNT = { select: { id: true, name: true } } as const;

export const EVAL_CASE_SELECT = {
  id: true,
  workspaceId: true,
  name: true,
  description: true,
  suite: true,
  prompt: true,
  replayMode: true,
  documentId: true,
  fixture: true,
  agentProfileId: true,
  toolDomains: true,
  budgetMicroUsd: true,
  maxToolIterations: true,
  maxRunSeconds: true,
  invariants: true,
  criteria: true,
  expectedOutcome: true,
  sourceRunId: true,
  revision: true,
  createdAt: true,
  updatedAt: true,
  createdBy: ACCOUNT,
  updatedBy: ACCOUNT,
  _count: { select: { attempts: true } },
} satisfies Prisma.EvalCaseSelect;
export type EvalCaseRow = Prisma.EvalCaseGetPayload<{ select: typeof EVAL_CASE_SELECT }>;

/** A stored check list, keeping what still parses: a kind removed later must not break a read. */
export function storedAssertions(value: unknown): EvalAssertion[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const parsed = evalAssertionSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
}

export function storedFixture(value: unknown): EvalFixture | null {
  if (value === null || value === undefined) return null;
  const parsed = evalFixtureSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** What an attempt freezes: the case without who wrote it. */
export function caseDefinition(row: EvalCaseRow): EvalCaseDefinition {
  return {
    name: row.name,
    description: row.description,
    suite: row.suite,
    prompt: row.prompt,
    replayMode: REPLAY_MODE_FROM_PRISMA[row.replayMode] ?? 'read_only',
    documentId: row.documentId,
    fixture: storedFixture(row.fixture),
    agentProfileId: row.agentProfileId,
    toolDomains: storedToolDomains(row.toolDomains),
    budgetMicroUsd: row.budgetMicroUsd,
    maxToolIterations: row.maxToolIterations,
    maxRunSeconds: row.maxRunSeconds,
    invariants: storedAssertions(row.invariants),
    criteria: storedAssertions(row.criteria),
    expectedOutcome: row.expectedOutcome,
  };
}

export function toEvalCase(
  row: EvalCaseRow,
  names: {
    documents: ReadonlyMap<string, string>;
    profiles: ReadonlyMap<string, string>;
    lastAttemptAt: Date | null;
  },
): EvalCase {
  return {
    ...caseDefinition(row),
    id: row.id,
    workspaceId: row.workspaceId,
    revision: row.revision,
    documentTitle: row.documentId === null ? null : (names.documents.get(row.documentId) ?? null),
    agentProfileName:
      row.agentProfileId === null ? null : (names.profiles.get(row.agentProfileId) ?? null),
    sourceRunId: row.sourceRunId,
    attemptCount: row._count.attempts,
    lastAttemptAt: names.lastAttemptAt?.toISOString() ?? null,
    createdBy: row.createdBy,
    updatedBy: row.updatedBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export const EVAL_ATTEMPT_SELECT = {
  id: true,
  evalRunId: true,
  workspaceId: true,
  caseId: true,
  caseRevision: true,
  caseSnapshot: true,
  variant: true,
  variantLabel: true,
  repetition: true,
  position: true,
  status: true,
  outcome: true,
  errorCode: true,
  aiRunId: true,
  conversationId: true,
  sandboxDocumentId: true,
  sandboxPages: true,
  metrics: true,
  assertions: true,
  artifacts: true,
  answer: true,
  reviewVerdict: true,
  reviewScore: true,
  reviewNote: true,
  reviewManual: true,
  reviewedAt: true,
  reviewedBy: ACCOUNT,
  createdAt: true,
  startedAt: true,
  finishedAt: true,
} satisfies Prisma.EvalAttemptSelect;
export type EvalAttemptRow = Prisma.EvalAttemptGetPayload<{ select: typeof EVAL_ATTEMPT_SELECT }>;

/** The snapshot as it was stored; a row older than a field it lacks still reads. */
export function attemptDefinition(row: Pick<EvalAttemptRow, 'caseSnapshot'>): EvalCaseDefinition {
  const parsed = evalCaseDefinitionSchema.safeParse(row.caseSnapshot);
  if (parsed.success) return parsed.data;
  const raw = (row.caseSnapshot ?? {}) as Record<string, unknown>;
  return {
    name: typeof raw.name === 'string' ? raw.name : '?',
    description: null,
    suite: null,
    prompt: typeof raw.prompt === 'string' ? raw.prompt : '',
    replayMode: 'read_only',
    documentId: null,
    fixture: null,
    agentProfileId: null,
    toolDomains: null,
    budgetMicroUsd: null,
    maxToolIterations: null,
    maxRunSeconds: null,
    invariants: [],
    criteria: [],
    expectedOutcome: null,
  };
}

export function attemptVariant(row: Pick<EvalAttemptRow, 'variant'>): EvalVariant {
  const parsed = evalVariantSchema.safeParse(row.variant);
  return parsed.success
    ? parsed.data
    : { modelSlug: '?', reasoningLevel: 'none', providerRouting: null, label: null };
}

export function storedManual(value: unknown): Record<string, boolean | null> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const entries = Object.entries(value as Record<string, unknown>).filter(
    (entry): entry is [string, boolean | null] =>
      typeof entry[1] === 'boolean' || entry[1] === null,
  );
  return Object.fromEntries(entries);
}

export function toEvalAttempt(
  row: EvalAttemptRow,
  options: { includeAnswer: boolean },
): EvalAttempt {
  const definition = attemptDefinition(row);
  const metrics = evalAttemptMetricsSchema.safeParse(row.metrics);
  const artifacts = evalAttemptArtifactsSchema.safeParse(row.artifacts);
  const assertions = Array.isArray(row.assertions)
    ? row.assertions.flatMap((entry) => {
        const parsed = evalAssertionResultSchema.safeParse(entry);
        return parsed.success ? [parsed.data] : [];
      })
    : [];
  const reviewed = row.reviewedAt !== null;
  return {
    id: row.id,
    evalRunId: row.evalRunId,
    caseId: row.caseId,
    caseName: definition.name,
    caseRevision: row.caseRevision,
    replayMode: definition.replayMode,
    variant: attemptVariant(row),
    variantLabel: row.variantLabel,
    repetition: row.repetition,
    status: row.status.toLowerCase() as EvalAttempt['status'],
    outcome: row.outcome === null ? null : (OUTCOME_FROM_PRISMA[row.outcome] ?? null),
    errorCode: row.errorCode,
    aiRunId: row.aiRunId,
    conversationId: row.conversationId,
    metrics: metrics.success ? metrics.data : null,
    assertions,
    answer: options.includeAnswer ? row.answer : null,
    artifacts: options.includeAnswer && artifacts.success ? artifacts.data : null,
    review: reviewed
      ? {
          verdict:
            row.reviewVerdict === null
              ? null
              : (row.reviewVerdict.toLowerCase() as 'passed' | 'failed'),
          score: row.reviewScore,
          note: row.reviewNote,
          reviewedBy: row.reviewedBy,
          reviewedAt: row.reviewedAt!.toISOString(),
        }
      : null,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
  };
}

export const EVAL_RUN_SELECT = {
  id: true,
  workspaceId: true,
  label: true,
  suite: true,
  variants: true,
  repetitions: true,
  sandboxDocumentId: true,
  createdAt: true,
  createdBy: ACCOUNT,
  attempts: {
    select: {
      caseId: true,
      caseSnapshot: true,
      status: true,
      outcome: true,
      metrics: true,
      finishedAt: true,
    },
  },
} satisfies Prisma.EvalRunSelect;
export type EvalRunRow = Prisma.EvalRunGetPayload<{ select: typeof EVAL_RUN_SELECT }>;

export function storedVariants(value: unknown): EvalVariant[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const parsed = evalVariantSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
}

export function toEvalRun(row: EvalRunRow): EvalRun {
  const attempts = row.attempts;
  const count = (predicate: (attempt: (typeof attempts)[number]) => boolean) =>
    attempts.filter(predicate).length;
  const open = attempts.some(
    (attempt) => attempt.status === 'QUEUED' || attempt.status === 'RUNNING',
  );
  const finishedAt = open
    ? null
    : attempts.reduce<Date | null>(
        (latest, attempt) =>
          attempt.finishedAt !== null && (latest === null || attempt.finishedAt > latest)
            ? attempt.finishedAt
            : latest,
        null,
      );
  const cost = attempts.reduce((total, attempt) => {
    const metrics = evalAttemptMetricsSchema.safeParse(attempt.metrics);
    return total + (metrics.success ? (metrics.data.costMicroUsd ?? 0) : 0);
  }, 0);
  const caseNames = new Set(attempts.map((attempt) => attemptDefinition(attempt).name));
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    label: row.label,
    suite: row.suite,
    variants: storedVariants(row.variants),
    repetitions: row.repetitions,
    caseCount: caseNames.size,
    counts: {
      total: attempts.length,
      queued: count((attempt) => attempt.status === 'QUEUED'),
      running: count((attempt) => attempt.status === 'RUNNING'),
      finished: count((attempt) => attempt.status === 'FINISHED'),
      cancelled: count((attempt) => attempt.status === 'CANCELLED'),
      passed: count((attempt) => attempt.outcome === 'PASSED'),
      failed: count((attempt) => attempt.outcome === 'FAILED'),
      invariantViolated: count((attempt) => attempt.outcome === 'INVARIANT_VIOLATED'),
      error: count((attempt) => attempt.outcome === 'ERROR'),
    },
    costMicroUsd: cost,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    finishedAt: finishedAt?.toISOString() ?? null,
  };
}
