import { describe, expect, it } from 'vitest';

import { type ChangesetChangeStatus, changesetStatusOf } from './changesets';

describe('changesetStatusOf', () => {
  const cases: [boolean, ChangesetChangeStatus[], string][] = [
    [false, [], 'draft'],
    [false, ['pending'], 'draft'],
    [true, ['pending', 'pending'], 'ready'],
    [true, ['applied', 'pending'], 'partially_applied'],
    [true, ['applied', 'rejected'], 'partially_applied'],
    [true, ['applied', 'applied'], 'applied'],
    [true, ['rejected', 'stale'], 'stale'],
    [true, ['rejected', 'rejected'], 'rejected'],
    [true, ['stale', 'pending'], 'ready'],
  ];
  it.each(cases)('submitted %s with %j is %s', (submitted, statuses, expected) => {
    expect(changesetStatusOf({ submitted, statuses })).toBe(expected);
  });
});
