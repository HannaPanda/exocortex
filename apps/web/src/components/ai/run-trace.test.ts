import { describe, expect, it } from 'vitest';

import {
  appendReasoning,
  appendToolEvent,
  hasReasoning,
  type RunTraceStep,
  toolEntries,
} from './run-trace';

describe('run trace', () => {
  it('continues the thinking of one turn and opens a new step for the next', () => {
    let steps: RunTraceStep[] = [];
    steps = appendReasoning(steps, 1, 'Ich ');
    steps = appendReasoning(steps, 1, 'schaue nach.');
    steps = appendToolEvent(steps, 0, { toolName: 'exo_search', status: 'started', target: null });
    steps = appendReasoning(steps, 2, 'Gefunden.');

    expect(
      steps.map((step) => (step.kind === 'reasoning' ? step.text : step.entry.toolName)),
    ).toEqual(['Ich schaue nach.', 'exo_search', 'Gefunden.']);
  });

  it('turns a call announcement into its outcome instead of adding a second line', () => {
    let steps: RunTraceStep[] = [];
    steps = appendToolEvent(steps, 0, {
      toolName: 'exo_page_read',
      status: 'started',
      target: null,
    });
    steps = appendToolEvent(steps, 0, {
      toolName: 'exo_page_read',
      status: 'succeeded',
      target: 'document:abc',
    });

    expect(toolEntries(steps)).toEqual([
      expect.objectContaining({
        toolName: 'exo_page_read',
        status: 'succeeded',
        target: 'document:abc',
      }),
    ]);
  });

  it('keeps two parallel calls of one tool apart, in order', () => {
    let steps: RunTraceStep[] = [];
    steps = appendToolEvent(steps, 0, { toolName: 'get', status: 'started', target: 'a' });
    steps = appendToolEvent(steps, 0, { toolName: 'get', status: 'started', target: 'b' });
    steps = appendToolEvent(steps, 0, { toolName: 'get', status: 'failed', target: 'a' });

    const entries = toolEntries(steps);
    expect(entries.map((entry) => [entry.target, entry.status])).toEqual([
      ['a', 'failed'],
      ['b', 'started'],
    ]);
    expect(new Set(entries.map((entry) => entry.key)).size).toBe(2);
  });

  it('does not match an outcome to a call of an earlier iteration', () => {
    let steps: RunTraceStep[] = [];
    steps = appendToolEvent(steps, 0, { toolName: 'get', status: 'started', target: null });
    steps = appendToolEvent(steps, 1, { toolName: 'get', status: 'succeeded', target: null });

    expect(toolEntries(steps).map((entry) => entry.status)).toEqual(['started', 'succeeded']);
  });

  it('says whether there was any thinking at all', () => {
    const toolsOnly = appendToolEvent([], 0, { toolName: 'get', status: 'started', target: null });
    expect(hasReasoning(toolsOnly)).toBe(false);
    expect(hasReasoning(appendReasoning(toolsOnly, 1, 'Hm.'))).toBe(true);
  });
});
