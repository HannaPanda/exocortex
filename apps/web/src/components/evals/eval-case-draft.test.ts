import { describe, expect, it } from 'vitest';

import { assertionOf, caseRequestOf, emptyCheck, emptyPage, NEW_CASE } from './eval-case-draft';

const base = { ...NEW_CASE, name: 'Plan', prompt: 'Mach einen Plan.' };

describe('caseRequestOf (issue #146)', () => {
  it('names what is missing before anything is sent', () => {
    expect(caseRequestOf({ ...NEW_CASE })).toEqual({ problem: 'name' });
    expect(caseRequestOf({ ...NEW_CASE, name: 'Plan' })).toEqual({ problem: 'prompt' });
    expect(caseRequestOf({ ...base, replayMode: 'fixture', pages: [] })).toEqual({
      problem: 'pages',
    });
    // The money field hands over `invalid` while it refuses what was typed.
    expect(caseRequestOf({ ...base, budgetMicroUsd: 'invalid' })).toEqual({ problem: 'limits' });
  });

  it('sends a budget as the micro-dollars the field holds, and zero as zero (issue #167)', () => {
    const built = (budgetMicroUsd: string) => {
      const result = caseRequestOf({ ...base, budgetMicroUsd });
      return 'request' in result ? result.request.budgetMicroUsd : result.problem;
    };
    expect(built('2000000')).toBe(2_000_000);
    expect(built('0')).toBe(0);
    expect(built('')).toBeNull();
  });

  it('splits the checks into invariants and criteria', () => {
    const contains = { ...emptyCheck('criterion', 0), text: 'ADR-063' };
    const built = caseRequestOf({ ...base, checks: [emptyCheck('invariant', 0), contains] });
    expect('request' in built && built.request.invariants).toEqual([
      { id: 'i1', kind: 'no_changes' },
    ]);
    expect('request' in built && built.request.criteria).toEqual([
      { id: 'k1', kind: 'answer_contains', text: 'ADR-063', caseSensitive: false },
    ]);
  });

  it('refuses a check the mode cannot decide and one that is incomplete', () => {
    const proposals = { ...emptyCheck('criterion', 0), kind: 'proposed_changes' as const };
    expect(caseRequestOf({ ...base, checks: [proposals] })).toEqual({ problem: 'checks' });
    expect(caseRequestOf({ ...base, checks: [emptyCheck('criterion', 0)] })).toEqual({
      problem: 'checks',
    });
  });

  it('sends fixture pages and drops the start page in the fixture mode', () => {
    const page = { ...emptyPage(0), title: 'Notizen', markdown: '# A' };
    const built = caseRequestOf({
      ...base,
      replayMode: 'fixture',
      documentId: 'page-elsewhere',
      pages: [page],
      startKey: page.key,
      checks: [],
    });
    expect('request' in built && built.request.documentId).toBeNull();
    expect('request' in built && built.request.fixture).toEqual({
      pages: [{ key: 'seite1', title: 'Notizen', markdown: '# A', parentKey: null }],
      startKey: 'seite1',
    });
  });
});

describe('assertionOf', () => {
  it('reads counts and money from the text fields', () => {
    expect(
      assertionOf({
        ...emptyCheck('criterion', 0),
        kind: 'answer_matches',
        pattern: '^\\d+\\.',
        flags: 'm',
        max: '8',
      }),
    ).toEqual({
      id: 'k1',
      kind: 'answer_matches',
      pattern: '^\\d+\\.',
      flags: 'm',
      min: 1,
      max: 8,
    });
    expect(
      assertionOf({ ...emptyCheck('invariant', 0), kind: 'max_cost', maxMicroUsd: '50000' }),
    ).toEqual({
      id: 'i1',
      kind: 'max_cost',
      maxMicroUsd: 50_000,
    });
    expect(
      assertionOf({ ...emptyCheck('criterion', 0), kind: 'max_tool_calls', max: 'zehn' }),
    ).toBeNull();
  });
});
