import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadDotEnv } from '@exocortex/config';
import { createPrismaClient, type PrismaClient } from '@exocortex/database';
import { createLogger } from '@exocortex/logger';

import { raiseRunFailureAttention } from './attention';
import { type MaintenanceContext } from './context';

/**
 * The sweep that asks about failed runs (issue #139, ADR-067).
 *
 * Proven: a failed latest run behind open work raises one item for the
 * person who asked for the work, a second sweep raises nothing, and an
 * earlier failure a newer run already followed raises nothing at all.
 */
loadDotEnv();

const logger = createLogger({ name: 'attention-test', level: 'silent' });

let prisma: PrismaClient;
let workspaceId: string;
let ownerId: string;
const published: unknown[] = [];

beforeAll(async () => {
  prisma = createPrismaClient({ databaseUrl: process.env.DATABASE_URL });
  const suffix = Date.now().toString(36);
  const owner = await prisma.user.create({
    data: { email: `att-sweep-${suffix}@exocortex.test`, name: 'Owner', emailVerified: true },
  });
  ownerId = owner.id;
  const workspace = await prisma.workspace.create({
    data: {
      name: `Attention sweep ${suffix}`,
      slug: `attention-sweep-${suffix}`,
      members: { create: { userId: ownerId, role: 'OWNER' } },
    },
  });
  workspaceId = workspace.id;
});

afterAll(async () => {
  await prisma.attentionItem.deleteMany({ where: { workspaceId } });
  await prisma.aiRun.deleteMany({ where: { workspaceId } });
  await prisma.workItem.deleteMany({ where: { workspaceId } });
  await prisma.workspace.deleteMany({ where: { id: workspaceId } });
  await prisma.user.deleteMany({ where: { id: ownerId } });
  await prisma.$disconnect();
});

async function sweep(): Promise<void> {
  const context = {
    prisma,
    bus: { publish: async (event: unknown) => void published.push(event) },
    payload: { correlationId: 'test', task: 'raise-run-failure-attention' },
    logger,
  } as unknown as MaintenanceContext;
  await raiseRunFailureAttention(context);
}

async function run(workItemId: string, status: 'FAILED' | 'COMPLETED', minutesAgo: number) {
  const at = new Date(Date.now() - minutesAgo * 60_000);
  return prisma.aiRun.create({
    data: {
      workspaceId,
      createdById: ownerId,
      provider: 'mock',
      model: 'mock/model',
      messages: [],
      workItemId,
      status,
      errorCode: status === 'FAILED' ? 'ai_timeout' : null,
      createdAt: at,
      finishedAt: at,
    },
  });
}

async function workItem(title: string) {
  return prisma.workItem.create({
    data: {
      workspaceId,
      title,
      goal: title,
      requesterKind: 'HUMAN',
      requesterId: ownerId,
      assigneeKind: 'ASSISTANT',
      status: 'WORKING',
    },
  });
}

describe('raiseRunFailureAttention', () => {
  it('asks once about the latest failed run, and never about a superseded one', async () => {
    const failing = await workItem('Scheitert');
    const failed = await run(failing.id, 'FAILED', 5);

    const recovered = await workItem('Erholt sich');
    await run(recovered.id, 'FAILED', 10);
    await run(recovered.id, 'COMPLETED', 2);

    await sweep();
    await sweep();

    const items = await prisma.attentionItem.findMany({ where: { workspaceId } });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: 'RUN_FAILED',
      status: 'OPEN',
      workItemId: failing.id,
      aiRunId: failed.id,
      recipientId: ownerId,
      reason: 'ai_timeout',
      system: true,
    });
    expect(published).toHaveLength(1);
  });
});
