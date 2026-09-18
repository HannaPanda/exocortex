import { describe, expect, it } from 'vitest';

import { type PrismaClient } from '@exocortex/database';
import { createLogger } from '@exocortex/logger';
import { type QueueRegistry } from '@exocortex/queue';

import { runDueAutomations } from './automation-schedules';
import { type MaintenanceContext } from './context';

const logger = createLogger({ name: 'worker-test', level: 'silent' });

interface StubRule {
  id: string;
  workspaceId: string;
  scopeDocumentId: string | null;
  nextRunAt: Date | null;
  scheduleKind: 'ONCE' | 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'CRON' | null;
  scheduleAt: Date | null;
  scheduleTime: string | null;
  scheduleWeekday: number | null;
  scheduleDayOfMonth: number | null;
  scheduleCron: string | null;
  scheduleTimeZone: string | null;
}

/**
 * The sweep with a list of rules behind it (issue #73).
 *
 * What is worth testing here is the order of two writes, not a query: the rule
 * has to be moved on before it is queued, and the move has to be a claim that
 * exactly one worker wins.
 */
function harness(rules: StubRule[], options: { claimFails?: boolean } = {}) {
  const queued: Record<string, unknown>[] = [];
  const updates: { id: string; data: Record<string, unknown>; guarded: boolean }[] = [];

  const prisma = {
    automationRule: {
      findMany: async () => rules,
      updateMany: async ({
        where,
        data,
      }: {
        where: { id: string; nextRunAt?: Date | null };
        data: Record<string, unknown>;
      }) => {
        updates.push({ id: where.id, data, guarded: 'nextRunAt' in where });
        return { count: options.claimFails === true ? 0 : 1 };
      },
    },
  } as unknown as PrismaClient;

  const queues = {
    enqueue: async (_name: string, payload: Record<string, unknown>) => {
      queued.push(payload);
      return 'job';
    },
  } as unknown as QueueRegistry;

  const context = {
    prisma,
    queues,
    logger,
    payload: { workspaceId: null },
  } as unknown as MaintenanceContext;

  return { context, queued, updates };
}

function dailyRule(overrides: Partial<StubRule> = {}): StubRule {
  return {
    id: 'rule1',
    workspaceId: 'ws1',
    scopeDocumentId: 'doc1',
    nextRunAt: new Date('2026-03-10T06:00:00.000Z'),
    scheduleKind: 'DAILY',
    scheduleAt: null,
    scheduleTime: '07:00',
    scheduleWeekday: null,
    scheduleDayOfMonth: null,
    scheduleCron: null,
    scheduleTimeZone: 'Europe/Berlin',
    ...overrides,
  };
}

describe('the schedule sweep', () => {
  it('queues a due rule against its own page and moves it on', async () => {
    const { context, queued, updates } = harness([dailyRule()]);
    await runDueAutomations(context);

    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      ruleId: 'rule1',
      documentId: 'doc1',
      trigger: 'SCHEDULE',
      origin: 'SCHEDULE',
      runId: null,
      depth: 0,
    });
    expect(updates).toHaveLength(1);
    expect(updates[0]?.guarded).toBe(true);
    expect((updates[0]?.data.nextRunAt as Date).getTime()).toBeGreaterThan(Date.now());
  });

  it('queues nothing when another worker won the claim', async () => {
    const { context, queued } = harness([dailyRule()], { claimFails: true });
    await runDueAutomations(context);
    expect(queued).toEqual([]);
  });

  it('catches up once rather than for every slot it slept through', async () => {
    const { context, queued } = harness([
      dailyRule({ nextRunAt: new Date('2026-01-01T06:00:00.000Z') }),
    ]);
    await runDueAutomations(context);
    expect(queued).toHaveLength(1);
  });

  it('stops a one-off instead of running it again', async () => {
    const { context, updates } = harness([
      dailyRule({
        scheduleKind: 'ONCE',
        scheduleAt: new Date('2026-03-10T06:00:00.000Z'),
        scheduleTime: null,
      }),
    ]);
    await runDueAutomations(context);
    expect(updates[0]?.data.nextRunAt).toBeNull();
  });

  it('disarms a rule with no page to act on rather than queueing a job without one', async () => {
    const { context, queued, updates } = harness([dailyRule({ scopeDocumentId: null })]);
    await runDueAutomations(context);
    expect(queued).toEqual([]);
    expect(updates[0]).toMatchObject({ id: 'rule1', data: { nextRunAt: null }, guarded: false });
  });
});
