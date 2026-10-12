import {
  assertionsProblem,
  type CreateEvalCaseRequestInput,
  type EvalAssertion,
  evalAssertionSchema,
  type EvalCase,
  type EvalFixture,
  type EvalReplayMode,
  fixtureProblem,
  type ToolDomain,
} from '@exocortex/contracts';

import { microUsdOfDraft } from '@/lib/money';

import { wholeNumberOf } from '../agent-profiles/agent-profile-labels';

/**
 * The eval case form as a draft of strings (issue #146), and the one
 * function that turns it into a request. Pure, so what the form sends is
 * tested without a browser.
 */

export const CHECK_KINDS = [
  'answer_contains',
  'answer_excludes',
  'answer_matches',
  'tool_called',
  'tool_not_called',
  'max_tool_calls',
  'max_failed_tool_calls',
  'max_cost',
  'max_duration',
  'no_changes',
  'page_contains',
  'page_excludes',
  'pages_created',
  'proposed_changes',
  'manual',
] as const satisfies readonly EvalAssertion['kind'][];

export type CheckRole = 'invariant' | 'criterion';

export interface CheckDraft {
  /** React's key; never sent. */
  rowKey: string;
  role: CheckRole;
  kind: EvalAssertion['kind'];
  id: string;
  text: string;
  caseSensitive: boolean;
  pattern: string;
  flags: string;
  tool: string;
  page: string;
  min: string;
  max: string;
  /** Micro-dollars as text; the field shows and reads dollars (`MoneyTextInput`). */
  maxMicroUsd: string;
  maxSeconds: string;
}

export interface PageDraft {
  rowKey: string;
  key: string;
  title: string;
  markdown: string;
  parentKey: string | null;
}

export interface CaseDraft {
  name: string;
  description: string;
  suite: string;
  prompt: string;
  replayMode: EvalReplayMode;
  documentId: string | null;
  documentTitle: string | null;
  pages: PageDraft[];
  startKey: string | null;
  agentProfileId: string | null;
  allTools: boolean;
  toolDomains: ToolDomain[];
  /** Micro-dollars as text; the field shows and reads dollars (`MoneyTextInput`). */
  budgetMicroUsd: string;
  maxToolIterations: string;
  maxRunSeconds: string;
  expectedOutcome: string;
  checks: CheckDraft[];
}

let rowCounter = 0;
export function rowKey(): string {
  rowCounter += 1;
  return `row-${rowCounter}`;
}

export function emptyCheck(role: CheckRole, index: number): CheckDraft {
  return {
    rowKey: rowKey(),
    role,
    kind: role === 'invariant' ? 'no_changes' : 'answer_contains',
    id: `${role === 'invariant' ? 'i' : 'k'}${index + 1}`,
    text: '',
    caseSensitive: false,
    pattern: '',
    flags: '',
    tool: '',
    page: '',
    min: '',
    max: '',
    maxMicroUsd: '',
    maxSeconds: '',
  };
}

export function emptyPage(index: number): PageDraft {
  return {
    rowKey: rowKey(),
    key: `seite${index + 1}`,
    title: '',
    markdown: '',
    parentKey: null,
  };
}

function text(value: number | null | undefined): string {
  return value === null || value === undefined ? '' : String(value);
}

function checkDraftOf(assertion: EvalAssertion, role: CheckRole): CheckDraft {
  const draft: CheckDraft = { ...emptyCheck(role, 0), kind: assertion.kind, id: assertion.id };
  if ('text' in assertion) draft.text = assertion.text;
  if ('caseSensitive' in assertion) draft.caseSensitive = assertion.caseSensitive;
  if ('pattern' in assertion) {
    draft.pattern = assertion.pattern;
    draft.flags = assertion.flags;
  }
  if ('tool' in assertion) draft.tool = assertion.tool;
  if ('page' in assertion) draft.page = assertion.page;
  if ('min' in assertion) draft.min = text(assertion.min);
  if ('max' in assertion) draft.max = text(assertion.max);
  if ('maxMicroUsd' in assertion) draft.maxMicroUsd = String(assertion.maxMicroUsd);
  if ('maxSeconds' in assertion) draft.maxSeconds = text(assertion.maxSeconds);
  return draft;
}

export const NEW_CASE: CaseDraft = {
  name: '',
  description: '',
  suite: '',
  prompt: '',
  replayMode: 'read_only',
  documentId: null,
  documentTitle: null,
  pages: [],
  startKey: null,
  agentProfileId: null,
  allTools: true,
  toolDomains: ['pages'],
  budgetMicroUsd: '',
  maxToolIterations: '',
  maxRunSeconds: '',
  expectedOutcome: '',
  checks: [emptyCheck('invariant', 0)],
};

export function caseDraftOf(evalCase: EvalCase | null): CaseDraft {
  if (evalCase === null) return { ...NEW_CASE, checks: [emptyCheck('invariant', 0)] };
  return {
    name: evalCase.name,
    description: evalCase.description ?? '',
    suite: evalCase.suite ?? '',
    prompt: evalCase.prompt,
    replayMode: evalCase.replayMode,
    documentId: evalCase.documentId,
    documentTitle: evalCase.documentTitle,
    pages: (evalCase.fixture?.pages ?? []).map((page) => ({ ...page, rowKey: rowKey() })),
    startKey: evalCase.fixture?.startKey ?? null,
    agentProfileId: evalCase.agentProfileId,
    allTools: evalCase.toolDomains === null,
    toolDomains: evalCase.toolDomains ?? NEW_CASE.toolDomains,
    budgetMicroUsd: evalCase.budgetMicroUsd === null ? '' : String(evalCase.budgetMicroUsd),
    maxToolIterations: text(evalCase.maxToolIterations),
    maxRunSeconds: text(evalCase.maxRunSeconds),
    expectedOutcome: evalCase.expectedOutcome ?? '',
    checks: [
      ...evalCase.invariants.map((assertion) => checkDraftOf(assertion, 'invariant')),
      ...evalCase.criteria.map((assertion) => checkDraftOf(assertion, 'criterion')),
    ],
  };
}

/** A count field: empty means the default, anything else has to be a whole number. */
function count(value: string): number | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  const parsed = Number(trimmed);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : Number.NaN;
}

/** The fields one kind of check sends; the schema decides whether they are enough. */
function checkFields(draft: CheckDraft): Record<string, unknown> {
  const bounds = { min: count(draft.min), max: count(draft.max) ?? null };
  switch (draft.kind) {
    case 'answer_contains':
    case 'answer_excludes':
      return { text: draft.text, caseSensitive: draft.caseSensitive };
    case 'answer_matches':
      return { pattern: draft.pattern, flags: draft.flags.trim(), ...bounds };
    case 'tool_called':
      return { tool: draft.tool.trim(), ...bounds };
    case 'tool_not_called':
      return { tool: draft.tool.trim() };
    case 'max_tool_calls':
    case 'max_failed_tool_calls':
      return { max: count(draft.max) };
    case 'max_cost':
      return { maxMicroUsd: microUsdOfDraft(draft.maxMicroUsd) };
    case 'max_duration':
      return { maxSeconds: count(draft.maxSeconds) };
    case 'no_changes':
      return {};
    case 'page_contains':
    case 'page_excludes':
      return { page: draft.page, text: draft.text, caseSensitive: draft.caseSensitive };
    case 'pages_created':
    case 'proposed_changes':
      return bounds;
    case 'manual':
      return { text: draft.text };
  }
}

/** One check as the contract has it, or null when its fields do not make one. */
export function assertionOf(draft: CheckDraft): EvalAssertion | null {
  const parsed = evalAssertionSchema.safeParse({
    id: draft.id.trim(),
    kind: draft.kind,
    ...checkFields(draft),
  });
  return parsed.success ? parsed.data : null;
}

export function fixtureOf(draft: CaseDraft): EvalFixture | null {
  if (draft.replayMode !== 'fixture') return null;
  return {
    pages: draft.pages.map((page) => ({
      key: page.key.trim(),
      title: page.title.trim(),
      markdown: page.markdown,
      parentKey: page.parentKey,
    })),
    startKey: draft.startKey,
  };
}

/** A fixture case has pages, each with a title, and the keys and parents fit together. */
function pagesComplete(draft: CaseDraft, fixture: EvalFixture | null): boolean {
  if (draft.replayMode !== 'fixture') return true;
  if (fixture === null || fixture.pages.length === 0) return false;
  return fixtureProblem(fixture) === null && fixture.pages.every((page) => page.title.length > 0);
}

/** Every limit is empty or a number. */
function limitsComplete(draft: CaseDraft): boolean {
  const iterations = draft.maxToolIterations.trim();
  const seconds = draft.maxRunSeconds.trim();
  return (
    (iterations.length === 0 || wholeNumberOf(iterations) !== null) &&
    (seconds.length === 0 || wholeNumberOf(seconds) !== null) &&
    microUsdOfDraft(draft.budgetMicroUsd) !== undefined
  );
}

/**
 * The request the draft makes, or the reason it does not make one yet. The
 * reason is a key of `evals.dialog.problems`; the API says the rest.
 */
export function caseRequestOf(
  draft: CaseDraft,
):
  | { request: CreateEvalCaseRequestInput }
  | { problem: 'name' | 'prompt' | 'pages' | 'checks' | 'limits' } {
  if (draft.name.trim().length === 0) return { problem: 'name' };
  if (draft.prompt.trim().length === 0) return { problem: 'prompt' };
  const fixture = fixtureOf(draft);
  if (!pagesComplete(draft, fixture)) return { problem: 'pages' };
  const assertions = draft.checks.map(assertionOf);
  if (assertions.some((assertion) => assertion === null)) return { problem: 'checks' };
  const invariants = draft.checks.flatMap((check, index) =>
    check.role === 'invariant' ? [assertions[index]!] : [],
  );
  const criteria = draft.checks.flatMap((check, index) =>
    check.role === 'criterion' ? [assertions[index]!] : [],
  );
  if (
    assertionsProblem({
      replayMode: draft.replayMode,
      fixture,
      assertions: [...invariants, ...criteria],
    }) !== null
  ) {
    return { problem: 'checks' };
  }
  if (!limitsComplete(draft)) return { problem: 'limits' };
  const iterations = draft.maxToolIterations.trim();
  const seconds = draft.maxRunSeconds.trim();
  return {
    request: {
      name: draft.name.trim(),
      description: draft.description.trim() || null,
      suite: draft.suite.trim() || null,
      prompt: draft.prompt.trim(),
      replayMode: draft.replayMode,
      documentId: draft.replayMode === 'fixture' ? null : draft.documentId,
      fixture,
      agentProfileId: draft.agentProfileId,
      toolDomains: draft.allTools ? null : draft.toolDomains,
      budgetMicroUsd: microUsdOfDraft(draft.budgetMicroUsd) ?? null,
      maxToolIterations: wholeNumberOf(iterations),
      maxRunSeconds: wholeNumberOf(seconds),
      invariants,
      criteria,
      expectedOutcome: draft.expectedOutcome.trim() || null,
    },
  };
}
