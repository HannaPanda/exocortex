import { describe, expect, it } from 'vitest';

import {
  heardFromRun,
  heardToolCall,
  NO_RUN_PRESENCE,
  presenceOn,
  RUN_PRESENCE_SILENCE_MS,
  runEnded,
} from './page-run-presence';

const call = (
  runId: string,
  subject: string | null,
  overrides: Partial<Parameters<typeof heardToolCall>[1]> = {},
) => ({ runId, status: 'started' as const, target: null, subject, ...overrides });

describe('which run is on which page (issue #248)', () => {
  it('puts a run on the page its latest tool call is about', () => {
    const state = heardToolCall(NO_RUN_PRESENCE, call('run1', 'document:page1'), 0);
    expect(presenceOn(state, 'page1', 10)).toEqual({ writing: false });
    expect(presenceOn(state, 'page2', 10)).toBeNull();
  });

  it('says writing when the call changes the page', () => {
    const state = heardToolCall(
      NO_RUN_PRESENCE,
      call('run1', 'document:page1', { target: 'document:page1' }),
      0,
    );
    expect(presenceOn(state, 'page1', 10)).toEqual({ writing: true });
  });

  it('takes the run off the page with its next call elsewhere, or about no page', () => {
    let state = heardToolCall(NO_RUN_PRESENCE, call('run1', 'document:page1'), 0);
    state = heardToolCall(state, call('run1', 'document:page2'), 5);
    expect(presenceOn(state, 'page1', 10)).toBeNull();
    state = heardToolCall(state, call('run1', null), 6);
    expect(presenceOn(state, 'page2', 10)).toBeNull();
  });

  it('does not count a call that failed or was refused', () => {
    const state = heardToolCall(
      NO_RUN_PRESENCE,
      call('run1', 'document:page1', { status: 'refused' }),
      0,
    );
    expect(presenceOn(state, 'page1', 10)).toBeNull();
  });

  it('forgets a run when it ends, and one that has been silent too long', () => {
    const state = heardToolCall(NO_RUN_PRESENCE, call('run1', 'document:page1'), 0);
    expect(presenceOn(runEnded(state, 'run1'), 'page1', 10)).toBeNull();
    expect(presenceOn(state, 'page1', RUN_PRESENCE_SILENCE_MS + 1)).toBeNull();
    const alive = heardFromRun(state, 'run1', RUN_PRESENCE_SILENCE_MS);
    expect(presenceOn(alive, 'page1', RUN_PRESENCE_SILENCE_MS + 1)).toEqual({ writing: false });
  });

  it('keeps two runs on one page apart', () => {
    let state = heardToolCall(NO_RUN_PRESENCE, call('run1', 'document:page1'), 0);
    state = heardToolCall(state, call('run2', 'document:page1', { target: 'document:page1' }), 1);
    expect(presenceOn(state, 'page1', 2)).toEqual({ writing: true });
    expect(presenceOn(runEnded(state, 'run2'), 'page1', 2)).toEqual({ writing: false });
  });
});
