import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadDotEnv } from '@exocortex/config';
import { createPrismaClient, type PrismaClient } from '@exocortex/database';
import { createLogger } from '@exocortex/logger';

import { type MaintenanceContext } from './context';
import { checkpointInterruptedRuns } from './work-checkpoints';

/**
 * The sweep that records where interrupted work stood (issue #142, ADR-069).
 *
 * Proven: an unfinished latest run behind open work leaves one system
 * checkpoint that carries the last recorded state forward and names the
 * run's error and its last tool call; a second sweep writes nothing, and a
 * run a newer one already followed is left alone.
 */
loadDotEnv();

const logger = createLogger({ name: 'work-checkpoints-test', level: 'silent' });

let prisma: PrismaClient;
let workspaceId: string;
let ownerId: string;

beforeAll(async () => {
  prisma = createPrismaClient({ databaseUrl: process.env.DATABASE_URL });
  const suffix = Date.now().toString(36);
  const owner = await prisma.user.create({
    data: { email: `wcp-sweep-${suffix}@exocortex.test`, name: 'Owner', emailVerified: true },
  });
  ownerId = owner.id;
  const workspace = await prisma.workspace.create({
    data: {
      name: `Checkpoint sweep ${suffix}`,
      slug: `checkpoint-sweep-${suffix}`,
      members: { create: { userId: ownerId, role: 'OWNER' } },
    },
  });
  workspaceId = workspace.id;
});

afterAll(async () => {
  await prisma.aiRun.deleteMany({ where: { workspaceId } });
  await prisma.workItem.deleteMany({ where: { workspaceId } });
  await prisma.aiConversation.deleteMany({ where: { workspaceId } });
  await prisma.workspace.deleteMany({ where: { id: workspaceId } });
  await prisma.user.deleteMany({ where: { id: ownerId } });
  await prisma.$disconnect();
});

async function sweep(): Promise<void> {
  const context = {
    prisma,
    payload: { correlationId: 'test', task: 'checkpoint-interrupted-runs' },
    logger,
  } as unknown as MaintenanceContext;
  await checkpointInterruptedRuns(context);
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

async function run(
  workItemId: string,
  status: 'FAILED' | 'COMPLETED',
  minutesAgo: number,
  conversationId: string | null = null,
) {
  const at = new Date(Date.now() - minutesAgo * 60_000);
  return prisma.aiRun.create({
    data: {
      workspaceId,
      createdById: ownerId,
      provider: 'openrouter',
      model: 'vendor/first-model',
      messages: [],
      workItemId,
      conversationId,
      status,
      errorCode: status === 'FAILED' ? 'ai_provider_unavailable' : null,
      createdAt: at,
      finishedAt: at,
    },
  });
}

describe('checkpointInterruptedRuns', () => {
  it('carries the last state forward once, and only for the latest run', async () => {
    const item = await workItem('Unterbrochen');
    await prisma.workItemCheckpoint.create({
      data: {
        workItemId: item.id,
        trigger: 'STEP',
        authorKind: 'ASSISTANT',
        authorId: ownerId,
        summary: 'Hälfte geschafft.',
        state: { plan: [{ text: 'Erste Hälfte', status: 'done' }] },
        createdAt: new Date(Date.now() - 30 * 60_000),
      },
    });
    const conversation = await prisma.aiConversation.create({
      data: { workspaceId, createdById: ownerId, title: 'Lauf' },
    });
    const failed = await run(item.id, 'FAILED', 5, conversation.id);
    await prisma.aiConversationMessage.create({
      data: {
        conversationId: conversation.id,
        role: 'TOOL',
        content: 'ok',
        toolName: 'exo_page_write',
        runId: failed.id,
      },
    });

    const recovered = await workItem('Erholt sich');
    await run(recovered.id, 'FAILED', 10);
    await run(recovered.id, 'COMPLETED', 2);

    await sweep();
    await sweep();

    const written = await prisma.workItemCheckpoint.findMany({
      where: { workItem: { workspaceId }, trigger: 'RUN_INTERRUPTED' },
    });
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      workItemId: item.id,
      aiRunId: failed.id,
      system: true,
      summary: 'Hälfte geschafft.',
      interruptionCode: 'ai_provider_unavailable',
      provider: 'openrouter',
      model: 'vendor/first-model',
    });
    expect(written[0]?.state).toMatchObject({
      plan: [{ text: 'Erste Hälfte', status: 'done' }],
      lastAction: expect.stringContaining('exo_page_write'),
    });
    const events = await prisma.workItemEvent.count({
      where: { workItemId: item.id, kind: 'CHECKPOINT_RECORDED' },
    });
    expect(events).toBe(1);
  });
});
