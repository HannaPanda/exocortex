import {
  type EvalAssertion,
  type EvalAssertionResult,
  type EvalAttemptMetrics,
  type EvalCaseDefinition,
  type EvalOutcome,
} from '@exocortex/contracts';

import { parseEvents, type RunEventRow } from '../ai/run-inspection';

/**
 * Deciding an eval attempt (issue #146, ADR-074). Pure: the settlement loads
 * what the attempt left behind, and everything about what that amounts to is
 * here, where a test can reach it without a database.
 */

/** Characters of an answer a pattern is run against; a bound on the work a pattern can cause. */
const MAX_MATCHED_CHARS = 200_000;

/** What an attempt left behind, as the checks read it. */
export interface EvalFacts {
  /** The run's status, lowercase; `completed` is the only one that answered. */
  runStatus: string;
  answer: string;
  metrics: EvalAttemptMetrics;
  /** The final text of every fixture page by key, null for a page the run deleted. */
  pages: Readonly<Record<string, string | null>>;
  /** Fixture pages whose text differs from what was copied in. */
  changedPages: number;
  createdPages: number;
}

function includes(haystack: string, needle: string, caseSensitive: boolean): boolean {
  if (caseSensitive) return haystack.includes(needle);
  return haystack.toLocaleLowerCase('de').includes(needle.toLocaleLowerCase('de'));
}

function countMatches(text: string, pattern: string, flags: string): number {
  const expression = new RegExp(pattern, `${flags}g`);
  let count = 0;
  for (const match of text.slice(0, MAX_MATCHED_CHARS).matchAll(expression)) {
    // An empty match would count every position; it says nothing.
    if (match[0].length > 0) count += 1;
  }
  return count;
}

function within(value: number, min: number, max: number | null): boolean {
  return value >= min && (max === null || value <= max);
}

type Decision = Pick<EvalAssertionResult, 'passed' | 'actual'>;
type Manual = Readonly<Record<string, boolean | null>>;
type Decider<K extends EvalAssertion['kind']> = (
  assertion: Extract<EvalAssertion, { kind: K }>,
  facts: EvalFacts,
  manual: Manual,
) => Decision;

function pageCheck(
  assertion: Extract<EvalAssertion, { kind: 'page_contains' | 'page_excludes' }>,
  facts: EvalFacts,
): Decision {
  const text = facts.pages[assertion.page];
  if (text === undefined || text === null) {
    return { passed: assertion.kind === 'page_excludes', actual: 'missing' };
  }
  const found = includes(text, assertion.text, assertion.caseSensitive);
  return { passed: assertion.kind === 'page_contains' ? found : !found, actual: null };
}

/** One way to decide each kind of check; the table is what a new kind adds itself to. */
const DECIDERS: { [K in EvalAssertion['kind']]: Decider<K> } = {
  answer_contains: (assertion, facts) => ({
    passed: includes(facts.answer, assertion.text, assertion.caseSensitive),
    actual: null,
  }),
  answer_excludes: (assertion, facts) => ({
    passed: !includes(facts.answer, assertion.text, assertion.caseSensitive),
    actual: null,
  }),
  answer_matches: (assertion, facts) => {
    const count = countMatches(facts.answer, assertion.pattern, assertion.flags);
    return { passed: within(count, assertion.min, assertion.max), actual: count };
  },
  tool_called: (assertion, facts) => {
    const count = facts.metrics.tools[assertion.tool] ?? 0;
    return { passed: within(count, assertion.min, assertion.max), actual: count };
  },
  tool_not_called: (assertion, facts) => {
    const count = facts.metrics.tools[assertion.tool] ?? 0;
    return { passed: count === 0, actual: count };
  },
  max_tool_calls: (assertion, facts) => ({
    passed: facts.metrics.toolCalls <= assertion.max,
    actual: facts.metrics.toolCalls,
  }),
  max_failed_tool_calls: (assertion, facts) => ({
    passed: facts.metrics.failedToolCalls <= assertion.max,
    actual: facts.metrics.failedToolCalls,
  }),
  // No figure is not a pass: a run that reported no cost may have cost anything.
  max_cost: (assertion, facts) => ({
    passed:
      facts.metrics.costMicroUsd === null
        ? null
        : facts.metrics.costMicroUsd <= assertion.maxMicroUsd,
    actual: facts.metrics.costMicroUsd,
  }),
  max_duration: (assertion, facts) => {
    const { durationMs } = facts.metrics;
    return {
      passed: durationMs === null ? null : durationMs <= assertion.maxSeconds * 1_000,
      actual: durationMs === null ? null : Math.round(durationMs / 1_000),
    };
  },
  no_changes: (_assertion, facts) => {
    const changes = facts.metrics.proposedChanges + facts.changedPages + facts.createdPages;
    return { passed: changes === 0, actual: changes };
  },
  page_contains: (assertion, facts) => pageCheck(assertion, facts),
  page_excludes: (assertion, facts) => pageCheck(assertion, facts),
  pages_created: (assertion, facts) => ({
    passed: within(facts.createdPages, assertion.min, assertion.max),
    actual: facts.createdPages,
  }),
  proposed_changes: (assertion, facts) => ({
    passed: within(facts.metrics.proposedChanges, assertion.min, assertion.max),
    actual: facts.metrics.proposedChanges,
  }),
  manual: (assertion, _facts, manual) => ({ passed: manual[assertion.id] ?? null, actual: null }),
};

/** One check against the facts; `manual` answers for the checks a person decides. */
function decide(assertion: EvalAssertion, facts: EvalFacts, manual: Manual): Decision {
  const decider = DECIDERS[assertion.kind] as Decider<EvalAssertion['kind']>;
  return decider(assertion as never, facts, manual);
}

/** Every check of the case, invariants first, as decided now. */
export function evaluateAssertions(
  definition: Pick<EvalCaseDefinition, 'invariants' | 'criteria'>,
  facts: EvalFacts,
  manual: Readonly<Record<string, boolean | null>> = {},
): EvalAssertionResult[] {
  const results: EvalAssertionResult[] = [];
  const roles = [
    ['invariant', definition.invariants],
    ['criterion', definition.criteria],
  ] as const;
  for (const [role, assertions] of roles) {
    for (const assertion of assertions) {
      const decision = decide(assertion, facts, manual);
      results.push({
        id: assertion.id,
        kind: assertion.kind,
        role,
        ...decision,
        decidedBy: assertion.kind === 'manual' ? 'review' : 'system',
        text: assertion.kind === 'manual' ? assertion.text : null,
      });
    }
  }
  return results;
}

/**
 * How the attempt went by the checks. A broken invariant wins over
 * everything, a run that did not finish is a failure whatever its checks say,
 * and an undecided check (a manual one, a cost nobody reported) holds nothing
 * up: the outcome is what was decided, and the review says the rest.
 */
export function outcomeOf(runStatus: string, results: readonly EvalAssertionResult[]): EvalOutcome {
  if (results.some((result) => result.role === 'invariant' && result.passed === false)) {
    return 'invariant_violated';
  }
  if (runStatus !== 'completed') return 'failed';
  return results.some((result) => result.passed === false) ? 'failed' : 'passed';
}

/** The run's own columns the metrics are made from. */
export interface MeasuredRunRow {
  status: string;
  errorCode: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  durationMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  providerCostMicroUsd: number | null;
  estimatedCostMicroUsd: number | null;
  usedOwnKey: boolean;
  resultText: string | null;
}

/** What the recorded steps add up to. */
interface Tally {
  tools: Record<string, number>;
  providers: string[];
  turns: number;
  toolCalls: number;
  failedToolCalls: number;
  providerSwitches: number;
  compactions: number;
  context: { chars: number; tokens: number } | null;
}

function tallyEvents(rows: readonly RunEventRow[]): Tally {
  const tally: Tally = {
    tools: {},
    providers: [],
    turns: 0,
    toolCalls: 0,
    failedToolCalls: 0,
    providerSwitches: 0,
    compactions: 0,
    context: null,
  };
  let previous: string | null = null;
  for (const event of parseEvents(rows)) {
    if (event.kind === 'tool_call') {
      tally.toolCalls += 1;
      tally.tools[event.data.toolName] = (tally.tools[event.data.toolName] ?? 0) + 1;
      const failed = event.data.status !== 'succeeded' && event.data.status !== 'skipped';
      if (failed) tally.failedToolCalls += 1;
    } else if (event.kind === 'turn') {
      tally.turns += 1;
      const servedBy = event.data.servedBy;
      if (servedBy === null) continue;
      if (!tally.providers.includes(servedBy)) tally.providers.push(servedBy);
      if (previous !== null && previous !== servedBy) tally.providerSwitches += 1;
      previous = servedBy;
    } else if (event.kind === 'compaction') {
      tally.compactions += 1;
    } else if (event.kind === 'context' && tally.context === null) {
      tally.context = {
        chars: event.data.sections.reduce((total, section) => total + section.chars, 0),
        tokens: event.data.sections.reduce((total, section) => total + section.estimatedTokens, 0),
      };
    }
  }
  return tally;
}

/** The attempt's numbers, from the run's columns and its recorded steps (ADR-073). */
export function buildMetrics(input: {
  run: MeasuredRunRow;
  events: readonly RunEventRow[];
  humanCheckpoints: number;
  proposedChanges: number;
}): EvalAttemptMetrics {
  const { run } = input;
  const { context, ...tally } = tallyEvents(input.events);
  const measured =
    run.startedAt !== null && run.finishedAt !== null
      ? run.finishedAt.getTime() - run.startedAt.getTime()
      : null;
  const reported = run.providerCostMicroUsd;
  return {
    runStatus: run.status.toLowerCase(),
    errorCode: run.errorCode,
    durationMs: measured ?? run.durationMs,
    inputTokens: run.inputTokens,
    outputTokens: run.outputTokens,
    cachedInputTokens: run.cachedInputTokens,
    costMicroUsd: reported ?? run.estimatedCostMicroUsd,
    costEstimated: reported === null && run.estimatedCostMicroUsd !== null,
    usedOwnKey: run.usedOwnKey,
    ...tally,
    contextChars: context?.chars ?? null,
    contextTokens: context?.tokens ?? null,
    humanCheckpoints: input.humanCheckpoints,
    proposedChanges: input.proposedChanges,
    answerChars: run.resultText?.length ?? 0,
  };
}
