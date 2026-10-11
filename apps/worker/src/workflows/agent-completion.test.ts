import { describe, expect, it } from 'vitest';

import { type WorkflowNodeOf } from '@exocortex/contracts';

import { agentCompletion, type AgentWork, STALL_AFTER_MS } from './agent-completion';
import { renderGoalTemplate } from './goal-template';

const now = new Date('2026-10-11T12:00:00Z');

const node: Pick<WorkflowNodeOf<'agent'>, 'completion' | 'outputFields'> = {
  completion: 'review',
  outputFields: [{ name: 'score', type: 'number', values: [], required: true }],
};

function work(overrides: Partial<AgentWork> = {}): AgentWork {
  return {
    id: 'w1',
    status: 'WORKING',
    result: null,
    resultFields: [],
    structuredResult: { score: 8 },
    awaitingSince: null,
    refs: [],
    runs: [{ id: 'r1', status: 'RUNNING', finishedAt: null, agentProfileSnapshot: null }],
    changesets: [],
    ...overrides,
  };
}

function finishedRun(agoMs: number, snapshot: unknown = null): AgentWork['runs'][number] {
  return {
    id: 'r1',
    status: 'COMPLETED',
    finishedAt: new Date(now.getTime() - agoMs),
    agentProfileSnapshot: snapshot as AgentWork['runs'][number]['agentProfileSnapshot'],
  };
}

/** Which state of the work item finishes an agent node (issue #162, ADR-077). */
describe('agentCompletion', () => {
  it('completes on done and on review when the node asks for review', () => {
    expect(agentCompletion(node, work({ status: 'DONE' }), now)).toMatchObject({
      kind: 'complete',
      outcome: 'done',
      fields: { score: 8 },
    });
    expect(agentCompletion(node, work({ status: 'REVIEW' }), now)).toMatchObject({
      kind: 'complete',
      outcome: 'review',
    });
  });

  it('waits in review while a person still has to decide', () => {
    const doneOnly = { ...node, completion: 'done' as const };
    expect(agentCompletion(doneOnly, work({ status: 'REVIEW' }), now).kind).toBe('wait');
    expect(
      agentCompletion(node, work({ status: 'REVIEW', changesets: [{ id: 'c1' }] }), now).kind,
    ).toBe('wait');
    const reviewProfile = finishedRun(0, {
      id: 'profile_review_1',
      name: 'Prüfer',
      revision: 1,
      source: 'work_item',
      writeMode: 'propose',
      approvalPolicy: 'review_before_done',
      toolDomains: null,
      modelSlug: null,
      reasoningLevel: null,
      budgetMicroUsdPerRun: null,
      budgetMicroUsdPerTask: null,
      maxToolIterations: null,
      maxRunSeconds: null,
      confineToWorkspace: true,
    });
    const underReviewProfile = agentCompletion(
      node,
      work({ status: 'REVIEW', runs: [reviewProfile] }),
      now,
    );
    expect(underReviewProfile.kind).toBe('wait');
    // Handed in without its fields: the person reviewing decides, it is no failure yet.
    expect(
      agentCompletion(node, work({ status: 'REVIEW', structuredResult: null }), now).kind,
    ).toBe('wait');
  });

  it('fails a closed item whose fields do not hold, whatever the item says', () => {
    expect(
      agentCompletion(node, work({ status: 'DONE', structuredResult: { score: 'acht' } }), now),
    ).toMatchObject({ kind: 'fail', code: 'workflow_output_invalid' });
    expect(
      agentCompletion(
        node,
        work({ status: 'DONE', structuredResult: { score: 8, extra: 1 } }),
        now,
      ),
    ).toMatchObject({ kind: 'fail', code: 'workflow_output_invalid' });
  });

  it('fails failed, cancelled and deleted work', () => {
    expect(agentCompletion(node, work({ status: 'FAILED' }), now)).toMatchObject({
      code: 'workflow_work_item_failed',
    });
    expect(agentCompletion(node, work({ status: 'CANCELLED' }), now)).toMatchObject({
      code: 'workflow_work_item_cancelled',
    });
    expect(agentCompletion(node, null, now)).toMatchObject({ code: 'workflow_work_item_gone' });
  });

  it('waits on open work while something can still move it, and calls the rest stalled', () => {
    expect(agentCompletion(node, work(), now).kind).toBe('wait');
    expect(
      agentCompletion(
        node,
        work({ status: 'WAITING_FOR_HUMAN', runs: [finishedRun(STALL_AFTER_MS * 10)] }),
        now,
      ).kind,
    ).toBe('wait');
    expect(
      agentCompletion(
        node,
        work({ awaitingSince: now, runs: [finishedRun(STALL_AFTER_MS * 2)] }),
        now,
      ).kind,
    ).toBe('wait');
    expect(
      agentCompletion(node, work({ runs: [finishedRun(STALL_AFTER_MS - 1_000)] }), now).kind,
    ).toBe('wait');
    expect(agentCompletion(node, work({ runs: [finishedRun(STALL_AFTER_MS)] }), now)).toMatchObject(
      {
        kind: 'fail',
        code: 'workflow_work_item_stalled',
      },
    );
  });
});

describe('renderGoalTemplate', () => {
  const outputs = new Map<string, Record<string, unknown> | null>([
    ['review', { fields: { score: 8, verdict: 'go' }, summary: 'ignored' }],
  ]);

  it('fills fields of upstream agents and the run input', () => {
    expect(
      renderGoalTemplate('Plan {{review.verdict}} ({{ review.score }}) for {{input.documentId}}', {
        input: { documentId: 'doc1' },
        outputs,
      }),
    ).toBe('Plan go (8) for doc1');
  });

  it('leaves what nothing fills, and never reads beyond fields', () => {
    expect(
      renderGoalTemplate('{{review.summary}} {{other.score}} {{input.missing}}', {
        input: null,
        outputs,
      }),
    ).toBe('{{review.summary}} {{other.score}} {{input.missing}}');
  });
});
