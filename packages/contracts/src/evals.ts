import { z } from 'zod';

import { toolDomainSchema } from './agent-profiles';
import { aiReasoningLevelSchema } from './ai-models';
import { type AiWriteMode } from './ai-trust';
import { idSchema, isoDateTimeSchema } from './primitives';
import { providerRoutingOverrideSchema } from './provider-routing';

/**
 * Agent evals (issue #146, ADR-074).
 *
 * An eval case is a task the built-in AI has to do, stored so it can be done
 * again: the prompt, where it starts, what holds it, and what has to be true
 * afterwards. An eval run replays one or more cases against several variants
 * (a model, a reasoning level, a provider preference), each a number of
 * times, and every replay is an attempt: one ordinary run of the built-in AI
 * whose numbers and checks are frozen onto the attempt when it ends.
 *
 * The replay never writes to anything a person uses. Which of the three ways
 * it keeps that promise is the case's `replayMode`, and it is always explicit:
 *
 * - `read_only`: the run works on the real pages and may change nothing.
 * - `propose`: the run may propose changes; they are kept as evidence and
 *   rejected when the attempt ends, and applying one is refused meanwhile.
 * - `fixture`: the case carries its own pages, copied into a sandbox for each
 *   attempt; the run writes directly but its credential reaches only that
 *   sandbox, which is deleted once its final text has been kept.
 */

export const EVAL_REPLAY_MODES = ['read_only', 'propose', 'fixture'] as const;
export const evalReplayModeSchema = z.enum(EVAL_REPLAY_MODES);
export type EvalReplayMode = z.infer<typeof evalReplayModeSchema>;

/** The write mode a replay mode holds its runs to; the strictest of the others still wins. */
export function evalReplayWriteMode(mode: EvalReplayMode): AiWriteMode {
  if (mode === 'read_only') return 'read_only';
  if (mode === 'propose') return 'propose';
  return 'direct';
}

export const EVAL_LIMITS = {
  nameMaxChars: 120,
  descriptionMaxChars: 2_000,
  promptMaxChars: 20_000,
  suiteMaxChars: 60,
  expectedOutcomeMaxChars: 4_000,
  maxAssertions: 30,
  assertionTextMaxChars: 500,
  patternMaxChars: 200,
  maxFixturePages: 20,
  fixtureMarkdownMaxChars: 100_000,
  fixtureTotalMaxChars: 300_000,
  maxVariants: 6,
  maxRepetitions: 5,
  maxCasesPerRun: 20,
  minRunSeconds: 30,
  maxRunSeconds: 3_600,
  /** The longest a `max_duration` check may allow: one day. */
  maxDurationCheckSeconds: 86_400,
  /** Cases times variants times repetitions; every one is a paid run. */
  maxAttemptsPerRun: 60,
  reviewNoteMaxChars: 4_000,
  maxComparedRuns: 5,
  maxImportCases: 50,
} as const;

/** Millionths of a dollar, the unit every cost column uses. */
const budgetSchema = z.number().int().min(0).max(1_000_000_000);
const assertionIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, 'lowercase letters, digits, "_" and "-"');
const fixtureKeySchema = assertionIdSchema;
const assertionTextSchema = z.string().min(1).max(EVAL_LIMITS.assertionTextMaxChars);
const toolNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^exo_[a-z0-9_]+$/, 'a tool name such as exo_page_read');
const countSchema = z.number().int().min(0).max(100_000);

/** Regex flags an answer pattern may use. `g` is implied by counting, `y` and `u` make no sense here. */
const patternFlagsSchema = z
  .string()
  .max(3)
  .regex(/^[ims]*$/, 'only i, m and s');

/**
 * What has to be true after an attempt. Closed: a new kind is a member here,
 * a branch in the evaluator (`apps/api/src/evals/eval-assertions.ts`) and its
 * words in the `evals` message namespace.
 *
 * Every kind but `manual` is decided by eXocortex from what the attempt left
 * behind; `manual` is a sentence a person answers when reviewing.
 */
export const evalAssertionSchema = z.discriminatedUnion('kind', [
  z.object({
    id: assertionIdSchema,
    kind: z.literal('answer_contains'),
    text: assertionTextSchema,
    caseSensitive: z.boolean().default(false),
  }),
  z.object({
    id: assertionIdSchema,
    kind: z.literal('answer_excludes'),
    text: assertionTextSchema,
    caseSensitive: z.boolean().default(false),
  }),
  z.object({
    id: assertionIdSchema,
    kind: z.literal('answer_matches'),
    /** Counted over the whole answer; `min` and `max` bound the number of matches. */
    pattern: z.string().min(1).max(EVAL_LIMITS.patternMaxChars),
    flags: patternFlagsSchema.default(''),
    min: countSchema.default(1),
    max: countSchema.nullable().default(null),
  }),
  z.object({
    id: assertionIdSchema,
    kind: z.literal('tool_called'),
    tool: toolNameSchema,
    min: countSchema.default(1),
    max: countSchema.nullable().default(null),
  }),
  z.object({ id: assertionIdSchema, kind: z.literal('tool_not_called'), tool: toolNameSchema }),
  z.object({ id: assertionIdSchema, kind: z.literal('max_tool_calls'), max: countSchema }),
  z.object({ id: assertionIdSchema, kind: z.literal('max_failed_tool_calls'), max: countSchema }),
  z.object({ id: assertionIdSchema, kind: z.literal('max_cost'), maxMicroUsd: budgetSchema }),
  z.object({
    id: assertionIdSchema,
    kind: z.literal('max_duration'),
    maxSeconds: z.number().int().min(1).max(EVAL_LIMITS.maxDurationCheckSeconds),
  }),
  /**
   * Nothing was changed: no change proposed, no fixture page different, no
   * page created in the sandbox. The issue's "verändert keine Dateien".
   */
  z.object({ id: assertionIdSchema, kind: z.literal('no_changes') }),
  /** `fixture` only: the final text of one fixture page. */
  z.object({
    id: assertionIdSchema,
    kind: z.literal('page_contains'),
    page: fixtureKeySchema,
    text: assertionTextSchema,
    caseSensitive: z.boolean().default(false),
  }),
  z.object({
    id: assertionIdSchema,
    kind: z.literal('page_excludes'),
    page: fixtureKeySchema,
    text: assertionTextSchema,
    caseSensitive: z.boolean().default(false),
  }),
  /** `fixture` only: pages the run created inside the sandbox. */
  z.object({
    id: assertionIdSchema,
    kind: z.literal('pages_created'),
    min: countSchema.default(0),
    max: countSchema.nullable().default(null),
  }),
  /** `propose` only: proposed changes, over every changeset the run handed in or left as a draft. */
  z.object({
    id: assertionIdSchema,
    kind: z.literal('proposed_changes'),
    min: countSchema.default(1),
    max: countSchema.nullable().default(null),
  }),
  z.object({ id: assertionIdSchema, kind: z.literal('manual'), text: assertionTextSchema }),
]);
export type EvalAssertion = z.infer<typeof evalAssertionSchema>;
export type EvalAssertionInput = z.input<typeof evalAssertionSchema>;
export type EvalAssertionKind = EvalAssertion['kind'];

/** Kinds that only mean something in one replay mode. */
export const EVAL_ASSERTION_MODES: Partial<Record<EvalAssertionKind, EvalReplayMode>> = {
  page_contains: 'fixture',
  page_excludes: 'fixture',
  pages_created: 'fixture',
  proposed_changes: 'propose',
};

/** One page an eval case brings along; `parentKey` nests it under another of its pages. */
export const evalFixturePageSchema = z.object({
  key: fixtureKeySchema,
  title: z.string().trim().min(1).max(300),
  markdown: z.string().max(EVAL_LIMITS.fixtureMarkdownMaxChars),
  parentKey: fixtureKeySchema.nullable().default(null),
});
export type EvalFixturePage = z.infer<typeof evalFixturePageSchema>;

/** The pages of a `fixture` case and the one the run starts on (none: it starts on the sandbox). */
export const evalFixtureSchema = z.object({
  pages: z.array(evalFixturePageSchema).min(1).max(EVAL_LIMITS.maxFixturePages),
  startKey: fixtureKeySchema.nullable().default(null),
});
export type EvalFixture = z.infer<typeof evalFixtureSchema>;
export type EvalFixtureInput = z.input<typeof evalFixtureSchema>;

/**
 * What is wrong with a fixture, or null. Keys unique, parents known and above
 * their children, the start page one of them, the text within its budget.
 */
export function fixtureProblem(fixture: EvalFixture): string | null {
  const keys = new Set<string>();
  let total = 0;
  for (const page of fixture.pages) {
    if (keys.has(page.key)) return `duplicate page key "${page.key}"`;
    if (page.parentKey !== null && !keys.has(page.parentKey)) {
      return `page "${page.key}" names a parent that is not listed before it`;
    }
    keys.add(page.key);
    total += page.markdown.length;
  }
  if (total > EVAL_LIMITS.fixtureTotalMaxChars) return 'the fixture pages are too long together';
  if (fixture.startKey !== null && !keys.has(fixture.startKey)) {
    return `the start page "${fixture.startKey}" is not one of the pages`;
  }
  return null;
}

/**
 * What is wrong with a case's checks given its mode and pages, or null.
 * Shared by the contract's refinement and the service, so the browser can say
 * it before the request is sent.
 */
export function assertionsProblem(input: {
  replayMode: EvalReplayMode;
  fixture: EvalFixture | null;
  assertions: readonly EvalAssertion[];
}): string | null {
  const ids = new Set<string>();
  const pageKeys = new Set((input.fixture?.pages ?? []).map((page) => page.key));
  for (const assertion of input.assertions) {
    if (ids.has(assertion.id)) return `duplicate check id "${assertion.id}"`;
    ids.add(assertion.id);
    const only = EVAL_ASSERTION_MODES[assertion.kind];
    if (only !== undefined && only !== input.replayMode) {
      return `the check "${assertion.id}" (${assertion.kind}) needs the ${only} mode`;
    }
    if (
      (assertion.kind === 'page_contains' || assertion.kind === 'page_excludes') &&
      !pageKeys.has(assertion.page)
    ) {
      return `the check "${assertion.id}" names the page "${assertion.page}", which the fixture does not have`;
    }
    if (assertion.kind === 'answer_matches') {
      try {
        new RegExp(assertion.pattern, assertion.flags);
      } catch {
        return `the check "${assertion.id}" has a pattern that does not compile`;
      }
    }
    if (
      'max' in assertion &&
      'min' in assertion &&
      assertion.max !== null &&
      assertion.max < assertion.min
    ) {
      return `the check "${assertion.id}" has max below min`;
    }
  }
  return null;
}

const nameSchema = z.string().trim().min(1).max(EVAL_LIMITS.nameMaxChars);
const descriptionSchema = z.string().trim().max(EVAL_LIMITS.descriptionMaxChars);
const promptSchema = z.string().trim().min(1).max(EVAL_LIMITS.promptMaxChars);
const suiteSchema = z
  .string()
  .trim()
  .min(1)
  .max(EVAL_LIMITS.suiteMaxChars)
  .regex(/^[\p{L}\p{N}][\p{L}\p{N} _.-]*$/u, 'letters, digits, space, "_", "." and "-"');
const expectedOutcomeSchema = z.string().trim().max(EVAL_LIMITS.expectedOutcomeMaxChars);
const assertionsSchema = z.array(evalAssertionSchema).max(EVAL_LIMITS.maxAssertions);
const toolDomainsSchema = z.array(toolDomainSchema).max(40);
const iterationsSchema = z.number().int().min(1).max(100);
const runSecondsSchema = z
  .number()
  .int()
  .min(EVAL_LIMITS.minRunSeconds)
  .max(EVAL_LIMITS.maxRunSeconds);

const accountSchema = z.object({ id: idSchema, name: z.string().nullable() });

/**
 * Everything that defines what an attempt does, and nothing about who wrote
 * it. Frozen onto every attempt, so a case edited later does not rewrite what
 * an older attempt was measured against.
 */
export const evalCaseDefinitionSchema = z.object({
  name: z.string(),
  description: z.string().nullable(),
  suite: z.string().nullable(),
  prompt: z.string(),
  replayMode: evalReplayModeSchema,
  /** `read_only` and `propose`: the real page the run stands on, if any. */
  documentId: idSchema.nullable(),
  /** `fixture`: the pages it brings. */
  fixture: evalFixtureSchema.nullable(),
  /** Null: no profile, the run is a plain turn of the assistant. */
  agentProfileId: idSchema.nullable(),
  /** Narrows further than the profile; null leaves the profile's (or every) domain. */
  toolDomains: z.array(toolDomainSchema).nullable(),
  budgetMicroUsd: z.number().int().nullable(),
  maxToolIterations: z.number().int().nullable(),
  maxRunSeconds: z.number().int().nullable(),
  /** Broken, the attempt fails whatever else went well. */
  invariants: z.array(evalAssertionSchema),
  /** What success means. */
  criteria: z.array(evalAssertionSchema),
  /** What a good result looks like, in words, for the person reviewing. */
  expectedOutcome: z.string().nullable(),
});
export type EvalCaseDefinition = z.infer<typeof evalCaseDefinitionSchema>;

export const evalCaseSchema = evalCaseDefinitionSchema.extend({
  id: idSchema,
  workspaceId: idSchema,
  revision: z.number().int(),
  /** Title of the start page; null when there is none or it is gone. */
  documentTitle: z.string().nullable(),
  agentProfileName: z.string().nullable(),
  /** The real run this case was taken from, when it was. */
  sourceRunId: idSchema.nullable(),
  attemptCount: z.number().int(),
  lastAttemptAt: isoDateTimeSchema.nullable(),
  createdBy: accountSchema.nullable(),
  updatedBy: accountSchema.nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type EvalCase = z.infer<typeof evalCaseSchema>;

/** Cross-field rules every write of a case has to keep. */
function refineCase(
  value: {
    replayMode?: EvalReplayMode;
    documentId?: string | null;
    fixture?: EvalFixture | null;
    invariants?: EvalAssertion[];
    criteria?: EvalAssertion[];
  },
  context: z.RefinementCtx,
): void {
  if (value.replayMode === undefined) return;
  const fixture = value.fixture ?? null;
  if (value.replayMode === 'fixture' && fixture === null) {
    context.addIssue({ code: 'custom', path: ['fixture'], message: 'fixture mode needs pages' });
    return;
  }
  if (value.replayMode !== 'fixture' && fixture !== null) {
    context.addIssue({
      code: 'custom',
      path: ['fixture'],
      message: 'pages belong to the fixture mode',
    });
    return;
  }
  if (value.replayMode === 'fixture' && value.documentId != null) {
    context.addIssue({
      code: 'custom',
      path: ['documentId'],
      message: 'a fixture case starts on one of its own pages',
    });
    return;
  }
  const fixtureProblemText = fixture === null ? null : fixtureProblem(fixture);
  if (fixtureProblemText !== null) {
    context.addIssue({ code: 'custom', path: ['fixture'], message: fixtureProblemText });
    return;
  }
  if (value.invariants !== undefined && value.criteria !== undefined) {
    const problem = assertionsProblem({
      replayMode: value.replayMode,
      fixture,
      assertions: [...value.invariants, ...value.criteria],
    });
    if (problem !== null)
      context.addIssue({ code: 'custom', path: ['criteria'], message: problem });
  }
}

const caseFieldsSchema = z.object({
  name: nameSchema,
  description: descriptionSchema.nullable().optional(),
  suite: suiteSchema.nullable().optional(),
  prompt: promptSchema,
  replayMode: evalReplayModeSchema,
  documentId: idSchema.nullable().optional(),
  fixture: evalFixtureSchema.nullable().optional(),
  agentProfileId: idSchema.nullable().optional(),
  toolDomains: toolDomainsSchema.nullable().optional(),
  budgetMicroUsd: budgetSchema.nullable().optional(),
  maxToolIterations: iterationsSchema.nullable().optional(),
  maxRunSeconds: runSecondsSchema.nullable().optional(),
  invariants: assertionsSchema.default([]),
  criteria: assertionsSchema.default([]),
  expectedOutcome: expectedOutcomeSchema.nullable().optional(),
});

export const createEvalCaseRequestSchema = caseFieldsSchema.superRefine(refineCase);
export type CreateEvalCaseRequest = z.infer<typeof createEvalCaseRequestSchema>;
export type CreateEvalCaseRequestInput = z.input<typeof createEvalCaseRequestSchema>;

/**
 * A partial update: an absent field is left alone, `null` clears it. The
 * cross-field rules are checked by the service against the merged case,
 * because a change of mode alone says nothing about the pages it needs.
 */
export const updateEvalCaseRequestSchema = z
  .object({
    name: nameSchema.optional(),
    description: descriptionSchema.nullable().optional(),
    suite: suiteSchema.nullable().optional(),
    prompt: promptSchema.optional(),
    replayMode: evalReplayModeSchema.optional(),
    documentId: idSchema.nullable().optional(),
    fixture: evalFixtureSchema.nullable().optional(),
    agentProfileId: idSchema.nullable().optional(),
    toolDomains: toolDomainsSchema.nullable().optional(),
    budgetMicroUsd: budgetSchema.nullable().optional(),
    maxToolIterations: iterationsSchema.nullable().optional(),
    maxRunSeconds: runSecondsSchema.nullable().optional(),
    invariants: assertionsSchema.optional(),
    criteria: assertionsSchema.optional(),
    expectedOutcome: expectedOutcomeSchema.nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'Nothing to update' });
export type UpdateEvalCaseRequest = z.infer<typeof updateEvalCaseRequestSchema>;
export type UpdateEvalCaseRequestInput = z.input<typeof updateEvalCaseRequestSchema>;

/**
 * A case taken from a real run: its prompt, its page, its profile. The mode
 * is chosen by the person, because which way a replay stays harmless is a
 * decision; `fixture` copies the page the run stood on, as it reads now.
 */
export const evalCaseFromRunRequestSchema = z.object({
  name: nameSchema,
  replayMode: evalReplayModeSchema.default('read_only'),
  suite: suiteSchema.nullable().optional(),
  description: descriptionSchema.nullable().optional(),
});
export type EvalCaseFromRunRequest = z.infer<typeof evalCaseFromRunRequestSchema>;

export const evalCaseListQuerySchema = z.object({
  suite: z.string().trim().max(EVAL_LIMITS.suiteMaxChars).optional(),
});
export type EvalCaseListQuery = z.infer<typeof evalCaseListQuerySchema>;

export const evalCaseListResponseSchema = z.object({
  cases: z.array(evalCaseSchema),
  /** Every suite name in the workspace, for the filter. */
  suites: z.array(z.string()),
});
export type EvalCaseListResponse = z.infer<typeof evalCaseListResponseSchema>;

/**
 * A suite as a file: the cases without ids, so it can be versioned in a
 * repository and imported into another workspace. A start page and a profile
 * are kept by id and only bind where they exist.
 */
export const EVAL_SUITE_FORMAT = 'exocortex.eval-suite/1' as const;
export const evalSuiteFileSchema = z.object({
  format: z.literal(EVAL_SUITE_FORMAT),
  suite: z.string(),
  exportedAt: isoDateTimeSchema,
  cases: z.array(caseFieldsSchema).max(EVAL_LIMITS.maxImportCases),
});
export type EvalSuiteFile = z.infer<typeof evalSuiteFileSchema>;

/** Matched by name: an existing case is updated (and moves its revision), a new one created. */
export const importEvalSuiteRequestSchema = z.object({
  file: evalSuiteFileSchema,
  /** Overrides the file's suite name. */
  suite: suiteSchema.optional(),
});
export type ImportEvalSuiteRequest = z.infer<typeof importEvalSuiteRequestSchema>;

export const importEvalSuiteResponseSchema = z.object({
  created: z.number().int(),
  updated: z.number().int(),
  unchanged: z.number().int(),
  /** Names whose case could not be taken over, with the reason. */
  skipped: z.array(z.object({ name: z.string(), reason: z.string() })),
});
export type ImportEvalSuiteResponse = z.infer<typeof importEvalSuiteResponseSchema>;

/** One way to run a case: a model, a reasoning level, optionally a provider preference. */
export const evalVariantSchema = z.object({
  modelSlug: z.string().trim().min(1).max(200),
  reasoningLevel: aiReasoningLevelSchema.default('none'),
  /** Laid over the configured routing like a profile's (ADR-063), e.g. `{ only: ['deepinfra'] }`. */
  providerRouting: providerRoutingOverrideSchema.nullable().default(null),
  /** How the comparison names it; derived from the rest when absent. */
  label: z.string().trim().min(1).max(60).nullable().default(null),
});
export type EvalVariant = z.infer<typeof evalVariantSchema>;
export type EvalVariantInput = z.input<typeof evalVariantSchema>;

/** The label a variant shows; the same one for the same settings. */
export function evalVariantLabel(variant: EvalVariant): string {
  if (variant.label !== null) return variant.label;
  const reasoning = variant.reasoningLevel === 'none' ? '' : ` · ${variant.reasoningLevel}`;
  const only = variant.providerRouting?.only;
  const routing = Array.isArray(only) && only.length > 0 ? ` @ ${only.join('+')}` : '';
  return `${variant.modelSlug}${reasoning}${routing}`;
}

export const startEvalRunRequestSchema = z
  .object({
    /** The cases to replay; or `suite` for every case in it. */
    caseIds: z.array(idSchema).min(1).max(EVAL_LIMITS.maxCasesPerRun).optional(),
    suite: suiteSchema.optional(),
    variants: z.array(evalVariantSchema).min(1).max(EVAL_LIMITS.maxVariants),
    repetitions: z.number().int().min(1).max(EVAL_LIMITS.maxRepetitions).default(1),
    label: z.string().trim().max(120).nullable().optional(),
  })
  .refine((value) => (value.caseIds === undefined) !== (value.suite === undefined), {
    message: 'Name either caseIds or a suite',
  });
export type StartEvalRunRequest = z.infer<typeof startEvalRunRequestSchema>;
export type StartEvalRunRequestInput = z.input<typeof startEvalRunRequestSchema>;

export const EVAL_ATTEMPT_STATUSES = ['queued', 'running', 'finished', 'cancelled'] as const;
export const evalAttemptStatusSchema = z.enum(EVAL_ATTEMPT_STATUSES);
export type EvalAttemptStatus = z.infer<typeof evalAttemptStatusSchema>;

/**
 * How a finished attempt went by the checks alone. `invariant_violated` wins
 * over everything; `error` means the attempt could not be made at all (the
 * sandbox could not be built, the run could not be started), which says
 * nothing about the model.
 */
export const EVAL_OUTCOMES = ['passed', 'failed', 'invariant_violated', 'error'] as const;
export const evalOutcomeSchema = z.enum(EVAL_OUTCOMES);
export type EvalOutcome = z.infer<typeof evalOutcomeSchema>;

/** What a person decided when reviewing; it stands beside the automatic outcome, never over it. */
export const EVAL_VERDICTS = ['passed', 'failed'] as const;
export const evalVerdictSchema = z.enum(EVAL_VERDICTS);
export type EvalVerdict = z.infer<typeof evalVerdictSchema>;

/**
 * The attempt's numbers, frozen when it ends. Raw facts, so a comparison
 * months later reads the same figures the first one did.
 */
export const evalAttemptMetricsSchema = z.object({
  runStatus: z.string(),
  errorCode: z.string().nullable(),
  durationMs: z.number().int().nullable(),
  inputTokens: z.number().int().nullable(),
  outputTokens: z.number().int().nullable(),
  cachedInputTokens: z.number().int().nullable(),
  /** What the provider charged, or the price list's estimate when it said nothing. */
  costMicroUsd: z.number().int().nullable(),
  costEstimated: z.boolean(),
  /** Paid with the workspace's own key, i.e. a subscription or BYOK rather than the deployment's. */
  usedOwnKey: z.boolean(),
  turns: z.number().int(),
  toolCalls: z.number().int(),
  failedToolCalls: z.number().int(),
  /** Calls per tool name. */
  tools: z.record(z.string(), z.number().int()),
  /** Upstream providers that served a turn, in order of first use. */
  providers: z.array(z.string()),
  providerSwitches: z.number().int(),
  contextChars: z.number().int().nullable(),
  contextTokens: z.number().int().nullable(),
  compactions: z.number().int(),
  /** Questions and approvals the run raised for a person (human checkpoints). */
  humanCheckpoints: z.number().int(),
  proposedChanges: z.number().int(),
  answerChars: z.number().int(),
});
export type EvalAttemptMetrics = z.infer<typeof evalAttemptMetricsSchema>;

/** One check as it was decided; `passed` is null for a manual one nobody answered yet. */
export const evalAssertionResultSchema = z.object({
  id: z.string(),
  kind: z.string(),
  role: z.enum(['invariant', 'criterion']),
  passed: z.boolean().nullable(),
  /** What was found, for the reader: a count, a cost, a duration. Null when there is nothing to say. */
  actual: z.union([z.number(), z.string()]).nullable(),
  /** Set by a review for a `manual` check. */
  decidedBy: z.enum(['system', 'review']),
  /** The sentence a `manual` check asks a person; null for every other kind. */
  text: z.string().nullable().default(null),
});
export type EvalAssertionResult = z.infer<typeof evalAssertionResultSchema>;

/** What the attempt left behind, kept after its sandbox and proposals are gone. */
export const evalAttemptArtifactsSchema = z.object({
  /** The final text of every fixture page by key, `null` when the run deleted it. */
  pages: z.record(z.string(), z.string().nullable()),
  /** Pages the run created inside the sandbox. */
  createdPages: z.array(z.object({ title: z.string(), markdown: z.string() })),
  changesets: z.array(
    z.object({
      id: idSchema,
      title: z.string(),
      changes: z.number().int(),
      /** What happened to it when the attempt ended. */
      closedAs: z.enum(['rejected', 'discarded', 'already_closed']),
    }),
  ),
  /** True when a page's text was cut to keep the attempt's row bounded. */
  truncated: z.boolean(),
});
export type EvalAttemptArtifacts = z.infer<typeof evalAttemptArtifactsSchema>;

export const evalReviewSchema = z.object({
  verdict: evalVerdictSchema.nullable(),
  /** 1 to 5, optional. */
  score: z.number().int().min(1).max(5).nullable(),
  note: z.string().nullable(),
  reviewedBy: accountSchema.nullable(),
  reviewedAt: isoDateTimeSchema,
});
export type EvalReview = z.infer<typeof evalReviewSchema>;

export const evalAttemptSchema = z.object({
  id: idSchema,
  evalRunId: idSchema,
  caseId: idSchema.nullable(),
  caseName: z.string(),
  caseRevision: z.number().int(),
  replayMode: evalReplayModeSchema,
  variant: evalVariantSchema,
  variantLabel: z.string(),
  repetition: z.number().int(),
  status: evalAttemptStatusSchema,
  outcome: evalOutcomeSchema.nullable(),
  /** Why an attempt ended in `error`; an API error code or the run's. */
  errorCode: z.string().nullable(),
  aiRunId: idSchema.nullable(),
  conversationId: idSchema.nullable(),
  metrics: evalAttemptMetricsSchema.nullable(),
  assertions: z.array(evalAssertionResultSchema),
  /** The run's answer; present on a single attempt's read and on the run detail. */
  answer: z.string().nullable(),
  artifacts: evalAttemptArtifactsSchema.nullable(),
  review: evalReviewSchema.nullable(),
  createdAt: isoDateTimeSchema,
  startedAt: isoDateTimeSchema.nullable(),
  finishedAt: isoDateTimeSchema.nullable(),
});
export type EvalAttempt = z.infer<typeof evalAttemptSchema>;

export const evalCaseResponseSchema = z.object({
  evalCase: evalCaseSchema,
  /** The newest attempts at this case across every run, newest first; empty after a write. */
  recentAttempts: z.array(evalAttemptSchema),
});
export type EvalCaseResponse = z.infer<typeof evalCaseResponseSchema>;

export const evalRunSchema = z.object({
  id: idSchema,
  workspaceId: idSchema,
  label: z.string().nullable(),
  suite: z.string().nullable(),
  variants: z.array(evalVariantSchema),
  repetitions: z.number().int(),
  caseCount: z.number().int(),
  /** Attempts by status and, once finished, by outcome. */
  counts: z.object({
    total: z.number().int(),
    queued: z.number().int(),
    running: z.number().int(),
    finished: z.number().int(),
    cancelled: z.number().int(),
    passed: z.number().int(),
    failed: z.number().int(),
    invariantViolated: z.number().int(),
    error: z.number().int(),
  }),
  costMicroUsd: z.number().int(),
  createdBy: accountSchema.nullable(),
  createdAt: isoDateTimeSchema,
  /** When the last attempt ended; null while any is open. */
  finishedAt: isoDateTimeSchema.nullable(),
});
export type EvalRun = z.infer<typeof evalRunSchema>;

export const evalRunListResponseSchema = z.object({ runs: z.array(evalRunSchema) });
export type EvalRunListResponse = z.infer<typeof evalRunListResponseSchema>;

/** One cell of the comparison: one case, one variant, in one run. */
export const evalComparisonCellSchema = z.object({
  evalRunId: idSchema,
  caseKey: z.string(),
  variantLabel: z.string(),
  attempts: z.number().int(),
  finished: z.number().int(),
  passed: z.number().int(),
  invariantViolated: z.number().int(),
  /** Reviews that said "passed", over the reviewed attempts. */
  reviewedPassed: z.number().int(),
  reviewed: z.number().int(),
  /** Means over the finished attempts; null when none has the figure. */
  meanDurationMs: z.number().nullable(),
  meanCostMicroUsd: z.number().nullable(),
  meanToolCalls: z.number().nullable(),
  meanInputTokens: z.number().nullable(),
  meanOutputTokens: z.number().nullable(),
  meanScore: z.number().nullable(),
  totalCostMicroUsd: z.number().int(),
  failedToolCalls: z.number().int(),
  providerSwitches: z.number().int(),
  humanCheckpoints: z.number().int(),
  /** How often each check passed, over the attempts it was decided in. */
  assertionPassRates: z.array(
    z.object({
      id: z.string(),
      kind: z.string(),
      passed: z.number().int(),
      decided: z.number().int(),
    }),
  ),
});
export type EvalComparisonCell = z.infer<typeof evalComparisonCellSchema>;

export const evalComparisonSchema = z.object({
  runs: z.array(evalRunSchema),
  /** Rows: the cases, by name (a case's id may differ between workspaces' imports, its name does not). */
  cases: z.array(z.object({ key: z.string(), caseId: idSchema.nullable(), name: z.string() })),
  /** Columns: every variant label seen, in first-seen order. */
  variants: z.array(z.string()),
  cells: z.array(evalComparisonCellSchema),
});
export type EvalComparison = z.infer<typeof evalComparisonSchema>;

export const evalRunDetailResponseSchema = z.object({
  run: evalRunSchema,
  attempts: z.array(evalAttemptSchema),
  comparison: evalComparisonSchema,
});
export type EvalRunDetailResponse = z.infer<typeof evalRunDetailResponseSchema>;

export const evalComparisonQuerySchema = z.object({
  /** Comma-separated run ids, oldest first is how they are shown. */
  runIds: z
    .string()
    .transform((value) =>
      value
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean),
    )
    .pipe(z.array(idSchema).min(1).max(EVAL_LIMITS.maxComparedRuns)),
});
export type EvalComparisonQuery = z.infer<typeof evalComparisonQuerySchema>;

export const reviewEvalAttemptRequestSchema = z
  .object({
    verdict: evalVerdictSchema.nullable().optional(),
    score: z.number().int().min(1).max(5).nullable().optional(),
    note: z.string().trim().max(EVAL_LIMITS.reviewNoteMaxChars).nullable().optional(),
    /** Answers to the case's `manual` checks, by check id; null takes an answer back. */
    manual: z.record(assertionIdSchema, z.boolean().nullable()).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'Nothing to review' });
export type ReviewEvalAttemptRequest = z.infer<typeof reviewEvalAttemptRequestSchema>;

export const evalAttemptResponseSchema = z.object({ attempt: evalAttemptSchema });
export type EvalAttemptResponse = z.infer<typeof evalAttemptResponseSchema>;

export const cancelEvalRunResponseSchema = z.object({
  run: evalRunSchema,
  cancelledAttempts: z.number().int(),
});
export type CancelEvalRunResponse = z.infer<typeof cancelEvalRunResponseSchema>;

export const deleteEvalResponseSchema = z.object({ deleted: z.literal(true) });
export type DeleteEvalResponse = z.infer<typeof deleteEvalResponseSchema>;
