import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadDotEnv } from '@exocortex/config';
import { resolveSettings } from '@exocortex/contracts';
import { createPrismaClient, type PrismaClient } from '@exocortex/database';
import { type QueueRegistry } from '@exocortex/queue';

import { scheduleFailureNotifications } from './failure-notifications';

/**
 * Who hears that an automation stopped working, and what the mail may carry
 * (issue #107).
 *
 * The worker decides that a failure is news; this decides whether it still is
 * when the dispatcher reaches it. So the cases worth a test are the ones where
 * the world moved on in between -- the rule switched back on, the owner
 * switched off or gone from the workspace, the pair switched off -- and the
 * one guarantee a redelivered event depends on: the same row asks for the same
 * job.
 */
loadDotEnv();

let prisma: PrismaClient;
let workspaceId: string;
let ownerId: string;
let ownerEmail: string;
let ruleId: string;

const SETTINGS = resolveSettings({
  rows: [
    { key: 'automations.maxConsecutiveFailures', value: 5 },
    { key: 'notifications.digestTimeZone', value: 'Europe/Berlin' },
  ],
  env: {},
}).settings;

beforeAll(async () => {
  prisma = createPrismaClient({ databaseUrl: process.env.DATABASE_URL });
  const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  ownerEmail = `failure-${suffix}@exocortex.test`;
  const owner = await prisma.user.create({
    data: { email: ownerEmail, name: 'Johanna', emailVerified: true },
  });
  ownerId = owner.id;
  const workspace = await prisma.workspace.create({
    data: {
      name: `Fehler ${suffix}`,
      slug: `fehler-${suffix}`,
      members: { create: [{ userId: ownerId, role: 'OWNER' }] },
    },
  });
  workspaceId = workspace.id;
  const rule = await prisma.automationRule.create({
    data: {
      workspaceId,
      name: 'Hermes benachrichtigen',
      enabled: false,
      triggers: ['SCHEDULE'],
      action: 'WEBHOOK',
      webhookUrl: 'https://hooks.example.org/exocortex',
      createdById: ownerId,
    },
  });
  ruleId = rule.id;
});

afterAll(async () => {
  await prisma.workspace.deleteMany({ where: { id: workspaceId } });
  await prisma.user.deleteMany({ where: { id: ownerId } });
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.automationRule.update({ where: { id: ruleId }, data: { enabled: false } });
  await prisma.user.update({ where: { id: ownerId }, data: { disabledAt: null } });
  await prisma.notificationPreference.deleteMany({ where: { userId: ownerId } });
  await prisma.workspaceMember.upsert({
    where: { workspaceId_userId: { workspaceId, userId: ownerId } },
    create: { workspaceId, userId: ownerId, role: 'OWNER' },
    update: {},
  });
});

interface EnqueuedMail {
  recipient: string;
  mail: Record<string, unknown>;
}

async function enqueued(input: {
  type?: 'automation.disabled' | 'automation.run.failed' | 'job.failed';
  failures?: number;
  eventId?: string;
}): Promise<{ jobs: EnqueuedMail[]; jobIds: (string | undefined)[] }> {
  const enqueue = vi.fn(async () => undefined);
  await scheduleFailureNotifications(
    {
      prisma,
      queues: { enqueue } as unknown as QueueRegistry,
      appUrl: 'https://exocortex.test/',
      settings: async () => SETTINGS,
    },
    {
      eventId: input.eventId ?? 'evt1',
      workspaceId,
      type: input.type ?? 'automation.disabled',
      payload: {
        ruleId,
        runId: 'run-00000001',
        reason: 'WEBHOOK_FAILED',
        failures: input.failures ?? 5,
      },
      correlationId: 'c1',
      createdAt: new Date('2026-09-24T01:05:00.000Z'),
    },
  );
  const calls = enqueue.mock.calls as unknown as [
    string,
    EnqueuedMail,
    { jobId?: string } | undefined,
  ][];
  return { jobs: calls.map((call) => call[1]), jobIds: calls.map((call) => call[2]?.jobId) };
}

describe('scheduleFailureNotifications', () => {
  it('writes to the owner once per event, with a reason and a link to the rules', async () => {
    const { jobs, jobIds } = await enqueued({});
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.recipient).toBe(ownerEmail);
    expect(jobs[0]?.mail).toMatchObject({
      template: 'AUTOMATION_DISABLED',
      ruleName: 'Hermes benachrichtigen',
      reason: 'WEBHOOK_FAILED',
      failures: 5,
      occurredAt: '2026-09-24T01:05:00.000Z',
      timeZone: 'Europe/Berlin',
      url: `https://exocortex.test/arbeitsbereich/${workspaceId}/automationen`,
    });
    expect(jobIds).toEqual(['failure-mail-evt1']);
  });

  it('counts down to the switch-off after a failed scheduled run', async () => {
    await prisma.automationRule.update({ where: { id: ruleId }, data: { enabled: true } });
    const { jobs } = await enqueued({ type: 'automation.run.failed', failures: 1 });
    expect(jobs[0]?.mail).toMatchObject({
      template: 'AUTOMATION_RUN_FAILED',
      failuresUntilDisabled: 4,
    });
  });

  it('does not announce a switch-off its owner has already undone', async () => {
    await prisma.automationRule.update({ where: { id: ruleId }, data: { enabled: true } });
    expect((await enqueued({})).jobs).toHaveLength(0);
  });

  it('does not write to a switched-off account', async () => {
    await prisma.user.update({ where: { id: ownerId }, data: { disabledAt: new Date() } });
    expect((await enqueued({})).jobs).toHaveLength(0);
  });

  it('does not write to somebody who left the workspace', async () => {
    await prisma.workspaceMember.deleteMany({ where: { workspaceId, userId: ownerId } });
    expect((await enqueued({})).jobs).toHaveLength(0);
  });

  it('enqueues nothing once the owner switched the pair off', async () => {
    await prisma.notificationPreference.create({
      data: { userId: ownerId, kind: 'FAILURE', channel: 'EMAIL', mode: 'OFF' },
    });
    expect((await enqueued({})).jobs).toHaveLength(0);
  });

  it('ignores every other event, a failed queue job included', async () => {
    expect((await enqueued({ type: 'job.failed' })).jobs).toHaveLength(0);
  });
});
