import { describe, expect, it } from 'vitest';

import {
  childBudget,
  childProgressOf,
  childWriteMode,
  cutText,
  hasReturned,
  type ProfileLimits,
  profileNoLooser,
} from './work-item-delegation-rules';

const OPEN: ProfileLimits = {
  toolDomains: null,
  writeMode: 'direct',
  approvalPolicy: 'none',
  budgetMicroUsdPerRun: null,
  budgetMicroUsdPerTask: null,
  maxToolIterations: null,
  maxRunSeconds: null,
  confineToWorkspace: false,
};

describe('delegation rules (issue #144)', () => {
  it('counts review and every closed status as returned', () => {
    expect(hasReturned('REVIEW')).toBe(true);
    expect(hasReturned('FAILED')).toBe(true);
    expect(hasReturned('WORKING')).toBe(false);
    expect(hasReturned('WAITING_FOR_HUMAN')).toBe(false);
  });

  it('groups children by what their status means to the parent', () => {
    expect(
      childProgressOf([
        { status: 'QUEUED' },
        { status: 'WORKING' },
        { status: 'BLOCKED' },
        { status: 'REVIEW' },
        { status: 'FAILED' },
      ]),
    ).toEqual({ total: 5, open: 2, waiting: 1, review: 1, done: 0, failed: 1, cancelled: 0 });
  });

  it('never gives a child a looser write mode than its parent or the caller', () => {
    expect(childWriteMode(null, null, 'direct')).toBeNull();
    expect(childWriteMode('direct', 'propose', 'direct')).toBe('propose');
    expect(childWriteMode('direct', null, 'propose')).toBe('propose');
    expect(childWriteMode('read_only', 'propose', 'direct')).toBe('read_only');
    expect(childWriteMode(null, null, 'read_only')).toBe('read_only');
  });

  it('allows any profile under a parent without one', () => {
    expect(profileNoLooser(OPEN, null)).toBe(true);
  });

  it('refuses a profile that loosens any limit of the parent', () => {
    const parent: ProfileLimits = {
      ...OPEN,
      toolDomains: ['pages', 'web'],
      writeMode: 'propose',
      budgetMicroUsdPerRun: 1_000,
      confineToWorkspace: true,
    };
    const narrower: ProfileLimits = {
      ...parent,
      toolDomains: ['web'],
      writeMode: 'read_only',
      budgetMicroUsdPerRun: 500,
    };
    expect(profileNoLooser(narrower, parent)).toBe(true);
    expect(profileNoLooser({ ...narrower, toolDomains: null }, parent)).toBe(false);
    expect(profileNoLooser({ ...narrower, toolDomains: ['admin'] }, parent)).toBe(false);
    expect(profileNoLooser({ ...narrower, writeMode: 'direct' }, parent)).toBe(false);
    expect(profileNoLooser({ ...narrower, budgetMicroUsdPerRun: null }, parent)).toBe(false);
    expect(profileNoLooser({ ...narrower, confineToWorkspace: false }, parent)).toBe(false);
    expect(
      profileNoLooser(narrower, { ...parent, approvalPolicy: 'review_before_done' }),
    ).toBe(false);
  });

  it('carves a child budget out of what is left', () => {
    expect(childBudget(undefined, null)).toBeNull();
    expect(childBudget(500, null)).toBe(500);
    expect(childBudget(undefined, 300)).toBe(300);
    expect(childBudget(500, 300)).toBe(300);
    expect(childBudget(100, 300)).toBe(100);
  });

  it('cuts a long result at a word and says so', () => {
    expect(cutText('kurz', 10)).toEqual({ text: 'kurz', truncated: false });
    const cut = cutText('eins zwei drei vier fünf sechs', 20);
    expect(cut.truncated).toBe(true);
    expect(cut.text).toBe('eins zwei drei vier …');
  });
});
