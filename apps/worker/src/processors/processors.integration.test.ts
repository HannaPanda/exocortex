import { Readable } from 'node:stream';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  type AiGenerateRequest,
  type AiGenerateResult,
  type AiProvider,
  type AiProviderCapabilities,
  AiProviderError,
  type AiStreamEvent,
  type AiToolCall,
  MockAiProvider,
  MockImageGenerator,
  type PdfDocumentInfoReader,
  type VisionPreprocessor,
} from '@exocortex/ai';
import { loadWorkerEnv } from '@exocortex/config';
import {
  AI_RUN_HEARTBEAT_STALE_MS,
  type PdfMetadata,
  type QUEUE_NAMES,
  type Settings,
  settingsSchema,
} from '@exocortex/contracts';
import {
  createPrismaClient,
  generateOrderKey,
  PostgresSearchAdapter,
  type PrismaClient,
} from '@exocortex/database';
import { bindPageLinkIdentities, markdownToYjsState } from '@exocortex/editor';
import { createLogger, type Logger } from '@exocortex/logger';
import { type ExocortexApiClient } from '@exocortex/mcp-tools';
import { type JobContext, QueueRegistry, RedisEventBus, testQueuePrefix } from '@exocortex/queue';
import { type ObjectStorage } from '@exocortex/storage';

import { compactIfNeeded } from '../compaction';
import { type ToolRunner } from '../tool-runner';

import { createAiRunProcessor, type ResolvedModelRow } from './ai-run';
import { createAttachmentTextProcessor } from './attachment-text';
import { createDocumentCoverProcessor } from './document-cover';
import { createIndexDocumentProcessor } from './index-document';
import { createMaintenanceProcessor } from './maintenance';
import { createMaterializeDocumentProcessor } from './materialize-document';

/** A fully-defaulted `Settings` object with just the given keys overridden. */
function stubSettings(overrides: Partial<Settings> = {}): () => Promise<Settings> {
  const settings = settingsSchema.parse(overrides);
  return async () => settings;
}

/**
 * Same as `stubSettings`, but bypasses zod validation for the override.
 *
 * A real deployment cannot set `ai.maxRunMs` or `ai.timeoutMs` below their
 * documented floors (60s / 5s), so this is not a case a production settings
 * row can reach. It is what lets a test exercise the run-budget mechanism
 * itself in milliseconds instead of minutes.
 */
function stubSettingsUnchecked(overrides: Partial<Settings>): () => Promise<Settings> {
  const settings = { ...settingsSchema.parse({}), ...overrides } as Settings;
  return async () => settings;
}

/** Records what a processor published instead of reaching Redis. */
function recordingEventBus(
  published: { type: string; payload: Record<string, unknown> }[],
): RedisEventBus {
  return {
    publish: async (event: { type: string; payload: Record<string, unknown> }) => {
      published.push(event);
    },
  } as unknown as RedisEventBus;
}

/** A model row that supports tools, for the tool-loop tests below. */
function toolCapableModelRow(slug: string): ResolvedModelRow {
  return {
    id: 'test-model-row',
    slug,
    provider: 'mock',
    contextWindowTokens: 32_000,
    maxOutputTokens: null,
    supportsVision: false,
    supportsTools: true,
    reasoningLevels: ['NONE'],
    visionCompanionSlug: null,
  };
}

/** Returns one canned response per call, in order; extra calls get an error result. */
function stubToolRunner(responses: readonly { text: string; isError: boolean }[]): ToolRunner {
  let callIndex = 0;
  return {
    definitions: [{ name: 'exo_test_tool', description: 'Ein Testwerkzeug', parameters: {} }],
    async run() {
      const response = responses[callIndex] ?? { text: 'Keine weitere Antwort konfiguriert', isError: true };
      callIndex += 1;
      return response;
    },
  };
}

/**
 * Worker integration tests against real PostgreSQL and Redis.
 *
 * The processors are invoked directly instead of through BullMQ: that keeps the
 * tests fast while still exercising the real database writes, the real
 * derivation pipeline and the real idempotency checks.
 *
 * A processor still enqueues follow-up jobs, and that Redis is shared with the
 * deployment on this machine, so the registry runs under this suite's own
 * prefix. Without it those jobs were consumed by the live `exocortex-worker`,
 * which then failed on them: the run's user is deleted again in `afterAll`, so
 * the service token minted for a tool call resolved to nobody and the API
 * rejected it with `api_token_invalid`.
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
  queues = new QueueRegistry({
    redisUrl: env.REDIS_URL,
    logger,
    prefix: testQueuePrefix('worker-processors'),
  });
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
  await queues.obliterateAll();
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

/** A minimal `AiRun` row for the reaper tests: no document, no conversation. */
async function createAiRunRow(
  status: 'PENDING' | 'RUNNING',
  overrides: { startedAt?: Date | null; heartbeatAt?: Date | null; createdAt?: Date } = {},
): Promise<string> {
  const run = await prisma.aiRun.create({
    data: {
      workspaceId,
      createdById: userId,
      status,
      provider: 'mock',
      model: 'test-model',
      messages: [{ role: 'user', content: 'test' }],
      startedAt: overrides.startedAt ?? null,
      heartbeatAt: overrides.heartbeatAt ?? null,
      ...(overrides.createdAt === undefined ? {} : { createdAt: overrides.createdAt }),
    },
  });
  return run.id;
}

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

    const processor = createMaintenanceProcessor({
      prisma,
      queues,
      storage: recordingStorage(),
      bus,
      settings: stubSettings(),
    });
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

    const processor = createMaintenanceProcessor({
      prisma,
      queues,
      storage: recordingStorage(),
      bus,
      settings: stubSettings(),
      snapshotsToKeep: 2,
    });
    await processor(
      contextFor({ correlationId: 'test-prune', task: 'prune-snapshots', workspaceId }).context,
    );

    expect(await prisma.documentSnapshot.count({ where: { documentId } })).toBe(2);
  }, 60_000);

  it('collects a replaced cover and leaves the current one alone', async () => {
    const documentId = await createDocument();
    // `storageKey` is globally unique, so a fixed key survives as a landmine:
    // once a run leaves its rows behind, every later run fails on the insert.
    const keyPrefix = `test/${Date.now().toString(36)}`;
    const cover = async (name: string) =>
      prisma.attachment.create({
        data: {
          workspaceId,
          documentId,
          filename: name,
          mimeType: 'image/png',
          byteSize: 3,
          storageKey: `${keyPrefix}/${name}`,
          createdById: userId,
          isCover: true,
          // Every image upload also stores a downscaled copy, and it has to go
          // with the original rather than outlive the file it was made from.
          previewKey: `${keyPrefix}/${name}.preview.webp`,
          previewMimeType: 'image/webp',
          previewByteSize: 2,
          // Older than the grace period, which exists for the seconds between
          // an upload and the page pointing at it.
          createdAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
        },
      });

    const replaced = await cover('alt.png');
    const current = await cover('neu.png');
    // An image a user placed in the body carries no cover mark and is never a
    // candidate, however long it sits there unreferenced.
    const inBody = await prisma.attachment.create({
      data: {
        workspaceId,
        documentId,
        filename: 'im-text.png',
        mimeType: 'image/png',
        byteSize: 3,
        storageKey: `${keyPrefix}/im-text.png`,
        createdById: userId,
        createdAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
      },
    });
    await prisma.document.update({
      where: { id: documentId },
      data: { coverAttachmentId: current.id },
    });

    const deleted: string[] = [];
    const processor = createMaintenanceProcessor({
      prisma,
      queues,
      storage: recordingStorage(deleted),
      bus,
      settings: stubSettings(),
    });
    await processor(
      contextFor({ correlationId: 'test-covers', task: 'collect-orphaned-covers', workspaceId })
        .context,
    );

    expect(deleted).toEqual([`${keyPrefix}/alt.png`, `${keyPrefix}/alt.png.preview.webp`]);
    expect((await prisma.attachment.findUniqueOrThrow({ where: { id: replaced.id } })).deletedAt)
      .not.toBeNull();
    expect((await prisma.attachment.findUniqueOrThrow({ where: { id: current.id } })).deletedAt)
      .toBeNull();
    expect((await prisma.attachment.findUniqueOrThrow({ where: { id: inBody.id } })).deletedAt)
      .toBeNull();
  }, 60_000);

  it('reaps a RUNNING run whose heartbeat has gone stale, as ai_run_abandoned', async () => {
    const staleHeartbeat = new Date(Date.now() - 5 * 60_000);
    const runId = await createAiRunRow('RUNNING', { startedAt: staleHeartbeat, heartbeatAt: staleHeartbeat });

    const published: { type: string; payload: Record<string, unknown> }[] = [];
    const processor = createMaintenanceProcessor({
      prisma,
      queues,
      storage: recordingStorage(),
      bus: recordingEventBus(published),
      settings: stubSettings(),
    });
    await processor(
      contextFor({ correlationId: 'test-reap-1', task: 'reap-stale-ai-runs', workspaceId: null }).context,
    );

    const run = await prisma.aiRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.status).toBe('FAILED');
    expect(run.errorCode).toBe('ai_run_abandoned');
    expect(
      published.some(
        (event) =>
          event.type === 'ai.run.failed' &&
          event.payload.runId === runId &&
          event.payload.errorCode === 'ai_run_abandoned',
      ),
    ).toBe(true);
  }, 30_000);

  it('reaps a RUNNING run that never recorded a start, as ai_run_abandoned', async () => {
    const runId = await createAiRunRow('RUNNING', { createdAt: new Date(Date.now() - 5 * 60_000) });

    const published: { type: string; payload: Record<string, unknown> }[] = [];
    const processor = createMaintenanceProcessor({
      prisma,
      queues,
      storage: recordingStorage(),
      bus: recordingEventBus(published),
      settings: stubSettings(),
    });
    await processor(
      contextFor({ correlationId: 'test-reap-5', task: 'reap-stale-ai-runs', workspaceId: null }).context,
    );

    const run = await prisma.aiRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.status).toBe('FAILED');
    expect(run.errorCode).toBe('ai_run_abandoned');
    expect(
      published.some(
        (event) =>
          event.type === 'ai.run.failed' &&
          event.payload.runId === runId &&
          event.payload.errorCode === 'ai_run_abandoned',
      ),
    ).toBe(true);
  }, 30_000);

  it('reaps a PENDING run that was never picked up, as ai_run_lost', async () => {
    const runId = await createAiRunRow('PENDING', { createdAt: new Date(Date.now() - 6 * 60_000) });

    const published: { type: string; payload: Record<string, unknown> }[] = [];
    const processor = createMaintenanceProcessor({
      prisma,
      queues,
      storage: recordingStorage(),
      bus: recordingEventBus(published),
      settings: stubSettings(),
    });
    await processor(
      contextFor({ correlationId: 'test-reap-2', task: 'reap-stale-ai-runs', workspaceId: null }).context,
    );

    const run = await prisma.aiRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.status).toBe('FAILED');
    expect(run.errorCode).toBe('ai_run_lost');
    expect(
      published.some(
        (event) =>
          event.type === 'ai.run.failed' &&
          event.payload.runId === runId &&
          event.payload.errorCode === 'ai_run_lost',
      ),
    ).toBe(true);
  }, 30_000);

  it('leaves a healthy run alone', async () => {
    const runningId = await createAiRunRow('RUNNING', { startedAt: new Date(), heartbeatAt: new Date() });
    const pendingId = await createAiRunRow('PENDING');

    const published: { type: string; payload: Record<string, unknown> }[] = [];
    const processor = createMaintenanceProcessor({
      prisma,
      queues,
      storage: recordingStorage(),
      bus: recordingEventBus(published),
      settings: stubSettings(),
    });
    await processor(
      contextFor({ correlationId: 'test-reap-3', task: 'reap-stale-ai-runs', workspaceId: null }).context,
    );

    const runningRow = await prisma.aiRun.findUniqueOrThrow({ where: { id: runningId } });
    const pendingRow = await prisma.aiRun.findUniqueOrThrow({ where: { id: pendingId } });
    expect(runningRow.status).toBe('RUNNING');
    expect(pendingRow.status).toBe('PENDING');
    expect(
      published.some((event) => event.payload.runId === runningId || event.payload.runId === pendingId),
    ).toBe(false);
  }, 30_000);

  it('sets TIMED_OUT instead of FAILED once the total run budget is exceeded, even with a fresh heartbeat', async () => {
    // Older than the default budget (900_000ms) plus the reaper's grace
    // period (30_000ms), but the heartbeat is fresh: a run can legitimately
    // still be ticking and still be over its own total time budget.
    const startedAt = new Date(Date.now() - 950_000);
    const runId = await createAiRunRow('RUNNING', { startedAt, heartbeatAt: new Date() });

    const published: { type: string; payload: Record<string, unknown> }[] = [];
    const processor = createMaintenanceProcessor({
      prisma,
      queues,
      storage: recordingStorage(),
      bus: recordingEventBus(published),
      settings: stubSettings(),
    });
    await processor(
      contextFor({ correlationId: 'test-reap-4', task: 'reap-stale-ai-runs', workspaceId: null }).context,
    );

    const run = await prisma.aiRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.status).toBe('TIMED_OUT');
    expect(run.errorCode).toBe('ai_timeout');
  }, 30_000);
});

describe('cover generation', () => {
  interface Published {
    type: string;
    payload: { documentId: string; status: string; error: string | null };
  }

  /** Records what the processor announced instead of reaching Redis. */
  function recordingBus(published: Published[]): RedisEventBus {
    return {
      publish: async (event: Published) => {
        published.push(event);
      },
    } as unknown as RedisEventBus;
  }

  function uploadingClient(uploads: { path: string; bytes: number }[]): ExocortexApiClient {
    return {
      request: () => {
        throw new Error('not used in this test');
      },
      upload: async (input) => {
        uploads.push({ path: input.path, bytes: input.bytes.byteLength });
        return input.responseSchema.parse({
          id: 'doc123456',
          workspaceId: 'ws1234567',
          parentId: null,
          type: 'PAGE',
          title: 'Seite',
          icon: null,
          iconColor: null,
          layout: 'narrow',
          coverAttachmentId: 'att1234567',
          coverPosition: 50,
          orderKey: 'a0',
          createdById: 'user1234',
          updatedById: 'user1234',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          archivedAt: null,
        });
      },
    };
  }

  const payload = {
    correlationId: 'test-cover',
    documentId: 'doc123456',
    workspaceId: 'ws1234567',
    userId: 'user1234',
    prompt: 'Berge im Morgennebel',
  };

  it('draws a picture and installs it through the cover route', async () => {
    const published: Published[] = [];
    const uploads: { path: string; bytes: number }[] = [];

    await createDocumentCoverProcessor({
      imageGeneratorFor: () => new MockImageGenerator(),
      apiClientFor: () => uploadingClient(uploads),
      bus: recordingBus(published),
      settings: stubSettings({ 'ai.imageGenerationEnabled': true, 'ai.imageModelSlug': 'a/b' }),
    })(contextFor(payload).context);

    // The upload goes through the REST route, not the database (ADR-014).
    expect(uploads).toHaveLength(1);
    expect(uploads[0]?.path).toBe('/api/documents/doc123456/cover');
    expect(uploads[0]?.bytes).toBeGreaterThan(0);
    expect(published).toEqual([
      expect.objectContaining({
        type: 'document.cover.generated',
        payload: { documentId: 'doc123456', status: 'ready', error: null },
      }),
    ]);
  });

  it('reports an unconfigured deployment instead of uploading anything', async () => {
    const published: Published[] = [];
    const uploads: { path: string; bytes: number }[] = [];

    await createDocumentCoverProcessor({
      imageGeneratorFor: () => null,
      apiClientFor: () => uploadingClient(uploads),
      bus: recordingBus(published),
      settings: stubSettings({ 'ai.imageGenerationEnabled': true, 'ai.imageModelSlug': null }),
    })(contextFor(payload).context);

    expect(uploads).toEqual([]);
    expect(published[0]?.payload.status).toBe('failed');
    expect(published[0]?.payload.error).toContain('nicht eingerichtet');
  });

  it('names the model when it answered without a picture', async () => {
    const published: Published[] = [];
    const textOnly = {
      model: 'openai/text-only',
      generate: () =>
        Promise.reject(new AiProviderError('ai_image_empty', 'no image in the answer')),
    };

    await createDocumentCoverProcessor({
      imageGeneratorFor: () => textOnly,
      apiClientFor: () => uploadingClient([]),
      bus: recordingBus(published),
      settings: stubSettings({ 'ai.imageGenerationEnabled': true, 'ai.imageModelSlug': 'a/b' }),
    })(contextFor(payload).context);

    // "Try again" would be the wrong advice: the model has to change.
    expect(published[0]?.payload.error).toContain('openai/text-only');
    expect(published[0]?.payload.error).toContain('bildfähiges Modell');
  });

  it('never lets a failure escape, so a paid call is not retried', async () => {
    const published: Published[] = [];
    const failing = {
      model: 'broken',
      generate: () => Promise.reject(new Error('provider is down')),
    };

    // No rejection: the job ends successfully and the browser is told why.
    await createDocumentCoverProcessor({
      imageGeneratorFor: () => failing,
      apiClientFor: () => uploadingClient([]),
      bus: recordingBus(published),
      settings: stubSettings({ 'ai.imageGenerationEnabled': true, 'ai.imageModelSlug': 'a/b' }),
    })(contextFor(payload).context);

    expect(published[0]?.payload.status).toBe('failed');
  });
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
      toolCalls: [],
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

interface ScriptedTurn {
  text: string;
  finishReason: AiGenerateResult['finishReason'];
  toolCalls?: readonly AiToolCall[];
}

/** Replays a fixed list of turns; the last entry answers every further turn. */
class ScriptedAiProvider implements AiProvider {
  public readonly id = 'scripted-test-provider';
  public readonly capabilities: AiProviderCapabilities = {
    textGeneration: true,
    vision: false,
    toolCalling: true,
    structuredOutput: false,
    streaming: true,
    contextWindowTokens: 32_000,
    usageReporting: true,
    costReporting: true,
    models: [],
  };

  public readonly requests: AiGenerateRequest[] = [];

  private readonly turns: readonly ScriptedTurn[];

  constructor(turns: readonly ScriptedTurn[]) {
    this.turns = turns;
  }

  async generate(): Promise<AiGenerateResult> {
    throw new Error('The scripted provider is only used for streaming');
  }

  async *stream(request: AiGenerateRequest): AsyncIterable<AiStreamEvent> {
    const turn = this.turns[Math.min(this.requests.length, this.turns.length - 1)]!;
    this.requests.push(request);
    yield { type: 'start', model: request.model ?? 'test-model', provider: this.id };
    if (turn.text.length > 0) yield { type: 'delta', text: turn.text, sequence: 1 };
    if (turn.toolCalls !== undefined) yield { type: 'tool_calls', toolCalls: turn.toolCalls };
    yield { type: 'done', text: turn.text, finishReason: turn.finishReason };
  }
}

/**
 * Never answers on its own; throws once the run aborts it, the way a real
 * `fetch(..., { signal })` does. `MockAiProvider` deliberately turns an abort
 * into a controlled `error` event instead of throwing, which is too forgiving
 * to exercise the run/turn-timeout and cancellation paths in `ai-run.ts` --
 * those rely on the exception reaching the outer `catch`.
 */
class HangingAiProvider implements AiProvider {
  public readonly id = 'hanging-test-provider';
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

  async generate(): Promise<AiGenerateResult> {
    throw new Error('The hanging provider is only used for streaming');
  }

  async *stream(request: AiGenerateRequest): AsyncIterable<AiStreamEvent> {
    yield { type: 'start', model: request.model ?? 'test-model', provider: this.id };
    const signal = request.signal;
    await new Promise<void>((resolve, reject) => {
      if (signal?.aborted === true) {
        reject(new DOMException('The operation was aborted', 'AbortError'));
        return;
      }
      const timer = setTimeout(resolve, 10 * 60_000);
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(new DOMException('The operation was aborted', 'AbortError'));
        },
        { once: true },
      );
    });
    yield { type: 'delta', text: 'unreachable', sequence: 1 };
  }
}

/** Storage that only remembers which objects were deleted. */
function recordingStorage(deleted: string[] = []): ObjectStorage {
  return {
    putObject: () => {
      throw new Error('not used in this test');
    },
    getObject: () => {
      throw new Error('not used in this test');
    },
    deleteObject: async ({ key }) => {
      deleted.push(key);
    },
    createDownloadUrl: async () => 'unused',
    healthCheck: async () => true,
  };
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
      storage: fakeStorage(Buffer.from('fake-image-bytes')),
      settings: stubSettings(),
      toolRunnerFactory: null,
      visionPreprocessorFor: () => fakeVisionPreprocessor('Eine Katze mit Hut.'),
      modelRegistry: async () => null,
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
      storage: fakeStorage(Buffer.from('unused')),
      settings: stubSettings(),
      toolRunnerFactory: null,
      visionPreprocessorFor: () => fakeVisionPreprocessor('unused'),
      modelRegistry: async () => null,
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
      storage: fakeStorage(Buffer.from('unused')),
      settings: stubSettings(),
      toolRunnerFactory: null,
      visionPreprocessorFor: () => fakeVisionPreprocessor('unused'),
      modelRegistry: async () => null,
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

  it('sends the configured output limit with the request', async () => {
    const documentId = await createDocument();
    const runId = await createRun(documentId);
    const provider = new CapturingAiProvider();

    const processor = createAiRunProcessor({
      prisma,
      provider,
      bus,
      storage: fakeStorage(Buffer.from('unused')),
      settings: stubSettings({ 'ai.maxOutputTokens': 12_288 }),
      toolRunnerFactory: null,
      visionPreprocessorFor: () => null,
      modelRegistry: async () => null,
    });
    await processor(contextFor({ correlationId: 'test-ai-limit-1', runId, workspaceId, userId }).context);

    expect(provider.lastRequest?.maxOutputTokens).toBe(12_288);
  }, 60_000);

  it("caps the output limit at the model's own maximum", async () => {
    const documentId = await createDocument();
    const runId = await createRun(documentId);
    const provider = new CapturingAiProvider();

    const processor = createAiRunProcessor({
      prisma,
      provider,
      bus,
      storage: fakeStorage(Buffer.from('unused')),
      settings: stubSettings({ 'ai.maxOutputTokens': 100_000 }),
      toolRunnerFactory: null,
      visionPreprocessorFor: () => null,
      modelRegistry: async () => ({ ...toolCapableModelRow('test-model'), maxOutputTokens: 8_000 }),
    });
    await processor(contextFor({ correlationId: 'test-ai-limit-2', runId, workspaceId, userId }).context);

    expect(provider.lastRequest?.maxOutputTokens).toBe(8_000);
  }, 60_000);

  it('picks a truncated answer up instead of delivering the fragment as the result', async () => {
    const documentId = await createDocument();
    const runId = await createRun(documentId);
    const provider = new ScriptedAiProvider([
      { text: 'Teil eins ', finishReason: 'length' },
      { text: 'und Teil zwei.', finishReason: 'stop' },
    ]);

    const processor = createAiRunProcessor({
      prisma,
      provider,
      bus,
      storage: fakeStorage(Buffer.from('unused')),
      settings: stubSettings(),
      toolRunnerFactory: null,
      visionPreprocessorFor: () => null,
      modelRegistry: async () => null,
    });
    await processor(contextFor({ correlationId: 'test-ai-truncation-1', runId, workspaceId, userId }).context);

    const run = await prisma.aiRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.status).toBe('COMPLETED');
    expect(run.resultText).toBe('Teil eins und Teil zwei.');

    expect(provider.requests).toHaveLength(2);
    const secondTurnMessages = provider.requests[1]?.messages ?? [];
    expect(secondTurnMessages.at(-2)).toEqual({ role: 'assistant', content: 'Teil eins ' });
    expect(secondTurnMessages.at(-1)?.content).toContain('abgeschnitten');
  }, 60_000);

  it('fails with ai_response_truncated when a tool call is cut off mid-arguments', async () => {
    const documentId = await createDocument();
    const runId = await createRun(documentId);
    const provider = new ScriptedAiProvider([
      {
        text: 'Ich schreibe jetzt den strukturierten Inhalt auf die Seite:',
        finishReason: 'length',
        toolCalls: [
          { id: 'call-1', name: 'exo_page_write', argumentsJson: '{"documentId":"abc","markdown":"# Gami' },
        ],
      },
    ]);

    const processor = createAiRunProcessor({
      prisma,
      provider,
      bus,
      storage: fakeStorage(Buffer.from('unused')),
      settings: stubSettings(),
      toolRunnerFactory: null,
      visionPreprocessorFor: () => null,
      modelRegistry: async () => null,
    });
    await processor(contextFor({ correlationId: 'test-ai-truncation-2', runId, workspaceId, userId }).context);

    const run = await prisma.aiRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.status).toBe('FAILED');
    expect(run.errorCode).toBe('ai_response_truncated');
    // One first attempt plus the bounded number of retries, and not one more.
    expect(provider.requests).toHaveLength(4);
  }, 60_000);

  it('fails instead of dropping a tool call the provider never assembled', async () => {
    const documentId = await createDocument();
    const runId = await createRun(documentId);
    const provider = new ScriptedAiProvider([
      { text: '', finishReason: 'tool_calls', toolCalls: [{ id: '', name: '', argumentsJson: '{}' }] },
    ]);

    const processor = createAiRunProcessor({
      prisma,
      provider,
      bus,
      storage: fakeStorage(Buffer.from('unused')),
      settings: stubSettings(),
      toolRunnerFactory: null,
      visionPreprocessorFor: () => null,
      modelRegistry: async () => null,
    });
    await processor(contextFor({ correlationId: 'test-ai-tool-call-1', runId, workspaceId, userId }).context);

    const run = await prisma.aiRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.status).toBe('FAILED');
    expect(run.errorCode).toBe('ai_tool_call_invalid');
  }, 60_000);

  it('marks the run TIMED_OUT with ai_timeout once its own time budget elapses', async () => {
    const documentId = await createDocument();
    const runId = await createRun(documentId);
    const published: { type: string; payload: Record<string, unknown> }[] = [];

    const processor = createAiRunProcessor({
      prisma,
      provider: new HangingAiProvider(),
      bus: recordingEventBus(published),
      storage: fakeStorage(Buffer.from('unused')),
      settings: stubSettingsUnchecked({ 'ai.timeoutMs': 150, 'ai.maxRunMs': 150 }),
      toolRunnerFactory: null,
      visionPreprocessorFor: () => null,
      modelRegistry: async () => null,
    });
    await processor(contextFor({ correlationId: 'test-ai-timeout-1', runId, workspaceId, userId }).context);

    const run = await prisma.aiRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.status).toBe('TIMED_OUT');
    expect(run.errorCode).toBe('ai_timeout');
    expect(
      published.some(
        (event) => event.type === 'ai.run.failed' && event.payload.status === 'timed_out',
      ),
    ).toBe(true);
  }, 30_000);

  it('stops streaming once cancelled and never overwrites the cancellation with COMPLETED', async () => {
    const documentId = await createDocument();
    const runId = await createRun(documentId);
    const published: { type: string; payload: Record<string, unknown> }[] = [];

    const processor = createAiRunProcessor({
      prisma,
      provider: new HangingAiProvider(),
      bus: recordingEventBus(published),
      storage: fakeStorage(Buffer.from('unused')),
      settings: stubSettings(),
      toolRunnerFactory: null,
      visionPreprocessorFor: () => null,
      modelRegistry: async () => null,
    });

    const runPromise = processor(
      contextFor({ correlationId: 'test-ai-cancel-1', runId, workspaceId, userId }).context,
    );

    // Give the processor a moment to reach RUNNING, then cancel exactly the
    // way POST /cancel does: touch only the database row. The worker notices
    // through its own next heartbeat write.
    await new Promise((resolve) => setTimeout(resolve, 300));
    await prisma.aiRun.update({
      where: { id: runId },
      data: { status: 'CANCELLED', cancelledAt: new Date(), finishedAt: new Date() },
    });

    await runPromise;

    const run = await prisma.aiRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.status).toBe('CANCELLED');
    expect(published.some((event) => event.type === 'ai.run.completed')).toBe(false);
  }, 15_000);

  it('skips a RUNNING run that still has a fresh heartbeat, instead of taking it over', async () => {
    const documentId = await createDocument();
    const runId = await createRun(documentId);
    await prisma.aiRun.update({
      where: { id: runId },
      data: { status: 'RUNNING', startedAt: new Date(), heartbeatAt: new Date() },
    });
    const published: { type: string; payload: Record<string, unknown> }[] = [];

    const processor = createAiRunProcessor({
      prisma,
      provider: new CapturingAiProvider(),
      bus: recordingEventBus(published),
      storage: fakeStorage(Buffer.from('unused')),
      settings: stubSettings(),
      toolRunnerFactory: null,
      visionPreprocessorFor: () => null,
      modelRegistry: async () => null,
    });
    await processor(contextFor({ correlationId: 'test-ai-fresh-1', runId, workspaceId, userId }).context);

    const run = await prisma.aiRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.status).toBe('RUNNING');
    expect(published).toEqual([]);
  }, 30_000);

  it('closes a RUNNING run with a stale heartbeat as abandoned, instead of resuming it', async () => {
    const documentId = await createDocument();
    const runId = await createRun(documentId);
    const staleHeartbeat = new Date(Date.now() - AI_RUN_HEARTBEAT_STALE_MS - 5_000);
    await prisma.aiRun.update({
      where: { id: runId },
      data: { status: 'RUNNING', startedAt: staleHeartbeat, heartbeatAt: staleHeartbeat },
    });
    const published: { type: string; payload: Record<string, unknown> }[] = [];
    const provider = new CapturingAiProvider();

    const processor = createAiRunProcessor({
      prisma,
      provider,
      bus: recordingEventBus(published),
      storage: fakeStorage(Buffer.from('unused')),
      settings: stubSettings(),
      toolRunnerFactory: null,
      visionPreprocessorFor: () => null,
      modelRegistry: async () => null,
    });
    await processor(contextFor({ correlationId: 'test-ai-stale-1', runId, workspaceId, userId }).context);

    const run = await prisma.aiRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.status).toBe('FAILED');
    expect(run.errorCode).toBe('ai_run_abandoned');
    expect(
      published.some(
        (event) =>
          event.type === 'ai.run.failed' &&
          event.payload.runId === runId &&
          event.payload.errorCode === 'ai_run_abandoned',
      ),
    ).toBe(true);
    // The provider must never have been asked to answer: taking this run
    // over would be a second answer, not a resume.
    expect(provider.lastRequest).toBeNull();
  }, 30_000);
});

async function createConversation(): Promise<string> {
  const conversation = await prisma.aiConversation.create({
    data: { workspaceId, createdById: userId, title: 'Testkonversation' },
  });
  return conversation.id;
}

async function createConversationRun(input: { conversationId: string; content: string; model?: string }): Promise<string> {
  await prisma.aiConversationMessage.create({
    data: {
      conversationId: input.conversationId,
      role: 'USER',
      content: input.content,
      estimatedTokens: 10,
    },
  });
  const run = await prisma.aiRun.create({
    data: {
      workspaceId,
      createdById: userId,
      status: 'PENDING',
      provider: 'mock',
      model: input.model ?? 'test-tool-model',
      messages: [{ role: 'user', content: input.content }],
      conversationId: input.conversationId,
    },
  });
  return run.id;
}

describe('conversation-backed tool loop', () => {
  it('executes a tool call through a stub ToolRunner and completes with the follow-up text', async () => {
    const conversationId = await createConversation();
    const runId = await createConversationRun({
      conversationId,
      content: 'Bitte [[call:exo_test_tool]] ausführen',
    });

    const processor = createAiRunProcessor({
      prisma,
      provider: new MockAiProvider({ chunkDelayMs: 0 }),
      bus,
      storage: fakeStorage(Buffer.from('unused')),
      settings: stubSettings({ 'ai.maxToolIterations': 4 }),
      toolRunnerFactory: () => stubToolRunner([{ text: 'Werkzeugergebnis', isError: false }]),
      visionPreprocessorFor: () => null,
      modelRegistry: async () => toolCapableModelRow('test-tool-model'),
    });

    await processor(contextFor({ correlationId: 'test-tool-loop-1', runId, workspaceId, userId }).context);

    const run = await prisma.aiRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.status).toBe('COMPLETED');
    expect(run.toolIterations).toBe(1);
    expect(run.resultText).not.toBeNull();

    const messages = await prisma.aiConversationMessage.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'asc' },
    });
    const assistantWithToolCalls = messages.find((message) => message.role === 'ASSISTANT' && message.toolCalls !== null);
    expect(assistantWithToolCalls).toBeDefined();

    const toolMessage = messages.find((message) => message.role === 'TOOL');
    expect(toolMessage?.content).toBe('Werkzeugergebnis');
    expect(toolMessage?.toolCallId).toBe('mock-tool-call-1');
    expect(toolMessage?.toolName).toBe('exo_test_tool');

    const finalAssistantMessage = messages.find(
      (message) => message.role === 'ASSISTANT' && message.toolCalls === null,
    );
    expect(finalAssistantMessage).toBeDefined();
    expect(finalAssistantMessage?.content).toBe(run.resultText);
  }, 60_000);

  it('fails with ai_tool_limit_exceeded once the iteration cap is reached', async () => {
    const conversationId = await createConversation();
    const runId = await createConversationRun({
      conversationId,
      content: 'Bitte [[call:exo_test_tool]] ausführen',
    });

    const processor = createAiRunProcessor({
      prisma,
      provider: new MockAiProvider({ chunkDelayMs: 0 }),
      bus,
      storage: fakeStorage(Buffer.from('unused')),
      settings: stubSettings({ 'ai.maxToolIterations': 0 }),
      toolRunnerFactory: () => stubToolRunner([{ text: 'unused', isError: false }]),
      visionPreprocessorFor: () => null,
      modelRegistry: async () => toolCapableModelRow('test-tool-model'),
    });

    await processor(contextFor({ correlationId: 'test-tool-limit-1', runId, workspaceId, userId }).context);

    const run = await prisma.aiRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.status).toBe('FAILED');
    expect(run.errorCode).toBe('ai_tool_limit_exceeded');
  }, 60_000);
});

describe('compactIfNeeded', () => {
  it('summarizes older messages, keeps the recent tail active and inserts one summary message', async () => {
    const conversationId = await createConversation();
    const now = Date.now();
    for (let index = 0; index < 6; index += 1) {
      await prisma.aiConversationMessage.create({
        data: {
          conversationId,
          role: index % 2 === 0 ? 'USER' : 'ASSISTANT',
          content: `Nachricht Nummer ${index}, `.repeat(50),
          estimatedTokens: 500,
          createdAt: new Date(now + index * 1_000),
        },
      });
    }

    const provider = new MockAiProvider({ chunkDelayMs: 0, fixedResponse: 'Kurze Zusammenfassung.' });
    const result = await compactIfNeeded({
      prisma,
      provider,
      bus,
      conversationId,
      workspaceId,
      contextWindowTokens: 1_000,
      reservedOutputTokens: 100,
      systemPromptTokens: 0,
      thresholdPercent: 50,
      keepRecentMessages: 2,
      summaryModel: 'exocortex-mock-1',
      correlationId: 'test-compact-1',
      logger,
    });

    expect(result.compacted).toBe(true);
    expect(result.summarizedMessages).toBe(4);

    const messages = await prisma.aiConversationMessage.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'asc' },
    });
    const active = messages.filter((message) => message.supersededAt === null);
    const superseded = messages.filter((message) => message.supersededAt !== null);
    expect(superseded.length).toBe(4);
    // The 2 kept recent messages plus 1 new summary message.
    expect(active.length).toBe(3);
    expect(active.some((message) => message.isSummary)).toBe(true);
    expect(active.find((message) => message.isSummary)?.content).toContain('Kurze Zusammenfassung.');
  }, 60_000);

  it('does nothing when the active messages are already within budget', async () => {
    const conversationId = await createConversation();
    await prisma.aiConversationMessage.create({
      data: { conversationId, role: 'USER', content: 'Kurze Frage', estimatedTokens: 5 },
    });

    const provider = new MockAiProvider({ chunkDelayMs: 0 });
    const result = await compactIfNeeded({
      prisma,
      provider,
      bus,
      conversationId,
      workspaceId,
      contextWindowTokens: 100_000,
      reservedOutputTokens: 1_000,
      systemPromptTokens: 0,
      thresholdPercent: 70,
      keepRecentMessages: 8,
      summaryModel: 'exocortex-mock-1',
      correlationId: 'test-compact-2',
      logger,
    });

    expect(result).toEqual({ compacted: false, summarizedMessages: 0 });
  }, 30_000);
});

describe('attachment text extraction', () => {
  /** The default for tests that are about the engine chain, not the file. */
  const noDocumentInfo: PdfDocumentInfoReader = { read: async () => null };

  const stubMetadata: PdfMetadata = {
    extractor: 'stub',
    title: null,
    author: null,
    creator: null,
    producer: null,
    createdAt: null,
    modifiedAt: null,
    pageCount: null,
    tableCount: null,
    pictureCount: null,
    confidence: null,
    ocrUsed: null,
  };

  async function createAttachment(input: { mimeType: string; byteSize?: number }): Promise<string> {
    const attachment = await prisma.attachment.create({
      data: {
        workspaceId,
        filename: 'test-file',
        mimeType: input.mimeType,
        byteSize: input.byteSize ?? 10,
        storageKey: `test/attachment-text-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
        createdById: userId,
      },
    });
    return attachment.id;
  }

  it('marks a non-PDF attachment as NOT_APPLICABLE', async () => {
    const attachmentId = await createAttachment({ mimeType: 'image/png' });
    const processor = createAttachmentTextProcessor({
      prisma,
      storage: fakeStorage(Buffer.from('unused')),
      extractors: () => [{ extract: async () => ({ text: 'unused', metadata: stubMetadata }) }],
      documentInfo: noDocumentInfo,
      settings: stubSettings(),
    });

    await processor(
      contextFor({ correlationId: 'test-attach-1', attachmentId, workspaceId, reason: 'upload' }).context,
    );

    const attachment = await prisma.attachment.findUniqueOrThrow({ where: { id: attachmentId } });
    expect(attachment.textStatus).toBe('NOT_APPLICABLE');
  }, 30_000);

  it('fails with a clear reason when no extractor is configured', async () => {
    const attachmentId = await createAttachment({ mimeType: 'application/pdf' });
    const processor = createAttachmentTextProcessor({
      prisma,
      storage: fakeStorage(Buffer.from('unused')),
      extractors: () => [],
      documentInfo: noDocumentInfo,
      settings: stubSettings(),
    });

    await processor(
      contextFor({ correlationId: 'test-attach-2', attachmentId, workspaceId, reason: 'upload' }).context,
    );

    const attachment = await prisma.attachment.findUniqueOrThrow({ where: { id: attachmentId } });
    expect(attachment.textStatus).toBe('FAILED');
    expect(attachment.textExtractionError).toBe('PDF extraction is not configured');
  }, 30_000);

  it('falls through to the next engine when the first finds no text', async () => {
    const attachmentId = await createAttachment({ mimeType: 'application/pdf' });
    const calls: string[] = [];
    const processor = createAttachmentTextProcessor({
      prisma,
      storage: fakeStorage(Buffer.from('%PDF-1.7 scanned')),
      // Mirrors a scan meeting the text-only engine first: it reports nothing,
      // and the OCR-capable engine behind it reads the document.
      extractors: () => [
        {
          extract: async () => {
            calls.push('text-only');
            // No text, but the metadata dictionary it did read must survive.
            return { text: null, metadata: { ...stubMetadata, title: 'Kontoauszug' } };
          },
        },
        {
          extract: async () => {
            calls.push('ocr');
            return {
              text: 'text from the scan',
              metadata: { ...stubMetadata, extractor: 'ocr', ocrUsed: true, pageCount: 3 },
            };
          },
        },
      ],
      documentInfo: noDocumentInfo,
      settings: stubSettings(),
    });

    await processor(
      contextFor({ correlationId: 'test-attach-3', attachmentId, workspaceId, reason: 'upload' }).context,
    );

    expect(calls).toEqual(['text-only', 'ocr']);
    const attachment = await prisma.attachment.findUniqueOrThrow({ where: { id: attachmentId } });
    expect(attachment.textStatus).toBe('READY');
    expect(attachment.extractedText).toBe('text from the scan');
    // The union of both attempts: the title only the first engine saw, the
    // layout and OCR flag only the second one knew.
    expect(attachment.textMetadata).toMatchObject({
      extractor: 'ocr',
      title: 'Kontoauszug',
      pageCount: 3,
      ocrUsed: true,
    });
  }, 30_000);

  it('tries the next engine when one throws', async () => {
    // The hosted engine timing out on a long document is exactly when the local
    // one should get its turn, so a throw must not end the chain.
    const attachmentId = await createAttachment({ mimeType: 'application/pdf' });
    const processor = createAttachmentTextProcessor({
      prisma,
      storage: fakeStorage(Buffer.from('%PDF-1.7')),
      extractors: () => [
        {
          extract: async () => {
            throw new Error('This operation was aborted');
          },
        },
        { extract: async () => ({ text: 'read by the second engine', metadata: stubMetadata }) },
      ],
      documentInfo: noDocumentInfo,
      settings: stubSettings(),
    });

    await processor(
      contextFor({ correlationId: 'test-attach-5', attachmentId, workspaceId, reason: 'upload' }).context,
    );

    const attachment = await prisma.attachment.findUniqueOrThrow({ where: { id: attachmentId } });
    expect(attachment.textStatus).toBe('READY');
    expect(attachment.extractedText).toBe('read by the second engine');
  }, 30_000);

  it('rethrows when every engine throws, so BullMQ retries', async () => {
    const attachmentId = await createAttachment({ mimeType: 'application/pdf' });
    const processor = createAttachmentTextProcessor({
      prisma,
      storage: fakeStorage(Buffer.from('%PDF-1.7')),
      extractors: () => [
        {
          extract: async () => {
            throw new Error('docling unreachable');
          },
        },
      ],
      documentInfo: noDocumentInfo,
      settings: stubSettings(),
    });

    await expect(
      processor(
        contextFor({ correlationId: 'test-attach-6', attachmentId, workspaceId, reason: 'upload' }).context,
      ),
    ).rejects.toThrow('docling unreachable');

    // Nothing was learned, so the attachment must not be written off as
    // "no text layer" -- the retry has to find it still open.
    const attachment = await prisma.attachment.findUniqueOrThrow({ where: { id: attachmentId } });
    expect(attachment.textStatus).not.toBe('FAILED');
  }, 30_000);

  it('stops at the first engine that returns text', async () => {
    const attachmentId = await createAttachment({ mimeType: 'application/pdf' });
    let secondCalled = false;
    const processor = createAttachmentTextProcessor({
      prisma,
      storage: fakeStorage(Buffer.from('%PDF-1.7 with a text layer')),
      extractors: () => [
        { extract: async () => ({ text: 'from the text layer', metadata: stubMetadata }) },
        {
          extract: async () => {
            secondCalled = true;
            return { text: null, metadata: null };
          },
        },
      ],
      documentInfo: noDocumentInfo,
      settings: stubSettings(),
    });

    await processor(
      contextFor({ correlationId: 'test-attach-4', attachmentId, workspaceId, reason: 'upload' }).context,
    );

    expect(secondCalled).toBe(false);
    const attachment = await prisma.attachment.findUniqueOrThrow({ where: { id: attachmentId } });
    expect(attachment.extractedText).toBe('from the text layer');
  }, 30_000);

  it('joins the locally read dictionary with what the engine reported', async () => {
    // The point of reading the dictionary locally: the engine that wins on text
    // reports layout and nothing else, and must not have to be the expensive
    // one just because it is the only one that knows the title.
    const attachmentId = await createAttachment({ mimeType: 'application/pdf' });
    const processor = createAttachmentTextProcessor({
      prisma,
      storage: fakeStorage(Buffer.from('%PDF-1.7 scanned')),
      extractors: () => [
        {
          extract: async () => ({
            text: 'text from the scan',
            metadata: {
              ...stubMetadata,
              extractor: 'docling',
              pageCount: 3,
              tableCount: 2,
              ocrUsed: true,
            },
          }),
        },
      ],
      documentInfo: {
        read: async () => ({
          ...stubMetadata,
          extractor: 'pdf-info',
          title: 'Quartalsbericht Q3',
          author: 'Johanna Panda',
          createdAt: '2026-04-01T12:00:00.000Z',
          pageCount: 3,
        }),
      },
      settings: stubSettings(),
    });

    await processor(
      contextFor({ correlationId: 'test-attach-7', attachmentId, workspaceId, reason: 'upload' }).context,
    );

    const attachment = await prisma.attachment.findUniqueOrThrow({ where: { id: attachmentId } });
    expect(attachment.textMetadata).toMatchObject({
      extractor: 'docling',
      title: 'Quartalsbericht Q3',
      author: 'Johanna Panda',
      createdAt: '2026-04-01T12:00:00.000Z',
      tableCount: 2,
      ocrUsed: true,
    });
  }, 30_000);

  it('keeps the dictionary when no engine finds any text', async () => {
    const attachmentId = await createAttachment({ mimeType: 'application/pdf' });
    const processor = createAttachmentTextProcessor({
      prisma,
      storage: fakeStorage(Buffer.from('%PDF-1.7 empty')),
      extractors: () => [{ extract: async () => ({ text: null, metadata: null }) }],
      documentInfo: {
        read: async () => ({
          ...stubMetadata,
          extractor: 'pdf-info',
          title: 'Leeres Formular',
          pageCount: 12,
        }),
      },
      settings: stubSettings(),
    });

    await processor(
      contextFor({ correlationId: 'test-attach-8', attachmentId, workspaceId, reason: 'upload' }).context,
    );

    const attachment = await prisma.attachment.findUniqueOrThrow({ where: { id: attachmentId } });
    expect(attachment.textStatus).toBe('FAILED');
    // A reader still learns what the document is, even though nobody read it.
    expect(attachment.textMetadata).toMatchObject({
      extractor: 'pdf-info',
      title: 'Leeres Formular',
      pageCount: 12,
    });
  }, 30_000);

  it('skips a READY attachment unless the job says forced', async () => {
    const attachmentId = await createAttachment({ mimeType: 'application/pdf' });
    await prisma.attachment.update({
      where: { id: attachmentId },
      data: { textStatus: 'READY', extractedText: 'already read' },
    });
    let calls = 0;
    const processor = createAttachmentTextProcessor({
      prisma,
      storage: fakeStorage(Buffer.from('%PDF-1.7')),
      extractors: () => [
        {
          extract: async () => {
            calls += 1;
            return { text: 'read again', metadata: stubMetadata };
          },
        },
      ],
      documentInfo: noDocumentInfo,
      settings: stubSettings(),
    });

    await processor(
      contextFor({ correlationId: 'test-attach-9', attachmentId, workspaceId, reason: 'retry' }).context,
    );
    expect(calls).toBe(0);
    expect(
      (await prisma.attachment.findUniqueOrThrow({ where: { id: attachmentId } })).extractedText,
    ).toBe('already read');

    // `forced` is the one reason allowed to skip the guard (issue #2): a
    // successful extraction can still be a wrong one.
    await processor(
      contextFor({ correlationId: 'test-attach-9b', attachmentId, workspaceId, reason: 'forced' })
        .context,
    );
    expect(calls).toBe(1);
    expect(
      (await prisma.attachment.findUniqueOrThrow({ where: { id: attachmentId } })).extractedText,
    ).toBe('read again');
  }, 30_000);

  it('never touches a human correction, forced re-extraction or not', async () => {
    const attachmentId = await createAttachment({ mimeType: 'application/pdf' });
    await prisma.attachment.update({
      where: { id: attachmentId },
      data: {
        textStatus: 'READY',
        extractedText: 'machine result',
        correctedText: 'the corrected version a person wrote',
        textCorrectedAt: new Date('2026-05-01T00:00:00.000Z'),
        textCorrectedById: userId,
      },
    });
    const processor = createAttachmentTextProcessor({
      prisma,
      storage: fakeStorage(Buffer.from('%PDF-1.7')),
      extractors: () => [{ extract: async () => ({ text: 'a fresh machine result', metadata: stubMetadata }) }],
      documentInfo: noDocumentInfo,
      settings: stubSettings(),
    });

    await processor(
      contextFor({ correlationId: 'test-attach-10', attachmentId, workspaceId, reason: 'forced' })
        .context,
    );

    const attachment = await prisma.attachment.findUniqueOrThrow({ where: { id: attachmentId } });
    expect(attachment.extractedText).toBe('a fresh machine result');
    expect(attachment.correctedText).toBe('the corrected version a person wrote');
    expect(attachment.textCorrectedById).toBe(userId);
  }, 30_000);

  it('records when the extracted text was cut off, and resets the flag on a shorter re-read', async () => {
    const attachmentId = await createAttachment({ mimeType: 'application/pdf' });
    const longText = 'a'.repeat(400_001);
    const processor = createAttachmentTextProcessor({
      prisma,
      storage: fakeStorage(Buffer.from('%PDF-1.7')),
      extractors: () => [{ extract: async () => ({ text: longText, metadata: stubMetadata }) }],
      documentInfo: noDocumentInfo,
      settings: stubSettings(),
    });

    await processor(
      contextFor({ correlationId: 'test-attach-11', attachmentId, workspaceId, reason: 'upload' })
        .context,
    );

    const truncated = await prisma.attachment.findUniqueOrThrow({ where: { id: attachmentId } });
    expect(truncated.textTruncated).toBe(true);
    expect(truncated.extractedText).toHaveLength(400_000);

    const processorShort = createAttachmentTextProcessor({
      prisma,
      storage: fakeStorage(Buffer.from('%PDF-1.7')),
      extractors: () => [{ extract: async () => ({ text: 'short result', metadata: stubMetadata }) }],
      documentInfo: noDocumentInfo,
      settings: stubSettings(),
    });
    await processorShort(
      contextFor({ correlationId: 'test-attach-11b', attachmentId, workspaceId, reason: 'forced' })
        .context,
    );

    const reread = await prisma.attachment.findUniqueOrThrow({ where: { id: attachmentId } });
    expect(reread.textTruncated).toBe(false);
  }, 30_000);
});

/**
 * The reference index (issue #19).
 *
 * Covers the two halves that can drift apart: extraction, which runs with
 * materialization and must *replace* what it wrote before, and resolution,
 * which runs from the target side when a page appears or is renamed and is the
 * only thing standing between a title-based index and silent staleness.
 */
describe('document links', () => {
  const LINKING_MARKDOWN = `# Quelle

Ein Absatz mit [[Zielseite]] mittendrin und einer @[[Zielseite]].

:::page Zielseite
:::
`;

  async function createLinkingDocument(markdown: string, title: string): Promise<string> {
    const imported = markdownToYjsState(markdown);
    const document = await prisma.document.create({
      data: {
        workspaceId,
        title,
        orderKey: generateOrderKey(null, null),
        createdById: userId,
        updatedById: userId,
        content: {
          create: { yjsState: Buffer.from(imported.yjsState), yjsUpdatedAt: new Date() },
        },
      },
    });
    return document.id;
  }

  async function materialize(documentId: string, correlationId: string): Promise<void> {
    const processor = createMaterializeDocumentProcessor({ prisma, queues, bus });
    await processor(
      contextFor({
        correlationId,
        documentId,
        workspaceId,
        yjsUpdatedAt: Date.now(),
        reason: 'manual' as const,
      }).context,
    );
  }

  function maintenance() {
    return createMaintenanceProcessor({
      prisma,
      queues,
      storage: recordingStorage(),
      bus,
      settings: stubSettings(),
    });
  }

  it('records all three notations when a page is materialized', async () => {
    const sourceId = await createLinkingDocument(LINKING_MARKDOWN, 'Quelle A');
    await materialize(sourceId, 'test-links-1');

    const links = await prisma.documentLink.findMany({
      where: { sourceDocumentId: sourceId },
      orderBy: { position: 'asc' },
    });
    expect(links.map((link) => link.kind).sort()).toEqual(['MENTION', 'PAGE_LINK', 'WIKI_MARK']);
    expect(new Set(links.map((link) => link.targetTitleKey))).toEqual(new Set(['zielseite']));
    expect(links.every((link) => link.workspaceId === workspaceId)).toBe(true);
    // Unresolved: no page carries that title yet.
    expect(links.every((link) => link.targetDocumentId === null)).toBe(true);
    // The wiki mark's preview is the sentence it sits in, not just the title.
    const wikiMark = links.find((link) => link.kind === 'WIKI_MARK');
    expect(wikiMark?.context).toContain('mittendrin');

    const content = await prisma.documentContent.findUniqueOrThrow({
      where: { documentId: sourceId },
      select: { linksIndexedAt: true },
    });
    expect(content.linksIndexedAt).not.toBeNull();
  }, 60_000);

  it('replaces the references when the page is materialized again', async () => {
    const sourceId = await createLinkingDocument(LINKING_MARKDOWN, 'Quelle B');
    await materialize(sourceId, 'test-links-2');
    expect(await prisma.documentLink.count({ where: { sourceDocumentId: sourceId } })).toBe(3);

    const rewritten = markdownToYjsState('# Quelle B\n\nJetzt nur noch [[Andere Seite]].\n');
    await prisma.documentContent.update({
      where: { documentId: sourceId },
      data: {
        yjsState: Buffer.from(rewritten.yjsState),
        yjsUpdatedAt: new Date(Date.now() + 1_000),
      },
    });
    await materialize(sourceId, 'test-links-2b');

    const links = await prisma.documentLink.findMany({ where: { sourceDocumentId: sourceId } });
    expect(links).toHaveLength(1);
    expect(links[0]?.targetTitleKey).toBe('andere seite');
  }, 60_000);

  it('resolves a reference to a page that is only created afterwards', async () => {
    const sourceId = await createLinkingDocument(
      '# Quelle C\n\nEin Verweis auf [[Spätgeburt]].\n',
      'Quelle C',
    );
    await materialize(sourceId, 'test-links-3');
    expect(
      await prisma.documentLink.count({
        where: { sourceDocumentId: sourceId, targetDocumentId: null },
      }),
    ).toBe(1);

    const target = await prisma.document.create({
      data: {
        workspaceId,
        title: 'Spätgeburt',
        orderKey: generateOrderKey(null, null),
        createdById: userId,
        updatedById: userId,
      },
    });
    await maintenance()(
      contextFor({
        correlationId: 'test-links-3b',
        task: 'resolve-document-links',
        workspaceId,
        documentId: target.id,
      }).context,
    );

    const link = await prisma.documentLink.findFirstOrThrow({
      where: { sourceDocumentId: sourceId },
    });
    expect(link.targetDocumentId).toBe(target.id);
  }, 60_000);

  it('lets go of a reference when the target is renamed, and hands it to the new namesake', async () => {
    const target = await prisma.document.create({
      data: {
        workspaceId,
        title: 'Wanderpokal',
        orderKey: generateOrderKey(null, null),
        createdById: userId,
        updatedById: userId,
      },
    });
    const sourceId = await createLinkingDocument(
      '# Quelle D\n\nEin Verweis auf [[Wanderpokal]].\n',
      'Quelle D',
    );
    await materialize(sourceId, 'test-links-4');
    const initial = await prisma.documentLink.findFirstOrThrow({
      where: { sourceDocumentId: sourceId },
    });
    expect(initial.targetDocumentId).toBe(target.id);

    await prisma.document.update({
      where: { id: target.id },
      data: { title: 'Ganz anders' },
    });
    await maintenance()(
      contextFor({
        correlationId: 'test-links-4b',
        task: 'resolve-document-links',
        workspaceId,
        documentId: target.id,
      }).context,
    );
    const orphaned = await prisma.documentLink.findFirstOrThrow({
      where: { sourceDocumentId: sourceId },
    });
    expect(orphaned.targetDocumentId).toBeNull();

    // A different page takes the title over: the reference follows the title.
    const successor = await prisma.document.create({
      data: {
        workspaceId,
        title: 'Wanderpokal',
        orderKey: generateOrderKey(null, null),
        createdById: userId,
        updatedById: userId,
      },
    });
    await maintenance()(
      contextFor({
        correlationId: 'test-links-4c',
        task: 'resolve-document-links',
        workspaceId,
        documentId: successor.id,
      }).context,
    );
    const rebound = await prisma.documentLink.findFirstOrThrow({
      where: { sourceDocumentId: sourceId },
    });
    expect(rebound.targetDocumentId).toBe(successor.id);
  }, 60_000);

  /**
   * Issue #14: a `pageLink` block carries the identity of its target, so a
   * rename is a non-event for it. The title-only notations above keep their old
   * behaviour; this is the difference the identity makes.
   */
  it('keeps a reference that carries an identity when the target is renamed', async () => {
    const target = await prisma.document.create({
      data: {
        workspaceId,
        title: 'Wird umbenannt',
        orderKey: generateOrderKey(null, null),
        createdById: userId,
        updatedById: userId,
      },
    });

    const imported = markdownToYjsState(':::page Wird umbenannt\n:::\n', {
      transformDocument: (document) => bindPageLinkIdentities(document, () => target.id),
    });
    const source = await prisma.document.create({
      data: {
        workspaceId,
        title: 'Quelle mit Identität',
        orderKey: generateOrderKey(null, null),
        createdById: userId,
        updatedById: userId,
        content: {
          create: { yjsState: Buffer.from(imported.yjsState), yjsUpdatedAt: new Date() },
        },
      },
    });
    await materialize(source.id, 'test-links-identity');

    const initial = await prisma.documentLink.findFirstOrThrow({
      where: { sourceDocumentId: source.id },
    });
    expect(initial.targetHintId).toBe(target.id);
    expect(initial.targetDocumentId).toBe(target.id);

    await prisma.document.update({
      where: { id: target.id },
      data: { title: 'Heißt jetzt anders' },
    });
    await maintenance()(
      contextFor({
        correlationId: 'test-links-identity-b',
        task: 'resolve-document-links',
        workspaceId,
        documentId: target.id,
      }).context,
    );

    const afterRename = await prisma.documentLink.findFirstOrThrow({
      where: { sourceDocumentId: source.id },
    });
    // The title in the index is stale, the reference is not.
    expect(afterRename.targetDocumentId).toBe(target.id);

    // And a new page taking the old title over does not steal the reference.
    const namesake = await prisma.document.create({
      data: {
        workspaceId,
        title: 'Wird umbenannt',
        orderKey: generateOrderKey(null, null),
        createdById: userId,
        updatedById: userId,
      },
    });
    await maintenance()(
      contextFor({
        correlationId: 'test-links-identity-c',
        task: 'resolve-document-links',
        workspaceId,
        documentId: namesake.id,
      }).context,
    );

    const afterNamesake = await prisma.documentLink.findFirstOrThrow({
      where: { sourceDocumentId: source.id },
    });
    expect(afterNamesake.targetDocumentId).toBe(target.id);
  }, 60_000);

  it('does nothing when the page it should resolve for is gone', async () => {
    await expect(
      maintenance()(
        contextFor({
          correlationId: 'test-links-5',
          task: 'resolve-document-links',
          workspaceId,
          documentId: 'does-not-exist',
        }).context,
      ),
    ).resolves.toBeUndefined();
  }, 30_000);

  it('backfills a page that was materialized before the index existed', async () => {
    const sourceId = await createLinkingDocument(
      '# Quelle E\n\nEin Verweis auf [[Nachzügler]].\n',
      'Quelle E',
    );
    await materialize(sourceId, 'test-links-6');
    // Back to the state an existing deployment is in: derived JSON, no references.
    await prisma.documentLink.deleteMany({ where: { sourceDocumentId: sourceId } });
    await prisma.documentContent.update({
      where: { documentId: sourceId },
      data: { linksIndexedAt: null },
    });

    await maintenance()(
      contextFor({
        correlationId: 'test-links-6b',
        task: 'backfill-document-links',
        workspaceId,
        documentId: null,
      }).context,
    );

    const links = await prisma.documentLink.findMany({ where: { sourceDocumentId: sourceId } });
    expect(links).toHaveLength(1);
    expect(links[0]?.targetTitleKey).toBe('nachzügler');

    // Running it again finds nothing left to do for this page.
    const marked = await prisma.documentContent.findUniqueOrThrow({
      where: { documentId: sourceId },
      select: { linksIndexedAt: true },
    });
    expect(marked.linksIndexedAt).not.toBeNull();
  }, 60_000);

  it('turns a document.updated outbox event into a resolution job', async () => {
    const target = await prisma.document.create({
      data: {
        workspaceId,
        title: 'Umbenannt',
        orderKey: generateOrderKey(null, null),
        createdById: userId,
        updatedById: userId,
      },
    });
    const sourceId = await createLinkingDocument(
      '# Quelle F\n\nEin Verweis auf [[Umbenannt]].\n',
      'Quelle F',
    );
    await materialize(sourceId, 'test-links-7');
    await prisma.document.update({ where: { id: target.id }, data: { title: 'Doch nicht' } });
    await prisma.outboxEvent.create({
      data: {
        workspaceId,
        type: 'document.updated',
        payload: { documentId: target.id },
        correlationId: 'test-links-7b',
      },
    });

    const processor = maintenance();
    await processor(
      contextFor({
        correlationId: 'test-links-7b',
        task: 'dispatch-outbox',
        workspaceId: null,
        documentId: null,
      }).context,
    );

    const job = await queues
      .getQueue('maintenance')
      .getJobs(['waiting', 'delayed', 'active', 'completed']);
    const resolution = job.find(
      (entry) =>
        entry.data.task === 'resolve-document-links' && entry.data.documentId === target.id,
    );
    expect(resolution).toBeDefined();
  }, 60_000);
});
