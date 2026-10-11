import { describe, expect, it } from 'vitest';

import { settingsSchema } from './settings';
import {
  effectiveWorkflowLimits,
  formatWorkflowOrigin,
  nextWorkflowScheduleRun,
  parseWorkflowOrigin,
  workflowRetryDelayMs,
} from './workflow-runtime';

/** The pure half of the workflow runtime (issue #161). */
describe('workflow runtime contract', () => {
  const settings = settingsSchema.parse({});

  it('takes the stricter of every graph limit and its setting', () => {
    expect(
      effectiveWorkflowLimits(
        {
          maxNodeExecutions: 10,
          maxParallelBranches: 50,
          maxLifetimeSeconds: null,
          budgetMicroUsd: 100,
        },
        settings,
      ),
    ).toEqual({
      maxNodeExecutions: 10,
      maxParallelBranches: settings['workflows.maxParallelBranches'],
      maxLifetimeSeconds: settings['workflows.maxLifetimeSeconds'],
      budgetMicroUsd: 100,
    });
  });

  it('reads a workflow origin strictly and round-trips it', () => {
    const origin = { workflowId: 'wf1', runId: 'run_1', executionId: 'ex-1', depth: 2 };
    expect(parseWorkflowOrigin(formatWorkflowOrigin(origin))).toEqual(origin);
    expect(parseWorkflowOrigin('wf1:run1:ex1')).toBeUndefined();
    expect(parseWorkflowOrigin('wf1:run1:ex1:-1')).toBeUndefined();
    expect(parseWorkflowOrigin('wf1:run1:ex1:1.5')).toBeUndefined();
    expect(parseWorkflowOrigin('wf 1:run1:ex1:1')).toBeUndefined();
    expect(parseWorkflowOrigin(undefined)).toBeUndefined();
  });

  it('backs a retry off by a factor of four', () => {
    expect([1, 2, 3].map(workflowRetryDelayMs)).toEqual([10_000, 40_000, 160_000]);
  });

  it('computes the next slot of a schedule trigger', () => {
    const after = new Date('2026-10-11T06:00:00.000Z');
    expect(
      nextWorkflowScheduleRun({ kind: 'DAILY', time: '09:30', timeZone: 'Europe/Berlin' }, after),
    ).toEqual(new Date('2026-10-11T07:30:00.000Z'));
    expect(
      nextWorkflowScheduleRun(
        { kind: 'ONCE', at: '2026-10-10T00:00:00.000Z', timeZone: 'Europe/Berlin' },
        after,
      ),
    ).toBeNull();
  });
});
