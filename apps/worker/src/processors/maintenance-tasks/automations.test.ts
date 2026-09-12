import { describe, expect, it } from 'vitest';

import { type PrismaClient } from '@exocortex/database';
import { createLogger } from '@exocortex/logger';
import { type QueueRegistry } from '@exocortex/queue';

import {
  type AutomationEvent,
  type AutomationMatchContext,
  fireMatchingAutomations,
  triggerForEvent,
} from './automations';

const logger = createLogger({ name: 'worker-test', level: 'silent' });

interface StubRule {
  id: string;
  scope: 'WORKSPACE' | 'SUBTREE' | 'DATABASE';
  scopeDocumentId: string | null;
  debounceSeconds: number;
  triggers: string[];
}

/**
 * A page tree and a set of rules, with no database behind either.
 *
 * The two things worth testing here are decisions, not queries: does this event
 * reach this rule, and does a rule ever see the write its own action made. Both
 * are answerable from a parent map and a list.
 */
function harness(input: {
  rules: StubRule[];
  /** `id -> parentId`, root pages mapping to null. */
  tree?: Record<string, string | null>;
  enabled?: boolean;
}) {
  const queued: { jobId: string; payload: Record<string, unknown>; delayMs: number }[] = [];
  const tree = input.tree ?? {};

  const prisma = {
    automationRule: {
      findMany: async ({ where }: { where: { triggers: { has: string } } }) =>
        input.rules.filter((rule) => rule.triggers.includes(where.triggers.has)),
    },
    document: {
      findFirst: async ({ where }: { where: { id: string } }) =>
        where.id in tree ? { parentId: tree[where.id] ?? null } : null,
    },
  } as unknown as PrismaClient;

  const queues = {
    enqueueDebounced: async (
      _name: string,
      payload: Record<string, unknown>,
      options: { jobId: string; delayMs: number },
    ) => {
      queued.push({ jobId: options.jobId, payload, delayMs: options.delayMs });
      return options.jobId;
    },
  } as unknown as QueueRegistry;

  const context: AutomationMatchContext = {
    prisma,
    queues,
    logger,
    enabledFor: async () => input.enabled ?? true,
  };
  return { context, queued };
}

function event(overrides: Partial<AutomationEvent> = {}): AutomationEvent {
  return {
    workspaceId: 'workspace-1',
    type: 'document.materialized',
    payload: { documentId: 'page-child' },
    correlationId: 'test',
    automationRuleId: null,
    automationDepth: 0,
    ...overrides,
  };
}

const workspaceRule: StubRule = {
  id: 'rule-workspace',
  scope: 'WORKSPACE',
  scopeDocumentId: null,
  debounceSeconds: 60,
  triggers: ['DOCUMENT_CONTENT_CHANGED'],
};

describe('triggerForEvent', () => {
  it('maps the page events a person can describe', () => {
    expect(triggerForEvent('document.created')).toBe('DOCUMENT_CREATED');
    expect(triggerForEvent('document.materialized')).toBe('DOCUMENT_CONTENT_CHANGED');
    expect(triggerForEvent('document.content.replaced')).toBe('DOCUMENT_CONTENT_CHANGED');
    expect(triggerForEvent('database.row.updated')).toBe('DATABASE_ROW_CHANGED');
  });

  it('ignores the system talking about itself', () => {
    // A rule firing on these would be reacting to bookkeeping, not to a page.
    expect(triggerForEvent('job.progress')).toBeNull();
    expect(triggerForEvent('ai.run.completed')).toBeNull();
    expect(triggerForEvent('comment.created')).toBeNull();
    expect(triggerForEvent('document.cover.generated')).toBeNull();
  });
});

describe('matching an event against rules', () => {
  it('fires a workspace rule and debounces it under one job per page', async () => {
    const { context, queued } = harness({ rules: [workspaceRule] });
    expect(await fireMatchingAutomations(context, event())).toBe(1);
    expect(queued).toHaveLength(1);
    expect(queued[0]?.jobId).toBe('automation-rule-workspace-page-child');
    expect(queued[0]?.delayMs).toBe(60_000);
    expect(queued[0]?.payload).toMatchObject({ runId: null, depth: 1 });
  });

  it('does nothing while automations are switched off', async () => {
    const { context, queued } = harness({ rules: [workspaceRule], enabled: false });
    expect(await fireMatchingAutomations(context, event())).toBe(0);
    expect(queued).toHaveLength(0);
  });

  it('ignores an event no trigger covers', async () => {
    const { context, queued } = harness({ rules: [workspaceRule] });
    await fireMatchingAutomations(context, event({ type: 'comment.created' }));
    expect(queued).toHaveLength(0);
  });

  it('reaches a page below the scope, and stops at the workspace boundary', async () => {
    const subtree: StubRule = {
      id: 'rule-subtree',
      scope: 'SUBTREE',
      scopeDocumentId: 'page-root',
      debounceSeconds: 30,
      triggers: ['DOCUMENT_CONTENT_CHANGED'],
    };
    const { context, queued } = harness({
      rules: [subtree],
      tree: {
        'page-child': 'page-middle',
        'page-middle': 'page-root',
        'page-root': null,
        'page-elsewhere': null,
      },
    });

    expect(await fireMatchingAutomations(context, event())).toBe(1);
    queued.length = 0;

    await fireMatchingAutomations(context, event({ payload: { documentId: 'page-elsewhere' } }));
    expect(queued).toHaveLength(0);
  });

  it('includes the scope page itself', async () => {
    const subtree: StubRule = {
      id: 'rule-subtree',
      scope: 'SUBTREE',
      scopeDocumentId: 'page-root',
      debounceSeconds: 30,
      triggers: ['DOCUMENT_UPDATED'],
    };
    const { context, queued } = harness({ rules: [subtree], tree: { 'page-root': null } });
    await fireMatchingAutomations(
      context,
      event({ type: 'document.updated', payload: { documentId: 'page-root' } }),
    );
    expect(queued).toHaveLength(1);
  });

  it('acts on the row, not on the database, when a row changes', async () => {
    const rule: StubRule = {
      id: 'rule-db',
      scope: 'DATABASE',
      scopeDocumentId: 'collection-1',
      debounceSeconds: 10,
      triggers: ['DATABASE_ROW_CHANGED'],
    };
    const { context, queued } = harness({
      rules: [rule],
      tree: { 'row-1': 'collection-1', 'collection-1': null },
    });

    await fireMatchingAutomations(
      context,
      event({
        type: 'database.row.updated',
        // The payload names the collection for clients and the row for us.
        payload: { documentId: 'collection-1', rowId: 'row-1' },
      }),
    );
    expect(queued[0]?.payload).toMatchObject({ documentId: 'row-1' });
  });

  it('never lets a rule react to its own write', async () => {
    const { context, queued } = harness({ rules: [workspaceRule] });
    const fired = await fireMatchingAutomations(
      context,
      event({ automationRuleId: 'rule-workspace', automationDepth: 1 }),
    );
    expect(fired).toBe(0);
    expect(queued).toHaveLength(0);
  });

  it('still lets a different rule react to that write, once', async () => {
    const other: StubRule = { ...workspaceRule, id: 'rule-other' };
    const { context, queued } = harness({ rules: [workspaceRule, other] });
    const fired = await fireMatchingAutomations(
      context,
      event({ automationRuleId: 'rule-workspace', automationDepth: 1 }),
    );
    expect(fired).toBe(1);
    expect(queued[0]?.payload).toMatchObject({ ruleId: 'rule-other', depth: 2 });
  });

  it('stops a chain that has gone deep enough', async () => {
    const { context, queued } = harness({ rules: [workspaceRule] });
    const fired = await fireMatchingAutomations(context, event({ automationDepth: 3 }));
    expect(fired).toBe(0);
    expect(queued).toHaveLength(0);
  });
});
