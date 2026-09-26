import { describe, expect, it } from 'vitest';

import { closedAtFor, type ExistingWorkItem, planWorkItemUpdate } from './work-item-changes';
import { buildWorkItemPrompt } from './work-item-prompt';

const now = new Date('2026-09-26T10:00:00Z');
const earlier = new Date('2026-09-20T10:00:00Z');

const open: ExistingWorkItem = {
  status: 'WAITING_FOR_HUMAN',
  statusReason: 'Wartet auf Zugang',
  assigneeKind: null,
  assigneeId: null,
  result: null,
  closedAt: null,
};

describe('closedAtFor', () => {
  it('stamps entering a closed status, keeps moving between closed ones, clears reopening', () => {
    expect(closedAtFor('WORKING', 'DONE', null, now)).toEqual(now);
    expect(closedAtFor('DONE', 'CANCELLED', earlier, now)).toEqual(earlier);
    expect(closedAtFor('FAILED', 'WORKING', earlier, now)).toBeNull();
  });
});

describe('planWorkItemUpdate', () => {
  it('drops the old reason on a transition that brings none', () => {
    const plan = planWorkItemUpdate({
      existing: open,
      request: { status: 'working' },
      assigneeName: null,
      now,
    });
    expect(plan.data).toMatchObject({ status: 'WORKING', statusReason: null, closedAt: null });
    expect(plan.events).toEqual([
      { kind: 'STATUS_CHANGED', data: { from: 'waiting_for_human', to: 'working' } },
    ]);
  });

  it('records a changed reason alone as an update, not a transition', () => {
    const plan = planWorkItemUpdate({
      existing: open,
      request: { statusReason: 'Wartet auf Freigabe' },
      assigneeName: null,
      now,
    });
    expect(plan.events).toEqual([{ kind: 'UPDATED', data: { fields: ['statusReason'] } }]);
  });

  it('separates an assignment and a result from the plain fields', () => {
    const plan = planWorkItemUpdate({
      existing: open,
      request: {
        assignee: { kind: 'agent', userId: 'agent-account-1' },
        result: 'Fertig',
        title: 'Neu',
      },
      assigneeName: 'agent-memory',
      now,
    });
    expect(plan.data).toMatchObject({
      assigneeKind: 'AGENT',
      assigneeId: 'agent-account-1',
      result: 'Fertig',
      title: 'Neu',
    });
    expect(plan.events.map((event) => event.kind)).toEqual([
      'ASSIGNED',
      'RESULT_RECORDED',
      'UPDATED',
    ]);
    expect(plan.events[0]?.data.assignee).toEqual({
      kind: 'agent',
      userId: 'agent-account-1',
      name: 'agent-memory',
    });
  });

  it('writes nothing to the history when nothing changed', () => {
    const plan = planWorkItemUpdate({
      existing: open,
      request: { status: 'waiting_for_human', assignee: null },
      assigneeName: null,
      now,
    });
    expect(plan.events).toEqual([]);
  });
});

describe('buildWorkItemPrompt', () => {
  it('names the item, its criteria, its pages and how to report back', () => {
    const prompt = buildWorkItemPrompt({
      id: 'item-1234567',
      title: 'Quellen sammeln',
      goal: 'Drei Quellen finden',
      criteria: [
        { text: 'Mit Link', met: true },
        { text: 'Deutsch', met: false },
      ],
      contextRefs: [{ documentId: 'page-1234567', title: 'Notizen' }],
      previousResult: null,
      instructions: null,
    });
    expect(prompt).toContain('Auftrag „Quellen sammeln“ (id: item-1234567)');
    expect(prompt).toContain('- [x] Mit Link');
    expect(prompt).toContain('- [ ] Deutsch');
    expect(prompt).toContain('Notizen (id: page-1234567)');
    expect(prompt).toContain('exo_work_item_update');
    expect(prompt).not.toContain('Bisheriges Ergebnis');
  });
});
