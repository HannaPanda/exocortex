import { Readable } from 'node:stream';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  type AiGenerateRequest,
  type AiProvider,
  type AiProviderCapabilities,
  type AiStreamEvent,
  type VisionPreprocessor,
} from '@exocortex/ai';
import { loadWorkerEnv } from '@exocortex/config';
import { type QUEUE_NAMES } from '@exocortex/contracts';
import {
  createPrismaClient,
  generateOrderKey,
  PostgresSearchAdapter,
  type PrismaClient,
} from '@exocortex/database';
import { markdownToYjsState } from '@exocortex/editor';
import { createLogger, type Logger } from '@exocortex/logger';
import { type JobContext, QueueRegistry, RedisEventBus } from '@exocortex/queue';
import { type ObjectStorage } from '@exocortex/storage';

import { createAiRunProcessor } from './ai-run';
import { createIndexDocumentProcessor } from './index-document';
import { createMaintenanceProcessor } from './maintenance';
import { createMaterializeDocumentProcessor } from './materialize-document';

/**
 * Worker integration tests against real PostgreSQL and Redis.
 *
 * The processors are invoked directly instead of through BullMQ: that keeps the
 * tests fast while still exercising the real database writes, the real
 * derivation pipeline and the real idempotency checks.
 */
const env = loadWorkerEnv();
const logger: Logger = createLogger({ name: 'worker-test', level: 'silent' });

let prisma: PrismaClient;
let queues: QueueRegistry;
let bus: RedisEventBus;
let search: PostgresSearchAdapter;
let workspaceId: string;
let userId: string;

const MARKDOWN = `# Testseite

Ein Absatz mit dem Wort Zwiebelkuchen.

- [x] Erledigt
- [ ] Offen
`;

type QueueKey = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

/**
 * Builds a job context with a progress recorder. The processors are invoked
 * directly, so the BullMQ `Job` is stubbed down to the fields they read.
 */
function contextFor(payload: unknown): {
  context: JobContext<QueueKey>;
  progress: number[];
} {
  const progress: number[] = [];
  const context = {
    payload,
    job: { id: 'test-job', attemptsMade: 0 },
    logger,
    reportProgress: async (value: number) => {
      progress.push(value);
    },
  } as unknown as JobContext<QueueKey>;
  return { context, progress };
}

async function createDocument(): Promise<string> {
  const imported = markdownToYjsState(MARKDOWN);
  const document = await prisma.document.create({
    data: {
      workspaceId,
      title: 'Testseite',
      orderKey: generateOrderKey(null, null),
      createdById: userId,
      updatedById: userId,
      content: {
        create: {
          yjsState: Buffer.from(imported.yjsState),
          yjsUpdatedAt: new Date(),
        },
      },
    },
  });
  return document.id;
}

beforeAll(async () => {
  prisma = createPrismaClient({ databaseUrl: env.DATABASE_URL });
  queues = new QueueRegistry({ redisUrl: env.REDIS_URL, logger });
  bus = new RedisEventBus({ redisUrl: env.REDIS_URL, logger });
  search = new PostgresSearchAdapter(prisma);

  const suffix = Date.now().toString(36);
  const user = await prisma.user.create({
    data: { email: `worker-${suffix}@exocortex.test`, name: 'Worker Test', emailVerified: true },
  });
  userId = user.id;
  const workspace = await prisma.workspace.create({
    data: {
      name: `Worker ${suffix}`,
      slug: `worker-${suffix}`,
      members: { create: { userId, role: 'OWNER' } },
    },
  });
  workspaceId = workspace.id;
}, 60_000);

afterAll(async () => {
  await prisma.workspace.deleteMany({ where: { id: workspaceId } });
  await prisma.user.deleteMany({ where: { id: userId } });
  await bus.close();
  await queues.close();
  await prisma.$disconnect();
});

describe('document materialization', () => {
  it('derives ProseMirror JSON, plain text and Markdown from the canonical state', async () => {
    const documentId = await createDocument();
    const processor = createMaterializeDocumentProcessor({ prisma, queues, bus });
    const { context, progress } = contextFor({
      correlationId: 'test-1',
      documentId,
      workspaceId,
      yjsUpdatedAt: Date.now(),
      reason: 'manual',
    });

    await processor(context);

    const content = await prisma.documentContent.findUniqueOrThrow({
      where: { documentId },
      select: { proseMirrorJson: true, plainText: true, markdown: true, materializedAt: true },
    });
    expect(content.plainText).toContain('Zwiebelkuchen');
    expect(content.markdown).toContain('# Testseite');
    expect(content.markdown).toContain('- [x] Erledigt');
    expect(content.proseMirrorJson).not.toBeNull();
    expect(content.materializedAt).not.toBeNull();
    expect(progress.at(-1)).toBe(100);
  }, 60_000);

  it('is idempotent: a repeated job does not change the derived data', async () => {
    const documentId = await createDocument();
    const processor = createMaterializeDocumentProcessor({ prisma, queues, bus });
    const payload = {
      correlationId: 'test-2',
      documentId,
      workspaceId,
      yjsUpdatedAt: Date.now(),
      reason: 'collaboration_store' as const,
    };

    await processor(contextFor(payload).context);
    const first = await prisma.documentContent.findUniqueOrThrow({
      where: { documentId },
      select: { plainText: true, markdown: true, materializedAt: true },
    });

    // Second run: the derived data is already at least as fresh as the state.
    await processor(contextFor(payload).context);
    const second = await prisma.documentContent.findUniqueOrThrow({
      where: { documentId },
      select: { plainText: true, markdown: true, materializedAt: true },
    });

    expect(second.plainText).toBe(first.plainText);
    expect(second.markdown).toBe(first.markdown);
    // The skip path must not even rewrite the timestamp.
    expect(second.materializedAt?.getTime()).toBe(first.materializedAt?.getTime());
  }, 60_000);

  it('re-materializes when the canonical state changed again', async () => {
    const documentId = await createDocument();
    const processor = createMaterializeDocumentProcessor({ prisma, queues, bus });
    const payload = {
      correlationId: 'test-3',
      documentId,
      workspaceId,
      yjsUpdatedAt: Date.now(),
      reason: 'collaboration_store' as const,
    };
    await processor(contextFor(payload).context);

    const changed = markdownToYjsState('# Neuer Titel\n\nGanz anderer Inhalt.\n');
    await prisma.documentContent.update({
      where: { documentId },
      data: { yjsState: Buffer.from(changed.yjsState), yjsUpdatedAt: new Date(Date.now() + 1_000) },
    });

    await processor(contextFor(payload).context);
    const content = await prisma.documentContent.findUniqueOrThrow({
      where: { documentId },
      select: { plainText: true },
    });
    expect(content.plainText).toContain('Ganz anderer Inhalt');
    expect(content.plainText).not.toContain('Zwiebelkuchen');
  }, 60_000);

  it('skips a document without content instead of failing', async () => {
    const processor = createMaterializeDocumentProcessor({ prisma, queues, bus });
    await expect(
      processor(
        contextFor({
          correlationId: 'test-4',
          documentId: 'nonexistent-document-id',
          workspaceId,
          yjsUpdatedAt: Date.now(),
          reason: 'manual',
        }).context,
      ),
    ).resolves.toBeUndefined();
  }, 30_000);
});

describe('search indexing', () => {
  it('indexes the materialized plain text and finds it again', async () => {
    const documentId = await createDocument();
    await createMaterializeDocumentProcessor({ prisma, queues, bus })(
      contextFor({
        correlationId: 'test-5',
        documentId,
        workspaceId,
        yjsUpdatedAt: Date.now(),
        reason: 'manual',
      }).context,
    );

    const indexer = createIndexDocumentProcessor({ prisma, search });
    const payload = {
      correlationId: 'test-5',
      documentId,
      workspaceId,
      reason: 'materialized' as const,
    };
    await indexer(contextFor(payload).context);

    const results = await search.search({
      workspaceId,
      query: 'Zwiebelkuchen',
      limit: 10,
      includeArchived: false,
    });
    expect(results.map((result) => result.documentId)).toContain(documentId);
    expect(results[0]?.snippet).toContain('Zwiebelkuchen');

    // Running the indexer twice must not duplicate the projection.
    await indexer(contextFor(payload).context);
    const rows = await prisma.documentSearchIndex.count({ where: { documentId } });
    expect(rows).toBe(1);
  }, 60_000);

  it('removes the projection of a deleted document', async () => {
    const documentId = await createDocument();
    const indexer = createIndexDocumentProcessor({ prisma, search });
    await indexer(
      contextFor({ correlationId: 'test-6', documentId, workspaceId, reason: 'manual' }).context,
    );
    expect(await prisma.documentSearchIndex.count({ where: { documentId } })).toBe(1);

    await prisma.document.delete({ where: { id: documentId } });
    await indexer(
      contextFor({ correlationId: 'test-6', documentId, workspaceId, reason: 'deleted' }).context,
    );
    expect(await prisma.documentSearchIndex.count({ where: { documentId } })).toBe(0);
  }, 60_000);

  it('excludes archived documents from search results by default', async () => {
    const documentId = await createDocument();
    await createMaterializeDocumentProcessor({ prisma, queues, bus })(
      contextFor({
        correlationId: 'test-7',
        documentId,
        workspaceId,
        yjsUpdatedAt: Date.now(),
        reason: 'manual',
      }).context,
    );
    await prisma.document.update({ where: { id: documentId }, data: { archivedAt: new Date() } });

    const indexer = createIndexDocumentProcessor({ prisma, search });
    await indexer(
      contextFor({ correlationId: 'test-7', documentId, workspaceId, reason: 'archived' }).context,
    );

    const active = await search.search({
      workspaceId,
      query: 'Zwiebelkuchen',
      limit: 10,
      includeArchived: false,
    });
    expect(active.map((result) => result.documentId)).not.toContain(documentId);

    const withArchived = await search.search({
      workspaceId,
      query: 'Zwiebelkuchen',
      limit: 10,
      includeArchived: true,
    });
    expect(withArchived.map((result) => result.documentId)).toContain(documentId);
  }, 60_000);
});

describe('maintenance', () => {
  it('dispatches outbox events exactly once', async () => {
    const documentId = await createDocument();
    await prisma.outboxEvent.create({
      data: {
        workspaceId,
        type: 'document.updated',
        payload: { documentId },
        correlationId: 'test-outbox',
      },
    });

    const processor = createMaintenanceProcessor({ prisma, queues });
    await processor(
      contextFor({ correlationId: 'test-outbox', task: 'dispatch-outbox', workspaceId: null })
        .context,
    );

    const remaining = await prisma.outboxEvent.count({
      where: { workspaceId, processedAt: null },
    });
    expect(remaining).toBe(0);

    // A second run has nothing left to do.
    await processor(
      contextFor({ correlationId: 'test-outbox', task: 'dispatch-outbox', workspaceId: null })
        .context,
    );
    const processed = await prisma.outboxEvent.findFirstOrThrow({
      where: { workspaceId, correlationId: 'test-outbox' },
    });
    expect(processed.attempts).toBe(1);
  }, 60_000);

  it('prunes snapshots down to the configured number', async () => {
    const documentId = await createDocument();
    const state = markdownToYjsState('# Snapshot\n').yjsState;
    for (let index = 0; index < 5; index += 1) {
      await prisma.documentSnapshot.create({
        data: {
          documentId,
          yjsState: Buffer.from(state),
          createdById: userId,
          reason: 'MANUAL',
        },
      });
    }

    const processor = createMaintenanceProcessor({ prisma, queues, snapshotsToKeep: 2 });
    await processor(
      contextFor({ correlationId: 'test-prune', task: 'prune-snapshots', workspaceId }).context,
    );

    expect(await prisma.documentSnapshot.count({ where: { documentId } })).toBe(2);
  }, 60_000);
});

/** Captures the request it was given instead of calling a real provider. */
class CapturingAiProvider implements AiProvider {
  public readonly id = 'capturing-test-provider';
  public readonly capabilities: AiProviderCapabilities = {
    textGeneration: true,
    vision: false,
    toolCalling: false,
    structuredOutput: false,
    streaming: true,
    contextWindowTokens: 32_000,
    usageReporting: true,
    costReporting: true,
    models: [],
  };

  public lastRequest: AiGenerateRequest | null = null;

  async generate(request: AiGenerateRequest) {
    this.lastRequest = request;
    return {
      text: 'ok',
      finishReason: 'stop' as const,
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        cachedInputTokens: 0,
        provider: this.id,
        model: request.model ?? 'test-model',
        providerCostMicroUsd: null,
        durationMs: 1,
      },
    };
  }

  async *stream(request: AiGenerateRequest): AsyncIterable<AiStreamEvent> {
    this.lastRequest = request;
    yield { type: 'start', model: request.model ?? 'test-model', provider: this.id };
    yield { type: 'delta', text: 'ok', sequence: 1 };
    yield { type: 'done', text: 'ok', finishReason: 'stop' };
  }
}

function fakeStorage(bytes: Buffer): ObjectStorage {
  return {
    putObject: () => {
      throw new Error('not used in this test');
    },
    getObject: async () => Readable.from([bytes]),
    deleteObject: async () => {
      /* not used in this test */
    },
    createDownloadUrl: async () => 'unused',
    healthCheck: async () => true,
  };
}

function fakeVisionPreprocessor(description: string): VisionPreprocessor {
  return { describeImage: async () => description } as unknown as VisionPreprocessor;
}

describe('ai runs', () => {
  async function createRun(documentId: string): Promise<string> {
    const run = await prisma.aiRun.create({
      data: {
        workspaceId,
        documentId,
        createdById: userId,
        status: 'PENDING',
        provider: 'capturing-test-provider',
        model: 'test-model',
        messages: [{ role: 'user', content: 'Was zeigt das Bild?' }],
      },
    });
    return run.id;
  }

  it('describes a document image and prepends it as context for the main model', async () => {
    const documentId = await createDocument();
    const attachment = await prisma.attachment.create({
      data: {
        workspaceId,
        documentId,
        filename: 'katze.png',
        mimeType: 'image/png',
        byteSize: 3,
        storageKey: `test/${Date.now().toString(36)}.png`,
        createdById: userId,
      },
    });
    await prisma.documentContent.update({
      where: { documentId },
      data: {
        proseMirrorJson: {
          type: 'doc',
          content: [
            { type: 'image', attrs: { src: `/api/attachments/${attachment.id}/download` } },
          ],
        },
      },
    });
    const runId = await createRun(documentId);
    const provider = new CapturingAiProvider();

    const processor = createAiRunProcessor({
      prisma,
      provider,
      bus,
      visionPreprocessor: fakeVisionPreprocessor('Eine Katze mit Hut.'),
      storage: fakeStorage(Buffer.from('fake-image-bytes')),
    });
    await processor(
      contextFor({ correlationId: 'test-ai-1', runId, workspaceId, userId }).context,
    );

    const messages = provider.lastRequest?.messages ?? [];
    expect(messages[0]?.role).toBe('system');
    expect(messages[0]?.content).toContain('katze.png');
    expect(messages[0]?.content).toContain('Eine Katze mit Hut.');
    expect(messages[1]?.content).toBe('Was zeigt das Bild?');

    const run = await prisma.aiRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.status).toBe('COMPLETED');
    expect(run.resultText).toBe('ok');
  }, 60_000);

  it('does not inject a system message when the page has no images', async () => {
    const documentId = await createDocument();
    const runId = await createRun(documentId);
    const provider = new CapturingAiProvider();

    const processor = createAiRunProcessor({
      prisma,
      provider,
      bus,
      visionPreprocessor: fakeVisionPreprocessor('unused'),
      storage: fakeStorage(Buffer.from('unused')),
    });
    await processor(
      contextFor({ correlationId: 'test-ai-2', runId, workspaceId, userId }).context,
    );

    expect(provider.lastRequest?.messages).toEqual([
      { role: 'user', content: 'Was zeigt das Bild?' },
    ]);
  }, 60_000);

  it('completes the run even when a referenced attachment cannot be resolved', async () => {
    const documentId = await createDocument();
    await prisma.documentContent.update({
      where: { documentId },
      data: {
        proseMirrorJson: {
          type: 'doc',
          content: [{ type: 'image', attrs: { src: '/api/attachments/does-not-exist/download' } }],
        },
      },
    });
    const runId = await createRun(documentId);
    const provider = new CapturingAiProvider();

    const processor = createAiRunProcessor({
      prisma,
      provider,
      bus,
      visionPreprocessor: fakeVisionPreprocessor('unused'),
      storage: fakeStorage(Buffer.from('unused')),
    });
    await processor(
      contextFor({ correlationId: 'test-ai-3', runId, workspaceId, userId }).context,
    );

    expect(provider.lastRequest?.messages).toEqual([
      { role: 'user', content: 'Was zeigt das Bild?' },
    ]);
    const run = await prisma.aiRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.status).toBe('COMPLETED');
  }, 60_000);
});
