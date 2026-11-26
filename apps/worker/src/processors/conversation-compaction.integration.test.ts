import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type AiProvider, MockAiProvider } from '@exocortex/ai';
import { loadWorkerEnv } from '@exocortex/config';
import { type ConversationCompactionJob, settingsSchema } from '@exocortex/contracts';
import { createPrismaClient, type PrismaClient } from '@exocortex/database';
import { createLogger, type Logger } from '@exocortex/logger';
import { type JobContext, type RedisEventBus } from '@exocortex/queue';

import { WorkspaceKeyUnreadableError } from '../ai-key';
import { compactOnRequest } from '../compaction';

import { createConversationCompactionProcessor } from './conversation-compaction';

/**
 * The compaction a person asks for (issue #287): `/compact` and
 * `exo_chat_compact` end up here, in the worker, because the summary is a
 * provider call. What matters is that it summarises however empty the window
 * is, retires every message it summarised, and always gives the conversation
 * back, whatever came of it.
 */
const logger: Logger = createLogger({ name: 'worker-test', level: 'silent' });

let prisma: PrismaClient;
let workspaceId: string;
let userId: string;

type Published = { type: string; payload: Record<string, unknown> }[];

function recordingBus(published: Published): RedisEventBus {
  return {
    publish: async (event: { type: string; payload: Record<string, unknown> }) => {
      published.push(event);
    },
  } as unknown as RedisEventBus;
}

async function conversationWith(messageCount: number): Promise<string> {
  const conversation = await prisma.aiConversation.create({
    data: { workspaceId, createdById: userId, title: 'Zusammenfassen auf Wunsch' },
  });
  const now = Date.now();
  for (let index = 0; index < messageCount; index += 1) {
    await prisma.aiConversationMessage.create({
      data: {
        conversationId: conversation.id,
        role: index % 2 === 0 ? 'USER' : 'ASSISTANT',
        content: `Nachricht ${index}`,
        estimatedTokens: 5,
        createdAt: new Date(now + index),
      },
    });
  }
  return conversation.id;
}

function processorWith(provider: AiProvider | Error, published: Published) {
  return createConversationCompactionProcessor({
    prisma,
    bus: recordingBus(published),
    settings: async () => settingsSchema.parse({}),
    providerFor: async () => {
      if (provider instanceof Error) throw provider;
      return { provider, key: { apiKey: 'test-key', usedOwnKey: false } };
    },
  });
}

function contextFor(conversationId: string): JobContext<'conversation-compaction'> {
  const payload: ConversationCompactionJob = {
    correlationId: 'test-requested-compaction',
    conversationId,
    workspaceId,
    userId,
    model: 'exocortex-mock-1',
    provider: 'mock',
  };
  return {
    payload,
    job: { id: 'test-job', attemptsMade: 0 },
    logger,
    reportProgress: async () => undefined,
  } as unknown as JobContext<'conversation-compaction'>;
}

beforeAll(async () => {
  const env = loadWorkerEnv();
  prisma = createPrismaClient({ databaseUrl: env.DATABASE_URL });
  const suffix = Date.now().toString(36);
  const user = await prisma.user.create({
    data: { email: `compact-${suffix}@exocortex.test`, name: 'Compact', emailVerified: true },
  });
  userId = user.id;
  const workspace = await prisma.workspace.create({
    data: {
      name: `Compaction ${suffix}`,
      slug: `compaction-${suffix}`,
      members: { create: [{ userId, role: 'OWNER' }] },
    },
  });
  workspaceId = workspace.id;
}, 30_000);

afterAll(async () => {
  await prisma.workspace.deleteMany({ where: { id: workspaceId } });
  await prisma.user.deleteMany({ where: { id: userId } });
  await prisma.$disconnect();
});

describe('compactOnRequest', () => {
  it('summarises every message in the context, however small it is', async () => {
    const conversationId = await conversationWith(4);
    const published: Published = [];
    const result = await compactOnRequest({
      prisma,
      provider: new MockAiProvider({ chunkDelayMs: 0, fixedResponse: 'Vier kurze Nachrichten.' }),
      bus: recordingBus(published),
      conversationId,
      workspaceId,
      summaryModel: 'exocortex-mock-1',
      correlationId: 'test-on-request-1',
    });

    expect(result).toEqual({ outcome: 'compacted', summarizedMessages: 4 });
    const active = await prisma.aiConversationMessage.findMany({
      where: { conversationId, supersededAt: null },
    });
    expect(active).toHaveLength(1);
    expect(active[0]?.isSummary).toBe(true);
    expect(active[0]?.content).toContain('Vier kurze Nachrichten.');
    // Not a run: nothing announces a phase, only the result is published.
    expect(published.map((event) => event.type)).toEqual(['ai.conversation.compacted']);
  }, 30_000);

  it('has nothing to do with fewer than two messages in the context', async () => {
    const conversationId = await conversationWith(1);
    const result = await compactOnRequest({
      prisma,
      provider: new MockAiProvider({ chunkDelayMs: 0 }),
      bus: recordingBus([]),
      conversationId,
      workspaceId,
      summaryModel: 'exocortex-mock-1',
      correlationId: 'test-on-request-2',
    });
    expect(result).toEqual({ outcome: 'nothing_to_compact' });
  }, 30_000);

  it('retires nothing when the summariser answers with an empty text', async () => {
    const conversationId = await conversationWith(4);
    const result = await compactOnRequest({
      prisma,
      provider: new MockAiProvider({ chunkDelayMs: 0, fixedResponse: '   ' }),
      bus: recordingBus([]),
      conversationId,
      workspaceId,
      summaryModel: 'exocortex-mock-1',
      correlationId: 'test-on-request-3',
    });
    expect(result.outcome).toBe('provider_failed');
    const active = await prisma.aiConversationMessage.count({
      where: { conversationId, supersededAt: null },
    });
    expect(active).toBe(4);
  }, 30_000);
});

describe('createConversationCompactionProcessor', () => {
  it('writes the summary and gives the conversation back', async () => {
    const conversationId = await conversationWith(4);
    await prisma.aiConversation.update({
      where: { id: conversationId },
      data: { compactRequestedAt: new Date(), compactionError: 'provider_failed' },
    });
    const published: Published = [];
    const provider = new MockAiProvider({ chunkDelayMs: 0, fixedResponse: 'Zusammengefasst.' });

    await processorWith(provider, published)(contextFor(conversationId));

    const row = await prisma.aiConversation.findUniqueOrThrow({ where: { id: conversationId } });
    expect(row.compactRequestedAt).toBeNull();
    expect(row.compactionError).toBeNull();
    expect(published.map((event) => event.type)).toEqual(['ai.conversation.compacted']);
  }, 30_000);

  it('records an unreadable workspace key, sends nothing, and says so', async () => {
    const conversationId = await conversationWith(4);
    await prisma.aiConversation.update({
      where: { id: conversationId },
      data: { compactRequestedAt: new Date() },
    });
    const published: Published = [];

    await processorWith(
      new WorkspaceKeyUnreadableError('undecryptable'),
      published,
    )(contextFor(conversationId));

    const row = await prisma.aiConversation.findUniqueOrThrow({ where: { id: conversationId } });
    expect(row.compactRequestedAt).toBeNull();
    expect(row.compactionError).toBe('key_unreadable');
    expect(published).toEqual([
      expect.objectContaining({
        type: 'ai.conversation.compaction_failed',
        payload: { conversationId, errorCode: 'key_unreadable' },
      }),
    ]);
    const active = await prisma.aiConversationMessage.count({
      where: { conversationId, supersededAt: null },
    });
    expect(active).toBe(4);
  }, 30_000);

  it('leaves alone a request that is gone or has outlived its lease', async () => {
    const conversationId = await conversationWith(4);
    await prisma.aiConversation.update({
      where: { id: conversationId },
      data: { compactRequestedAt: new Date(Date.now() - 10 * 60_000) },
    });
    const published: Published = [];
    const provider = new MockAiProvider({ chunkDelayMs: 0, fixedResponse: 'Zu spät.' });

    await processorWith(provider, published)(contextFor(conversationId));

    expect(published).toEqual([]);
    const active = await prisma.aiConversationMessage.count({
      where: { conversationId, supersededAt: null },
    });
    expect(active).toBe(4);
  }, 30_000);
});
