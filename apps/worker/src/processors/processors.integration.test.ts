import { Readable } from 'node:stream';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  type AiGenerateRequest,
  type AiGenerateResult,
  type AiProvider,
  type AiProviderCapabilities,
  AiProviderError,
  type AiStreamEvent,
  type AiToolCall,
  createEmbeddingClient,
  MockAiProvider,
  MockEmbeddingProvider,
  MockImageGenerator,
  type PdfDocumentInfoReader,
  type VisionPreprocessor,
} from '@exocortex/ai';
import { loadWorkerEnv } from '@exocortex/config';
import {
  AI_RUN_HEARTBEAT_STALE_MS,
  type JobPayloadMap,
  type PdfMetadata,
  QUEUE_NAMES,
  type Settings,
  settingsSchema,
} from '@exocortex/contracts';
import {
  applyModelRouteSnapshot,
  createPrismaClient,
  generateOrderKey,
  HybridSearchAdapter,
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
import { repairUnresolvedLinks } from './document-links';
import { createIndexDocumentProcessor } from './index-document';
import { createMaintenanceProcessor } from './maintenance';
import { createMaterializeDocumentProcessor } from './materialize-document';
import { createRenderProcessor } from './render';

/**
 * The provider an AI run should use, wrapped the way the runtime hands it over
 * (issue #52): these tests are about what a run does, not about whose key paid
 * for it, so every one of them runs on the deployment's.
 */
function providerFor(provider: AiProvider): (workspaceId: string) => Promise<{
  provider: AiProvider;
  key: { apiKey: string; usedOwnKey: boolean };
}> {
  return async () => ({ provider, key: { apiKey: 'test-key', usedOwnKey: false } });
}

/** A fully-defaulted `Settings` object with just the given keys overridden. */
function stubSettings(
  overrides: Partial<Settings> = {},
): (workspaceId?: string) => Promise<Settings> {
  const settings = settingsSchema.parse(overrides);
  return async () => settings;
}

/**
 * Settings that only apply inside one workspace, defaults everywhere else.
 *
 * This suite runs against the deployment's own database, and since issue #52
 * the memory sweeps iterate over *every* workspace marked `isMemory` rather
 * than over one configured id. A flat stub would therefore hand a test's
 * `memory.retentionDays` to the real memory area and prune somebody's notes.
 * Anything that exercises a per-workspace sweep has to use this.
 */
function stubSettingsForWorkspace(
  onlyForWorkspaceId: string,
  overrides: Partial<Settings>,
): (workspaceId?: string) => Promise<Settings> {
  const scoped = settingsSchema.parse(overrides);
  const untouched = settingsSchema.parse({});
  return async (workspaceId?: string) => (workspaceId === onlyForWorkspaceId ? scoped : untouched);
}

/**
 * Same as `stubSettings`, but bypasses zod validation for the override.
 *
 * A real deployment cannot set `ai.maxRunMs` or `ai.timeoutMs` below their
 * documented floors (60s / 5s), so this is not a case a production settings
 * row can reach. It is what lets a test exercise the run-budget mechanism
 * itself in milliseconds instead of minutes.
 */
function stubSettingsUnchecked(
  overrides: Partial<Settings>,
): (workspaceId?: string) => Promise<Settings> {
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
    // Priced, so the tool-loop tests also cover the estimate that fills in when
    // the mock provider reports no cost of its own (issue #10).
    inputMicroUsdPerMTok: 3_000_000,
    outputMicroUsdPerMTok: 15_000_000,
    // No endpoint snapshot: the mock provider has nothing to choose between, so
    // the run plans no allowlist and routes exactly as it did before ADR-032.
    endpoints: [],
    aliasTargetSlug: null,
  };
}

/**
 * Returns one canned response per call, in order; extra calls get an error
 * result. `refused` defaults to false: the runs here never read foreign text,
 * so the write fence of ADR-030 is never the reason a call comes back empty,
 * and a test about it says so.
 */
function stubToolRunner(
  responses: readonly { text: string; isError: boolean; refused?: boolean }[],
): ToolRunner {
  let callIndex = 0;
  return {
    definitions: [{ name: 'exo_test_tool', description: 'Ein Testwerkzeug', parameters: {} }],
    untrustedOrigins: [],
    noteUntrustedContent() {},
    async run() {
      const response = responses[callIndex] ?? {
        text: 'Keine weitere Antwort konfiguriert',
        isError: true,
      };
      callIndex += 1;
      return { text: response.text, isError: response.isError, refused: response.refused ?? false };
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
let search: HybridSearchAdapter;
let keywordSearch: PostgresSearchAdapter;
/**
 * The semantic half is off for every existing test, so the hybrid adapter
 * behaves exactly like the full-text one, and the tests that are about
 * semantic search switch it on for their own duration.
 */
let semanticModel: string | null = null;
const TEST_EMBEDDING_MODEL = 'mock/embedding';
let workspaceId: string;
let userId: string;

const MARKDOWN = `# Testseite

Ein Absatz mit dem Wort Zwiebelkuchen.

- [x] Erledigt
- [ ] Offen
`;

type QueueKey = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

/**
 * Where `sync-ai-model-routes` would read the catalogue. Every maintenance
 * test names it, because the dependency is required and a sweep that never
 * calls out must still be constructed the way the worker constructs it; the
 * tests that do exercise the sync point `fetch` at this host themselves.
 */
const OPENROUTER_TEST_BASE_URL = 'https://openrouter.test/api/v1';

/**
 * Builds a job context with a progress recorder. The processors are invoked
 * directly, so the BullMQ `Job` is stubbed down to the fields they read.
 *
 * The queue is named at the call site (`contextFor<'render'>({ ... })`) rather
 * than inferred: the payload is the only argument, and TypeScript infers
 * nothing from `JobPayloadMap[TName]`, so an inferred call would quietly settle
 * on the union of every queue and check the payload against none of them. With
 * the name written down, the payload is checked against that queue's schema,
 * which is the whole reason these tests can call a processor directly.
 */
function contextFor<TName extends QueueKey>(
  payload: JobPayloadMap[TName],
): {
  context: JobContext<TName>;
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
  } as unknown as JobContext<TName>;
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
  keywordSearch = new PostgresSearchAdapter(prisma);
  search = new HybridSearchAdapter({
    prisma,
    keyword: keywordSearch,
    embeddings: createEmbeddingClient(new MockEmbeddingProvider()),
    options: async () => (semanticModel === null ? null : { model: semanticModel, weight: 0.5 }),
    logger,
  });

  const suffix = Date.now().toString(36);
  const user = await prisma.user.create({
    data: { email: `worker-${suffix}@exocortex.test`, name: 'Worker Test', emailVerified: true },
  });
  userId = user.id;
  const workspace = await prisma.workspace.create({
    data: {
      name: `Worker ${suffix}`,
      slug: `worker-${suffix}`,
      // The memory sweeps look for this flag now, not for a settings key.
      isMemory: true,
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
    const processor = createMaterializeDocumentProcessor({
      prisma,
      queues,
      bus,
      settings: stubSettings(),
    });
    const { context, progress } = contextFor<'document-materialization'>({
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
    const processor = createMaterializeDocumentProcessor({
      prisma,
      queues,
      bus,
      settings: stubSettings(),
    });
    const payload = {
      correlationId: 'test-2',
      documentId,
      workspaceId,
      yjsUpdatedAt: Date.now(),
      reason: 'collaboration_store' as const,
    };

    await processor(contextFor<'document-materialization'>(payload).context);
    const first = await prisma.documentContent.findUniqueOrThrow({
      where: { documentId },
      select: { plainText: true, markdown: true, materializedAt: true },
    });

    // Second run: the derived data is already at least as fresh as the state.
    await processor(contextFor<'document-materialization'>(payload).context);
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
    const processor = createMaterializeDocumentProcessor({
      prisma,
      queues,
      bus,
      settings: stubSettings(),
    });
    const payload = {
      correlationId: 'test-3',
      documentId,
      workspaceId,
      yjsUpdatedAt: Date.now(),
      reason: 'collaboration_store' as const,
    };
    await processor(contextFor<'document-materialization'>(payload).context);

    const changed = markdownToYjsState('# Neuer Titel\n\nGanz anderer Inhalt.\n');
    await prisma.documentContent.update({
      where: { documentId },
      data: { yjsState: Buffer.from(changed.yjsState), yjsUpdatedAt: new Date(Date.now() + 1_000) },
    });

    await processor(contextFor<'document-materialization'>(payload).context);
    const content = await prisma.documentContent.findUniqueOrThrow({
      where: { documentId },
      select: { plainText: true },
    });
    expect(content.plainText).toContain('Ganz anderer Inhalt');
    expect(content.plainText).not.toContain('Zwiebelkuchen');
  }, 60_000);

  it('skips a document without content instead of failing', async () => {
    const processor = createMaterializeDocumentProcessor({
      prisma,
      queues,
      bus,
      settings: stubSettings(),
    });
    await expect(
      processor(
        contextFor<'document-materialization'>({
          correlationId: 'test-4',
          documentId: 'nonexistent-document-id',
          workspaceId,
          yjsUpdatedAt: Date.now(),
          reason: 'manual',
        }).context,
      ),
    ).resolves.toBeUndefined();
  }, 30_000);

  /**
   * The sweep underneath the enqueue.
   *
   * Materialization is enqueued by whoever writes the canonical state, and a
   * lost enqueue is lost silently: the page keeps its old projection for ever,
   * and the search index and the AI's page context read the projection. This
   * reproduces that by writing a state without enqueuing anything.
   */
  describe('rematerialize-stale-content', () => {
    async function enqueuedDocumentIds(): Promise<string[]> {
      const queue = queues.getQueue(QUEUE_NAMES.documentMaterialization);
      const jobs = await queue.getJobs(['waiting', 'delayed', 'prioritized', 'active']);
      return jobs.map((job) => job.data.documentId);
    }

    it('hands a page whose derived data is behind back to the queue', async () => {
      const documentId = await createDocument();
      await prisma.documentContent.update({
        where: { documentId },
        data: { materializedAt: new Date(Date.now() - 60_000) },
      });

      await createMaintenanceProcessor({
        search,
        prisma,
        queues,
        storage: recordingStorage(),
        bus,
        settings: stubSettings(),
        openRouterBaseUrl: OPENROUTER_TEST_BASE_URL,
      })(
        contextFor<'maintenance'>({
          correlationId: 'test-rematerialize-1',
          task: 'rematerialize-stale-content',
          workspaceId,
          documentId: null,
        }).context,
      );

      expect(await enqueuedDocumentIds()).toContain(documentId);
    }, 60_000);

    it('leaves a page alone whose derived data is current', async () => {
      const documentId = await createDocument();
      await prisma.documentContent.update({
        where: { documentId },
        data: { materializedAt: new Date(Date.now() + 60_000) },
      });

      await createMaintenanceProcessor({
        search,
        prisma,
        queues,
        storage: recordingStorage(),
        bus,
        settings: stubSettings(),
        openRouterBaseUrl: OPENROUTER_TEST_BASE_URL,
      })(
        contextFor<'maintenance'>({
          correlationId: 'test-rematerialize-2',
          task: 'rematerialize-stale-content',
          workspaceId,
          documentId: null,
        }).context,
      );

      expect(await enqueuedDocumentIds()).not.toContain(documentId);
    }, 60_000);
  });
});

describe('search indexing', () => {
  it('indexes the materialized plain text and finds it again', async () => {
    const documentId = await createDocument();
    await createMaterializeDocumentProcessor({ prisma, queues, bus, settings: stubSettings() })(
      contextFor<'document-materialization'>({
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
    await indexer(contextFor<'search-indexing'>(payload).context);

    const results = await search.search({
      workspaceId,
      query: 'Zwiebelkuchen',
      limit: 10,
      includeArchived: false,
    });
    expect(results.map((result) => result.documentId)).toContain(documentId);
    expect(results[0]?.snippet).toContain('Zwiebelkuchen');

    // Running the indexer twice must not duplicate the projection.
    await indexer(contextFor<'search-indexing'>(payload).context);
    const rows = await prisma.documentSearchIndex.count({ where: { documentId } });
    expect(rows).toBe(1);
  }, 60_000);

  it('removes the projection of a deleted document', async () => {
    const documentId = await createDocument();
    const indexer = createIndexDocumentProcessor({ prisma, search });
    await indexer(
      contextFor<'search-indexing'>({
        correlationId: 'test-6',
        documentId,
        workspaceId,
        reason: 'manual',
      }).context,
    );
    expect(await prisma.documentSearchIndex.count({ where: { documentId } })).toBe(1);

    await prisma.document.delete({ where: { id: documentId } });
    await indexer(
      contextFor<'search-indexing'>({
        correlationId: 'test-6',
        documentId,
        workspaceId,
        reason: 'deleted',
      }).context,
    );
    expect(await prisma.documentSearchIndex.count({ where: { documentId } })).toBe(0);
  }, 60_000);

  it('excludes archived documents from search results by default', async () => {
    const documentId = await createDocument();
    await createMaterializeDocumentProcessor({ prisma, queues, bus, settings: stubSettings() })(
      contextFor<'document-materialization'>({
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
      contextFor<'search-indexing'>({
        correlationId: 'test-7',
        documentId,
        workspaceId,
        reason: 'archived',
      }).context,
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

/**
 * Semantic search (issue #34, AP4).
 *
 * The embedding client is `MockEmbeddingProvider`, which hashes vocabulary
 * rather than understanding it. That is enough to prove what these tests are
 * about: that a vector is written, that it is not written twice for the same
 * text, and that a page no full-text query matches still comes back.
 */
describe('semantic search', () => {
  async function indexedPage(title: string, body: string): Promise<string> {
    const document = await prisma.document.create({
      data: {
        workspaceId,
        title,
        orderKey: generateOrderKey(null, null),
        createdById: userId,
        updatedById: userId,
        content: { create: { yjsState: Buffer.from([]), plainText: body } },
      },
    });
    await createIndexDocumentProcessor({ prisma, search })(
      contextFor<'search-indexing'>({
        correlationId: 'semantic',
        documentId: document.id,
        workspaceId,
        reason: 'materialized' as const,
      }).context,
    );
    return document.id;
  }

  it('writes no vector while the feature is off', async () => {
    semanticModel = null;
    const documentId = await indexedPage('Ohne Bedeutung', 'Ein Text ohne Vektor.');

    expect(await prisma.documentEmbedding.count({ where: { documentId } })).toBe(0);
  }, 60_000);

  it('writes one vector per page and does not pay for an unchanged text twice', async () => {
    semanticModel = TEST_EMBEDDING_MODEL;
    try {
      const documentId = await indexedPage('Mit Bedeutung', 'Kalender Termine Erinnerungen.');
      const first = await prisma.documentEmbedding.findFirstOrThrow({ where: { documentId } });
      expect(first.textHash).not.toBeNull();

      // Re-indexing the same text must leave the row exactly as it was.
      await createIndexDocumentProcessor({ prisma, search })(
        contextFor<'search-indexing'>({
          correlationId: 'semantic',
          documentId,
          workspaceId,
          reason: 'materialized' as const,
        }).context,
      );
      const rows = await prisma.documentEmbedding.findMany({ where: { documentId } });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.createdAt.getTime()).toBe(first.createdAt.getTime());
    } finally {
      semanticModel = null;
    }
  }, 60_000);

  /** A page long enough to be cut up, with one passage about one rare thing. */
  const longBody = [
    ...Array.from(
      { length: 20 },
      (_, index) => `Absatz ${index} über Ablage und Verwaltung. ${'fuellwort '.repeat(25)}`,
    ),
    'Zwiebelkuchenrezept '.repeat(95),
    ...Array.from({ length: 10 }, (_, index) => `Nachtrag ${index}. ${'fuellwort '.repeat(25)}`),
  ].join('\n');

  it('cuts a long page into passages beside its whole-document vector', async () => {
    semanticModel = TEST_EMBEDDING_MODEL;
    try {
      const documentId = await indexedPage('Lange Seite', longBody);
      const rows = await prisma.documentEmbedding.findMany({ where: { documentId } });

      const whole = rows.filter((row) => row.blockId === null);
      const passages = rows.filter((row) => row.blockId !== null);
      expect(whole).toHaveLength(1);
      expect(whole[0]?.chunkText).toBeNull();
      expect(passages.length).toBeGreaterThan(1);
      expect(passages.every((row) => row.chunkText !== null && row.chunkText.length > 0)).toBe(
        true,
      );

      // Re-indexing the same text pays for nothing, passages included.
      await createIndexDocumentProcessor({ prisma, search })(
        contextFor<'search-indexing'>({
          correlationId: 'semantic',
          documentId,
          workspaceId,
          reason: 'materialized' as const,
        }).context,
      );
      const again = await prisma.documentEmbedding.findMany({ where: { documentId } });
      expect(again.map((row) => row.createdAt.getTime()).sort()).toEqual(
        rows.map((row) => row.createdAt.getTime()).sort(),
      );
    } finally {
      semanticModel = null;
    }
  }, 60_000);

  it('drops the passages a shortened page no longer has', async () => {
    semanticModel = TEST_EMBEDDING_MODEL;
    try {
      const documentId = await indexedPage('Wird kürzer', longBody);
      expect(await prisma.documentEmbedding.count({ where: { documentId } })).toBeGreaterThan(1);

      await prisma.documentContent.update({
        where: { documentId },
        data: { plainText: 'Nur noch ein Satz über Ablage.' },
      });
      await createIndexDocumentProcessor({ prisma, search })(
        contextFor<'search-indexing'>({
          correlationId: 'semantic',
          documentId,
          workspaceId,
          reason: 'materialized' as const,
        }).context,
      );

      const rows = await prisma.documentEmbedding.findMany({ where: { documentId } });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.blockId).toBeNull();
    } finally {
      semanticModel = null;
    }
  }, 60_000);

  it('answers with the passage that matched, not with the first lines of the page', async () => {
    semanticModel = TEST_EMBEDDING_MODEL;
    try {
      const documentId = await indexedPage('Rezeptsammlung', longBody);

      // `unauffindbarerbegriff` is in no document and the full-text half ANDs
      // its tokens, so whatever comes back came back through the vector half.
      const hits = await search.search({
        workspaceId,
        query: 'Zwiebelkuchenrezept unauffindbarerbegriff',
        limit: 10,
        includeArchived: false,
      });

      const hit = hits.find((result) => result.documentId === documentId);
      expect(hit).toBeDefined();
      expect(hit?.snippet).toContain('Zwiebelkuchenrezept');
    } finally {
      semanticModel = null;
    }
  }, 60_000);

  it('finds a page by meaning that the full-text half does not match at all', async () => {
    semanticModel = TEST_EMBEDDING_MODEL;
    try {
      const documentId = await indexedPage(
        'Verabredungen',
        'Kalender Termine Erinnerungen Vorlauf Benachrichtigung.',
      );

      // `unauffindbarerbegriff` is in no document, and the full-text half ANDs
      // its tokens, so the keyword list for this query is empty.
      const query = {
        workspaceId,
        query: 'Kalender Termine unauffindbarerbegriff',
        limit: 10,
        includeArchived: false,
      };
      semanticModel = null;
      const keywordOnly = await search.search(query);
      expect(keywordOnly.map((result) => result.documentId)).not.toContain(documentId);

      semanticModel = TEST_EMBEDDING_MODEL;
      const hybrid = await search.search(query);
      expect(hybrid.map((result) => result.documentId)).toContain(documentId);
    } finally {
      semanticModel = null;
    }
  }, 60_000);

  it('answers from full-text alone when the embedding model fails', async () => {
    semanticModel = TEST_EMBEDDING_MODEL;
    try {
      const documentId = await indexedPage('Robustheit', 'Ein Absatz über Zwiebelkuchen.');
      const failing = new HybridSearchAdapter({
        prisma,
        keyword: new PostgresSearchAdapter(prisma),
        embeddings: {
          dimensions: 1536,
          maxInputChars: 24_000,
          embed: async () => {
            throw new Error('no credit');
          },
        },
        options: async () => ({ model: TEST_EMBEDDING_MODEL, weight: 0.5 }),
        logger,
      });

      const results = await failing.search({
        workspaceId,
        query: 'Zwiebelkuchen',
        limit: 10,
        includeArchived: false,
      });
      expect(results.map((result) => result.documentId)).toContain(documentId);
    } finally {
      semanticModel = null;
    }
  }, 60_000);

  it('fills in the pages that existed before the feature was switched on', async () => {
    semanticModel = null;
    const documentId = await indexedPage('Nachträglich', 'Ein Text von vorher.');
    expect(await prisma.documentEmbedding.count({ where: { documentId } })).toBe(0);

    semanticModel = TEST_EMBEDDING_MODEL;
    try {
      const processor = createMaintenanceProcessor({
        openRouterBaseUrl: OPENROUTER_TEST_BASE_URL,
        prisma,
        queues,
        storage: recordingStorage(),
        bus,
        search,
        settings: stubSettings({
          'search.semanticEnabled': true,
          'search.embeddingModelSlug': TEST_EMBEDDING_MODEL,
        }),
      });
      await processor(
        contextFor<'maintenance'>({
          correlationId: 'backfill',
          task: 'backfill-embeddings',
          workspaceId,
          documentId: null,
        }).context,
      );

      expect(await prisma.documentEmbedding.count({ where: { documentId } })).toBe(1);
    } finally {
      semanticModel = null;
    }
  }, 60_000);

  it('asks the model once for a whole batch, not once per page', async () => {
    semanticModel = null;
    const ids = [
      await indexedPage('Stapel eins', 'Erster Text im Stapel.'),
      await indexedPage('Stapel zwei', 'Zweiter Text im Stapel.'),
      await indexedPage('Stapel drei', 'Dritter Text im Stapel.'),
    ];

    let requests = 0;
    const counting = new HybridSearchAdapter({
      prisma,
      keyword: new PostgresSearchAdapter(prisma),
      embeddings: {
        dimensions: 1536,
        maxInputChars: 24_000,
        embed: async (input) => {
          requests += 1;
          return (
            await new MockEmbeddingProvider().embed({
              input: input.texts,
              model: input.model,
              correlationId: input.correlationId,
            })
          ).vectors;
        },
      },
      options: async () => ({ model: TEST_EMBEDDING_MODEL, weight: 0.5 }),
      logger,
    });

    const written = await counting.writeEmbeddings(
      ids.map((documentId) => ({
        documentId,
        workspaceId,
        title: 'Stapel',
        plainText: 'Text',
        archivedAt: null,
      })),
      TEST_EMBEDDING_MODEL,
    );

    expect(written).toBe(3);
    expect(requests).toBe(1);

    // And a second call with the same texts costs no request at all.
    await counting.writeEmbeddings(
      ids.map((documentId) => ({
        documentId,
        workspaceId,
        title: 'Stapel',
        plainText: 'Text',
        archivedAt: null,
      })),
      TEST_EMBEDDING_MODEL,
    );
    expect(requests).toBe(1);
  }, 60_000);

  it('does nothing at all while the semantic half is off', async () => {
    semanticModel = null;
    const documentId = await indexedPage('Bleibt leer', 'Noch ein Text von vorher.');
    const processor = createMaintenanceProcessor({
      openRouterBaseUrl: OPENROUTER_TEST_BASE_URL,
      prisma,
      queues,
      storage: recordingStorage(),
      bus,
      search,
      settings: stubSettings({ 'search.semanticEnabled': false }),
    });

    await processor(
      contextFor<'maintenance'>({
        correlationId: 'backfill',
        task: 'backfill-embeddings',
        workspaceId,
        documentId: null,
      }).context,
    );

    expect(await prisma.documentEmbedding.count({ where: { documentId } })).toBe(0);
  }, 60_000);
});

/**
 * Related pages (issue #33).
 *
 * Answers a different question to search: not "what matches this text" but
 * "what else is about this", asked of a page rather than of a query. It reads
 * the vectors search already wrote, which is why the interesting assertions
 * below are about what it does *not* do — it never asks the model, and it never
 * offers the page itself.
 */
describe('related documents', () => {
  async function embeddedPage(title: string, body: string): Promise<string> {
    const document = await prisma.document.create({
      data: {
        workspaceId,
        title,
        orderKey: generateOrderKey(null, null),
        createdById: userId,
        updatedById: userId,
        content: { create: { yjsState: Buffer.from([]), plainText: body } },
      },
    });
    await createIndexDocumentProcessor({ prisma, search })(
      contextFor<'search-indexing'>({
        correlationId: 'related',
        documentId: document.id,
        workspaceId,
        reason: 'materialized' as const,
      }).context,
    );
    return document.id;
  }

  it('finds the page about the same subject and never the page itself', async () => {
    semanticModel = TEST_EMBEDDING_MODEL;
    try {
      const subject = 'Segelboot Großsegel Fock Ruder Hafen';
      const source = await embeddedPage('Segeln', subject);
      const sibling = await embeddedPage('Törnbericht', `${subject} Wind Welle`);
      const stranger = await embeddedPage('Buchhaltung', 'Rechnung Umsatzsteuer Beleg Konto.');

      const result = await search.findRelated({
        documentId: source,
        workspaceId,
        limit: 10,
        minSimilarity: 0.2,
        includeArchived: false,
      });

      expect(result.state).toBe('ready');
      const found = result.hits.map((hit) => hit.documentId);
      expect(found).toContain(sibling);
      expect(found).not.toContain(source);
      // Ordered by closeness, so the page about the same thing outranks the
      // one that merely shares a language.
      if (found.includes(stranger)) {
        expect(found.indexOf(sibling)).toBeLessThan(found.indexOf(stranger));
      }
    } finally {
      semanticModel = null;
    }
  }, 60_000);

  it('costs no model call, because the vector is already stored', async () => {
    semanticModel = TEST_EMBEDDING_MODEL;
    try {
      const documentId = await embeddedPage('Ohne Anfrage', 'Ein Text mit einem fertigen Vektor.');

      let requests = 0;
      const counting = new HybridSearchAdapter({
        prisma,
        keyword: new PostgresSearchAdapter(prisma),
        embeddings: {
          dimensions: 1536,
          maxInputChars: 24_000,
          embed: async () => {
            requests += 1;
            throw new Error('findRelated must not ask the model');
          },
        },
        options: async () => ({ model: TEST_EMBEDDING_MODEL, weight: 0.5 }),
        logger,
      });

      const result = await counting.findRelated({
        documentId,
        workspaceId,
        limit: 5,
        minSimilarity: 0.2,
        includeArchived: false,
      });

      expect(result.state).toBe('ready');
      expect(requests).toBe(0);
    } finally {
      semanticModel = null;
    }
  }, 60_000);

  it('reports a page without a vector as pending, not as having no neighbours', async () => {
    semanticModel = null;
    const documentId = await embeddedPage('Nie erfasst', 'Dieser Text hat keinen Vektor.');

    semanticModel = TEST_EMBEDDING_MODEL;
    try {
      const result = await search.findRelated({
        documentId,
        workspaceId,
        limit: 5,
        minSimilarity: 0.2,
        includeArchived: false,
      });
      expect(result.state).toBe('pending');
      expect(result.hits).toEqual([]);
    } finally {
      semanticModel = null;
    }
  }, 60_000);

  it('reports the whole feature as disabled while semantic search is off', async () => {
    semanticModel = TEST_EMBEDDING_MODEL;
    let documentId: string;
    try {
      documentId = await embeddedPage('Abgeschaltet', 'Ein Text mit Vektor, aber ohne Schalter.');
    } finally {
      semanticModel = null;
    }

    const result = await search.findRelated({
      documentId,
      workspaceId,
      limit: 5,
      minSimilarity: 0.2,
      includeArchived: false,
    });
    expect(result.state).toBe('disabled');
    expect(result.hits).toEqual([]);
  }, 60_000);

  it('keeps a distant page out through the similarity floor', async () => {
    semanticModel = TEST_EMBEDDING_MODEL;
    try {
      const source = await embeddedPage('Zwiebelkuchen', 'Zwiebel Speck Hefeteig Federweißer.');
      await embeddedPage('Quantenfeldtheorie', 'Renormierung Eichfeld Propagator Vakuum.');

      const result = await search.findRelated({
        documentId: source,
        workspaceId,
        limit: 10,
        // Nothing in this workspace is this close to anything.
        minSimilarity: 0.999,
        includeArchived: false,
      });

      expect(result.state).toBe('ready');
      expect(result.hits).toEqual([]);
    } finally {
      semanticModel = null;
    }
  }, 60_000);
});

/**
 * Tidying the agents' memory area (issue #34).
 *
 * The two stages are the point: a note first goes into the trash and is only
 * destroyed a second retention period later, so nothing this sweep deletes was
 * ever unrecoverable. The workspace under test stands in for the memory
 * workspace; the project page it hangs the notes under must survive both.
 */
describe('memory retention', () => {
  async function memoryNote(input: {
    parentId: string;
    title: string;
    updatedAt: Date;
    archivedAt?: Date;
  }): Promise<string> {
    const note = await prisma.document.create({
      data: {
        workspaceId,
        parentId: input.parentId,
        title: input.title,
        orderKey: generateOrderKey(null, null),
        createdById: userId,
        updatedById: userId,
        ...(input.archivedAt === undefined ? {} : { archivedAt: input.archivedAt }),
      },
    });
    // `updatedAt` is maintained by Prisma, so the age a retention sweep reads
    // has to be written past it.
    await prisma.$executeRaw`
      UPDATE "document" SET "updatedAt" = ${input.updatedAt} WHERE "id" = ${note.id}
    `;
    return note.id;
  }

  async function projectPage(title: string): Promise<string> {
    const page = await prisma.document.create({
      data: {
        workspaceId,
        title,
        orderKey: generateOrderKey(null, null),
        createdById: userId,
        updatedById: userId,
      },
    });
    await prisma.$executeRaw`
      UPDATE "document" SET "updatedAt" = ${new Date('2020-01-01')} WHERE "id" = ${page.id}
    `;
    return page.id;
  }

  function pruner(overrides: Partial<Settings>) {
    return createMaintenanceProcessor({
      openRouterBaseUrl: OPENROUTER_TEST_BASE_URL,
      prisma,
      queues,
      storage: recordingStorage(),
      bus,
      search,
      // Scoped to this suite's workspace on purpose: `prune-memories` sweeps
      // every memory area on the deployment, and the real one is next door.
      settings: stubSettingsForWorkspace(workspaceId, overrides),
    });
  }

  const job = contextFor<'maintenance'>({
    correlationId: 'prune-memories',
    task: 'prune-memories',
    workspaceId: null,
    documentId: null,
  });

  it('leaves everything alone while no retention is configured', async () => {
    const parentId = await projectPage('Projekt A');
    const noteId = await memoryNote({
      parentId,
      title: 'Uralte Notiz',
      updatedAt: new Date('2020-01-01'),
    });

    await pruner({ 'memory.retentionDays': 0 })(job.context);

    const note = await prisma.document.findUniqueOrThrow({ where: { id: noteId } });
    expect(note.archivedAt).toBeNull();
  }, 60_000);

  it('moves an expired note into the trash and tells the search index', async () => {
    const parentId = await projectPage('Projekt B');
    const oldId = await memoryNote({
      parentId,
      title: 'Alte Notiz',
      updatedAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000),
    });
    const freshId = await memoryNote({ parentId, title: 'Frische Notiz', updatedAt: new Date() });

    await pruner({ 'memory.retentionDays': 30 })(job.context);

    expect(
      (await prisma.document.findUniqueOrThrow({ where: { id: oldId } })).archivedAt,
    ).not.toBeNull();
    expect(
      (await prisma.document.findUniqueOrThrow({ where: { id: freshId } })).archivedAt,
    ).toBeNull();
    expect(
      (await prisma.document.findUniqueOrThrow({ where: { id: parentId } })).archivedAt,
    ).toBeNull();

    const events = await prisma.outboxEvent.findMany({
      where: { workspaceId, type: 'document.archived' },
    });
    expect(events.map((event) => (event.payload as { documentId: string }).documentId)).toContain(
      oldId,
    );
  }, 60_000);

  it('destroys a note only after it has been in the trash for a second period', async () => {
    const parentId = await projectPage('Projekt C');
    const longGoneId = await memoryNote({
      parentId,
      title: 'Längst weg',
      updatedAt: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000),
      archivedAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000),
    });
    const recentlyTrashedId = await memoryNote({
      parentId,
      title: 'Gerade erst weggeräumt',
      updatedAt: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000),
      archivedAt: new Date(),
    });

    await pruner({ 'memory.retentionDays': 30 })(job.context);

    expect(await prisma.document.count({ where: { id: longGoneId } })).toBe(0);
    expect(await prisma.document.count({ where: { id: recentlyTrashedId } })).toBe(1);
    expect(await prisma.document.count({ where: { id: parentId } })).toBe(1);
  }, 60_000);

  it('never touches a workspace that is not the memory one', async () => {
    const other = await prisma.workspace.create({
      data: {
        name: `Fremd ${Date.now().toString(36)}`,
        slug: `fremd-${Date.now().toString(36)}`,
        members: { create: { userId, role: 'OWNER' } },
      },
    });
    const foreignNote = await prisma.document.create({
      data: {
        workspaceId: other.id,
        parentId: null,
        title: 'Fremde Seite',
        orderKey: generateOrderKey(null, null),
        createdById: userId,
        updatedById: userId,
      },
    });
    const child = await prisma.document.create({
      data: {
        workspaceId: other.id,
        parentId: foreignNote.id,
        title: 'Fremde Unterseite',
        orderKey: generateOrderKey(null, null),
        createdById: userId,
        updatedById: userId,
      },
    });
    await prisma.$executeRaw`
      UPDATE "document" SET "updatedAt" = ${new Date('2020-01-01')} WHERE "id" = ${child.id}
    `;

    try {
      await pruner({ 'memory.retentionDays': 30 })(job.context);
      const untouched = await prisma.document.findUniqueOrThrow({ where: { id: child.id } });
      expect(untouched.archivedAt).toBeNull();
    } finally {
      await prisma.workspace.delete({ where: { id: other.id } });
    }
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

/**
 * Empties the outbox before a test that wants to watch its own rows go through.
 *
 * The dispatcher reads `processedAt: null` across every workspace, oldest
 * first, and stops at `outboxBatchSize` (100). Against the deployment database
 * that was invisible, because the live worker sweeps every five seconds and
 * there is never a backlog. Against the isolated stack of issue #94 the
 * database starts empty and nothing drains it, so the rows every other suite
 * writes queue up ahead of this one's and a single run never reaches them.
 *
 * Draining first is also the more honest precondition: what these tests are
 * about is what happens to a row once the dispatcher gets to it, not whether it
 * gets to it within one batch.
 */
async function drainOutboxBacklog(): Promise<void> {
  const processor = createMaintenanceProcessor({
    openRouterBaseUrl: OPENROUTER_TEST_BASE_URL,
    search,
    prisma,
    queues,
    storage: recordingStorage(),
    bus,
    settings: stubSettings(),
  });
  // Each pass clears up to a batch, so the bound is a backlog of 5000 rows --
  // far beyond what the other suites write while this one runs, and finite so a
  // dispatcher that stops making progress fails the test rather than hanging.
  for (let pass = 0; pass < 50; pass += 1) {
    if ((await prisma.outboxEvent.count({ where: { processedAt: null } })) === 0) return;
    await processor(
      contextFor<'maintenance'>({
        correlationId: 'test-outbox-drain',
        task: 'dispatch-outbox',
        workspaceId: null,
        documentId: null,
      }).context,
    );
  }
  throw new Error('The outbox backlog did not drain: the dispatcher stopped making progress.');
}

describe('maintenance', () => {
  it('dispatches outbox events exactly once', async () => {
    await drainOutboxBacklog();
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
      openRouterBaseUrl: OPENROUTER_TEST_BASE_URL,
      search,
      prisma,
      queues,
      storage: recordingStorage(),
      bus,
      settings: stubSettings(),
    });
    await processor(
      contextFor<'maintenance'>({
        correlationId: 'test-outbox',
        task: 'dispatch-outbox',
        workspaceId: null,
        documentId: null,
      }).context,
    );

    const remaining = await prisma.outboxEvent.count({
      where: { workspaceId, processedAt: null },
    });
    expect(remaining).toBe(0);

    // A second run has nothing left to do.
    await processor(
      contextFor<'maintenance'>({
        correlationId: 'test-outbox',
        task: 'dispatch-outbox',
        workspaceId: null,
        documentId: null,
      }).context,
    );
    const processed = await prisma.outboxEvent.findFirstOrThrow({
      where: { workspaceId, correlationId: 'test-outbox' },
    });
    expect(processed.attempts).toBe(1);
  }, 60_000);

  it('keeps dispatching when an outbox row is deleted mid-run', async () => {
    // The dispatcher reads its batch once and works through it afterwards, and
    // it reads across every workspace. A workspace deleted in that window takes
    // its outbox rows along, so the row this iteration holds can be gone by the
    // time it is marked. That surfaced as a flaky "no record was found for an
    // update" whenever the API suite deleted its fixtures in parallel. What
    // matters is not the vanished row, it is that the rows behind it are still
    // dispatched.
    await drainOutboxBacklog();
    const documentId = await createDocument();
    const [doomed, survivor] = await Promise.all([
      prisma.outboxEvent.create({
        data: {
          workspaceId,
          type: 'document.updated',
          payload: { documentId },
          correlationId: 'test-outbox-vanish',
        },
      }),
      prisma.outboxEvent.create({
        data: {
          workspaceId,
          type: 'document.updated',
          payload: { documentId },
          correlationId: 'test-outbox-survivor',
        },
      }),
    ]);

    const processor = createMaintenanceProcessor({
      openRouterBaseUrl: OPENROUTER_TEST_BASE_URL,
      search,
      prisma,
      queues,
      storage: recordingStorage(),
      bus,
      settings: stubSettings(),
    });

    const realUpdate = prisma.outboxEvent.update.bind(prisma.outboxEvent);
    // Prisma's `update` does not return a promise but a fluent client: the
    // relations hang off the returned value as further methods. The dispatcher
    // only ever awaits it, so the stub returns the promise alone, and the cast
    // is the note that the fluent half is deliberately not modelled here.
    const spy = vi.spyOn(prisma.outboxEvent, 'update').mockImplementation((async (
      args: Parameters<typeof realUpdate>[0],
    ) => {
      await prisma.outboxEvent.deleteMany({ where: { id: doomed.id } });
      return realUpdate(args);
    }) as unknown as typeof prisma.outboxEvent.update);

    try {
      await expect(
        processor(
          contextFor<'maintenance'>({
            documentId: null,
            correlationId: 'test-outbox-vanish',
            task: 'dispatch-outbox',
            workspaceId: null,
          }).context,
        ),
      ).resolves.toBeUndefined();
    } finally {
      spy.mockRestore();
    }

    const survivorRow = await prisma.outboxEvent.findUnique({ where: { id: survivor.id } });
    expect(survivorRow?.processedAt).not.toBeNull();
  }, 60_000);

  /**
   * Issue #10: months of usage history are only affordable if the two fat
   * columns go. What has to survive the sweep is the row itself, because the
   * usage view still counts it.
   */
  it('empties the texts of old AI runs and keeps their figures', async () => {
    const [old, recent, unfinished] = await Promise.all([
      prisma.aiRun.create({
        data: {
          workspaceId,
          createdById: userId,
          provider: 'mock',
          model: 'mock/a',
          messages: [{ role: 'user', content: 'alte Frage' }],
          resultText: 'alte Antwort',
          status: 'COMPLETED',
          createdAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000),
          inputTokens: 120,
          providerCostMicroUsd: 900,
        },
      }),
      prisma.aiRun.create({
        data: {
          workspaceId,
          createdById: userId,
          provider: 'mock',
          model: 'mock/a',
          messages: [{ role: 'user', content: 'neue Frage' }],
          resultText: 'neue Antwort',
          status: 'COMPLETED',
        },
      }),
      // Old, but never finished: its prompt is still the thing a worker would
      // have to execute, so the sweep has no business emptying it.
      prisma.aiRun.create({
        data: {
          workspaceId,
          createdById: userId,
          provider: 'mock',
          model: 'mock/a',
          messages: [{ role: 'user', content: 'hängende Frage' }],
          status: 'PENDING',
          createdAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000),
        },
      }),
    ]);

    const processor = createMaintenanceProcessor({
      openRouterBaseUrl: OPENROUTER_TEST_BASE_URL,
      search,
      prisma,
      queues,
      storage: recordingStorage(),
      bus,
      settings: stubSettings({ 'ai.runPayloadRetentionDays': 30 }),
    });
    await processor(
      contextFor<'maintenance'>({
        documentId: null,
        correlationId: 'test-prune-ai-payloads',
        task: 'prune-ai-run-payloads',
        workspaceId: null,
      }).context,
    );

    const prunedRow = await prisma.aiRun.findUniqueOrThrow({ where: { id: old.id } });
    expect(prunedRow.resultText).toBeNull();
    expect(prunedRow.messages).toEqual([]);
    expect(prunedRow.payloadsPrunedAt).not.toBeNull();
    // The figures the usage view groups over are untouched.
    expect(prunedRow.inputTokens).toBe(120);
    expect(prunedRow.providerCostMicroUsd).toBe(900);

    const recentRow = await prisma.aiRun.findUniqueOrThrow({ where: { id: recent.id } });
    expect(recentRow.resultText).toBe('neue Antwort');
    const unfinishedRow = await prisma.aiRun.findUniqueOrThrow({ where: { id: unfinished.id } });
    expect(unfinishedRow.messages).toEqual([{ role: 'user', content: 'hängende Frage' }]);
  }, 60_000);

  it('leaves every AI run alone while the retention is zero', async () => {
    const run = await prisma.aiRun.create({
      data: {
        workspaceId,
        createdById: userId,
        provider: 'mock',
        model: 'mock/a',
        messages: [{ role: 'user', content: 'bleibt stehen' }],
        resultText: 'bleibt auch stehen',
        status: 'COMPLETED',
        createdAt: new Date(Date.now() - 400 * 24 * 60 * 60 * 1000),
      },
    });

    const processor = createMaintenanceProcessor({
      openRouterBaseUrl: OPENROUTER_TEST_BASE_URL,
      search,
      prisma,
      queues,
      storage: recordingStorage(),
      bus,
      settings: stubSettings(),
    });
    await processor(
      contextFor<'maintenance'>({
        documentId: null,
        correlationId: 'test-prune-ai-payloads-off',
        task: 'prune-ai-run-payloads',
        workspaceId: null,
      }).context,
    );

    const row = await prisma.aiRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(row.resultText).toBe('bleibt auch stehen');
    expect(row.payloadsPrunedAt).toBeNull();
  }, 60_000);

  describe('prune-snapshots (tiered retention, issue #20)', () => {
    const state = markdownToYjsState('# Snapshot\n').yjsState;

    /**
     * UTC noon on the day `daysAgo` calendar days before today, offset by
     * `hourOffset` hours. Anchored to a calendar date rather than to
     * `Date.now() - N*DAY_MS`: two timestamps on the same UTC calendar date
     * always share the same epoch-day bucket (`dayBucket` in `maintenance.ts`
     * floors on the same UTC-midnight boundaries), so this stays correct no
     * matter what time of day the test happens to run at -- a raw ms offset
     * near a fractional day would risk crossing that boundary depending on
     * the clock.
     */
    function utcNoon(daysAgo: number, hourOffset = 0): Date {
      const now = new Date();
      return new Date(
        Date.UTC(
          now.getUTCFullYear(),
          now.getUTCMonth(),
          now.getUTCDate() - daysAgo,
          12 + hourOffset,
        ),
      );
    }

    async function snapshotAt(
      documentId: string,
      createdAt: Date,
      reason: 'API_WRITE' | 'MANUAL' = 'API_WRITE',
    ): Promise<string> {
      const row = await prisma.documentSnapshot.create({
        data: { documentId, yjsState: Buffer.from(state), createdById: userId, reason, createdAt },
      });
      return row.id;
    }

    const retentionSettings = (overrides: Partial<Settings> = {}) =>
      stubSettings({
        'activity.snapshotRetentionFullDays': 7,
        'activity.snapshotRetentionDailyDays': 30,
        'activity.snapshotRetentionDryRun': false,
        ...overrides,
      });

    it('deletes nothing when everything is inside the full-retention window (too little data to prune)', async () => {
      const documentId = await createDocument();
      await snapshotAt(documentId, utcNoon(0));
      await snapshotAt(documentId, utcNoon(3));
      await snapshotAt(documentId, utcNoon(6));

      const processor = createMaintenanceProcessor({
        openRouterBaseUrl: OPENROUTER_TEST_BASE_URL,
        search,
        prisma,
        queues,
        storage: recordingStorage(),
        bus,
        settings: retentionSettings(),
      });
      await processor(
        contextFor<'maintenance'>({
          correlationId: 'test-prune-1',
          task: 'prune-snapshots',
          workspaceId,
          documentId: null,
        }).context,
      );

      expect(await prisma.documentSnapshot.count({ where: { documentId } })).toBe(3);
    }, 60_000);

    it('thins to one snapshot per day beyond the full-retention window', async () => {
      const documentId = await createDocument();
      // Same UTC calendar day (10 days ago), three snapshots hours apart:
      // only the newest of the three should survive daily thinning.
      await snapshotAt(documentId, utcNoon(10, -2));
      await snapshotAt(documentId, utcNoon(10, 0));
      const newest = await snapshotAt(documentId, utcNoon(10, 2));
      // A different calendar day, alone in its own bucket: untouched.
      const differentDay = await snapshotAt(documentId, utcNoon(15));

      const processor = createMaintenanceProcessor({
        openRouterBaseUrl: OPENROUTER_TEST_BASE_URL,
        search,
        prisma,
        queues,
        storage: recordingStorage(),
        bus,
        settings: retentionSettings(),
      });
      await processor(
        contextFor<'maintenance'>({
          correlationId: 'test-prune-2',
          task: 'prune-snapshots',
          workspaceId,
          documentId: null,
        }).context,
      );

      const remaining = await prisma.documentSnapshot.findMany({
        where: { documentId },
        select: { id: true },
      });
      expect(remaining.map((row) => row.id).sort()).toEqual([differentDay, newest].sort());
    }, 60_000);

    it('never removes a MANUAL snapshot, however old', async () => {
      const documentId = await createDocument();
      const manual = await snapshotAt(documentId, utcNoon(400), 'MANUAL');
      const survivor = await snapshotAt(documentId, utcNoon(200));

      const processor = createMaintenanceProcessor({
        openRouterBaseUrl: OPENROUTER_TEST_BASE_URL,
        search,
        prisma,
        queues,
        storage: recordingStorage(),
        bus,
        settings: retentionSettings(),
      });
      await processor(
        contextFor<'maintenance'>({
          correlationId: 'test-prune-3',
          task: 'prune-snapshots',
          workspaceId,
          documentId: null,
        }).context,
      );

      const remainingIds = (
        await prisma.documentSnapshot.findMany({ where: { documentId }, select: { id: true } })
      ).map((row) => row.id);
      expect(remainingIds.sort()).toEqual([manual, survivor].sort());
    }, 60_000);

    it('dry run computes deletions but changes nothing in the database', async () => {
      const documentId = await createDocument();
      await snapshotAt(documentId, utcNoon(10, -1));
      await snapshotAt(documentId, utcNoon(10, 0));
      await snapshotAt(documentId, utcNoon(10, 1));

      const processor = createMaintenanceProcessor({
        openRouterBaseUrl: OPENROUTER_TEST_BASE_URL,
        search,
        prisma,
        queues,
        storage: recordingStorage(),
        bus,
        settings: retentionSettings({ 'activity.snapshotRetentionDryRun': true }),
      });
      await processor(
        contextFor<'maintenance'>({
          correlationId: 'test-prune-4',
          task: 'prune-snapshots',
          workspaceId,
          documentId: null,
        }).context,
      );

      expect(await prisma.documentSnapshot.count({ where: { documentId } })).toBe(3);
    }, 60_000);

    it('defaults to a dry run: the bare `stubSettings()` used elsewhere in this file never deletes', async () => {
      const documentId = await createDocument();
      await snapshotAt(documentId, utcNoon(400, -1));
      await snapshotAt(documentId, utcNoon(400, 1));

      const processor = createMaintenanceProcessor({
        openRouterBaseUrl: OPENROUTER_TEST_BASE_URL,
        search,
        prisma,
        queues,
        storage: recordingStorage(),
        bus,
        settings: stubSettings(),
      });
      await processor(
        contextFor<'maintenance'>({
          correlationId: 'test-prune-5',
          task: 'prune-snapshots',
          workspaceId,
          documentId: null,
        }).context,
      );

      expect(await prisma.documentSnapshot.count({ where: { documentId } })).toBe(2);
    }, 60_000);
  });

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
      openRouterBaseUrl: OPENROUTER_TEST_BASE_URL,
      search,
      prisma,
      queues,
      storage: recordingStorage(deleted),
      bus,
      settings: stubSettings(),
    });
    await processor(
      contextFor<'maintenance'>({
        correlationId: 'test-covers',
        task: 'collect-orphaned-covers',
        workspaceId,
        documentId: null,
      }).context,
    );

    expect(deleted).toEqual([`${keyPrefix}/alt.png`, `${keyPrefix}/alt.png.preview.webp`]);
    expect(
      (await prisma.attachment.findUniqueOrThrow({ where: { id: replaced.id } })).deletedAt,
    ).not.toBeNull();
    expect(
      (await prisma.attachment.findUniqueOrThrow({ where: { id: current.id } })).deletedAt,
    ).toBeNull();
    expect(
      (await prisma.attachment.findUniqueOrThrow({ where: { id: inBody.id } })).deletedAt,
    ).toBeNull();
  }, 60_000);

  it('reaps a RUNNING run whose heartbeat has gone stale, as ai_run_abandoned', async () => {
    const staleHeartbeat = new Date(Date.now() - 5 * 60_000);
    const runId = await createAiRunRow('RUNNING', {
      startedAt: staleHeartbeat,
      heartbeatAt: staleHeartbeat,
    });

    const published: { type: string; payload: Record<string, unknown> }[] = [];
    const processor = createMaintenanceProcessor({
      openRouterBaseUrl: OPENROUTER_TEST_BASE_URL,
      search,
      prisma,
      queues,
      storage: recordingStorage(),
      bus: recordingEventBus(published),
      settings: stubSettings(),
    });
    await processor(
      contextFor<'maintenance'>({
        correlationId: 'test-reap-1',
        task: 'reap-stale-ai-runs',
        workspaceId: null,
        documentId: null,
      }).context,
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
      openRouterBaseUrl: OPENROUTER_TEST_BASE_URL,
      search,
      prisma,
      queues,
      storage: recordingStorage(),
      bus: recordingEventBus(published),
      settings: stubSettings(),
    });
    await processor(
      contextFor<'maintenance'>({
        correlationId: 'test-reap-5',
        task: 'reap-stale-ai-runs',
        workspaceId: null,
        documentId: null,
      }).context,
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
      openRouterBaseUrl: OPENROUTER_TEST_BASE_URL,
      search,
      prisma,
      queues,
      storage: recordingStorage(),
      bus: recordingEventBus(published),
      settings: stubSettings(),
    });
    await processor(
      contextFor<'maintenance'>({
        correlationId: 'test-reap-2',
        task: 'reap-stale-ai-runs',
        workspaceId: null,
        documentId: null,
      }).context,
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
    const runningId = await createAiRunRow('RUNNING', {
      startedAt: new Date(),
      heartbeatAt: new Date(),
    });
    const pendingId = await createAiRunRow('PENDING');

    const published: { type: string; payload: Record<string, unknown> }[] = [];
    const processor = createMaintenanceProcessor({
      openRouterBaseUrl: OPENROUTER_TEST_BASE_URL,
      search,
      prisma,
      queues,
      storage: recordingStorage(),
      bus: recordingEventBus(published),
      settings: stubSettings(),
    });
    await processor(
      contextFor<'maintenance'>({
        correlationId: 'test-reap-3',
        task: 'reap-stale-ai-runs',
        workspaceId: null,
        documentId: null,
      }).context,
    );

    const runningRow = await prisma.aiRun.findUniqueOrThrow({ where: { id: runningId } });
    const pendingRow = await prisma.aiRun.findUniqueOrThrow({ where: { id: pendingId } });
    expect(runningRow.status).toBe('RUNNING');
    expect(pendingRow.status).toBe('PENDING');
    expect(
      published.some(
        (event) => event.payload.runId === runningId || event.payload.runId === pendingId,
      ),
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
      openRouterBaseUrl: OPENROUTER_TEST_BASE_URL,
      search,
      prisma,
      queues,
      storage: recordingStorage(),
      bus: recordingEventBus(published),
      settings: stubSettings(),
    });
    await processor(
      contextFor<'maintenance'>({
        correlationId: 'test-reap-4',
        task: 'reap-stale-ai-runs',
        workspaceId: null,
        documentId: null,
      }).context,
    );

    const run = await prisma.aiRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.status).toBe('TIMED_OUT');
    expect(run.errorCode).toBe('ai_timeout');
  }, 30_000);

  /**
   * Every sweep in here is scoped to this suite's own workspace rather than
   * run across all of them, which is what the payload's `workspaceId: null`
   * would mean.
   *
   * The task reads the pages edited within the interval and stops at 200, in
   * no particular order. Against the deployment database that was invisible:
   * few pages are edited in any given quarter of an hour. Against the isolated
   * stack of issue #94 the other suites are creating pages in the same
   * database at the same time, all of them freshly "edited", and past 200 of
   * them this suite's page simply is not in the batch -- which made the
   * positive cases flaky and, worse, would have let the negative ones pass for
   * the wrong reason.
   *
   * The fan-out across workspaces is not what these tests are about. The two
   * guards are: nothing changed since the last checkpoint, and the last
   * checkpoint is too recent.
   */
  describe('snapshot-active-documents (issue #20, editing-session snapshots)', () => {
    it('is a no-op while the setting is off, the default', async () => {
      const documentId = await createDocument();
      await prisma.documentContent.update({
        where: { documentId },
        data: { yjsUpdatedAt: new Date() },
      });

      const processor = createMaintenanceProcessor({
        openRouterBaseUrl: OPENROUTER_TEST_BASE_URL,
        search,
        prisma,
        queues,
        storage: recordingStorage(),
        bus,
        settings: stubSettings(),
      });
      await processor(
        contextFor<'maintenance'>({
          documentId: null,
          correlationId: 'test-snap-active-1',
          task: 'snapshot-active-documents',
          workspaceId,
        }).context,
      );

      expect(
        await prisma.documentSnapshot.count({ where: { documentId, reason: 'SCHEDULED' } }),
      ).toBe(0);
    }, 30_000);

    it('takes a SCHEDULED snapshot of a page that changed within the interval, attributed to its current editor', async () => {
      const documentId = await createDocument();
      await prisma.documentContent.update({
        where: { documentId },
        data: { yjsUpdatedAt: new Date() },
      });

      const processor = createMaintenanceProcessor({
        openRouterBaseUrl: OPENROUTER_TEST_BASE_URL,
        search,
        prisma,
        queues,
        storage: recordingStorage(),
        bus,
        settings: stubSettings({
          'activity.editSessionSnapshotsEnabled': true,
          'activity.editSessionSnapshotIntervalMinutes': 15,
        }),
      });
      await processor(
        contextFor<'maintenance'>({
          documentId: null,
          correlationId: 'test-snap-active-2',
          task: 'snapshot-active-documents',
          workspaceId,
        }).context,
      );

      const snapshot = await prisma.documentSnapshot.findFirst({
        where: { documentId, reason: 'SCHEDULED' },
      });
      expect(snapshot).not.toBeNull();
      expect(snapshot?.createdById).toBe(userId);
    }, 30_000);

    it('skips a page that has not changed since its last snapshot', async () => {
      const documentId = await createDocument();
      const yjsUpdatedAt = new Date();
      await prisma.documentContent.update({ where: { documentId }, data: { yjsUpdatedAt } });
      // Already checkpointed at least as recently as the content: nothing new
      // to capture.
      await prisma.documentSnapshot.create({
        data: {
          documentId,
          yjsState: Buffer.from(markdownToYjsState('# Snapshot\n').yjsState),
          createdById: userId,
          reason: 'SCHEDULED',
          createdAt: new Date(yjsUpdatedAt.getTime() + 1_000),
        },
      });

      const processor = createMaintenanceProcessor({
        openRouterBaseUrl: OPENROUTER_TEST_BASE_URL,
        search,
        prisma,
        queues,
        storage: recordingStorage(),
        bus,
        settings: stubSettings({
          'activity.editSessionSnapshotsEnabled': true,
          'activity.editSessionSnapshotIntervalMinutes': 15,
        }),
      });
      await processor(
        contextFor<'maintenance'>({
          documentId: null,
          correlationId: 'test-snap-active-3',
          task: 'snapshot-active-documents',
          workspaceId,
        }).context,
      );

      expect(
        await prisma.documentSnapshot.count({ where: { documentId, reason: 'SCHEDULED' } }),
      ).toBe(1);
    }, 30_000);

    it('skips a page whose last snapshot is more recent than the configured interval, even with newer content', async () => {
      const documentId = await createDocument();
      const yjsUpdatedAt = new Date();
      await prisma.documentContent.update({ where: { documentId }, data: { yjsUpdatedAt } });
      // A checkpoint from a moment ago, well inside the (long) configured
      // interval, but strictly older than the content: the "changed since
      // last checkpoint" guard alone must not be enough to fire again yet.
      await prisma.documentSnapshot.create({
        data: {
          documentId,
          yjsState: Buffer.from(markdownToYjsState('# Snapshot\n').yjsState),
          createdById: userId,
          reason: 'SCHEDULED',
          createdAt: new Date(yjsUpdatedAt.getTime() - 1_000),
        },
      });

      const processor = createMaintenanceProcessor({
        openRouterBaseUrl: OPENROUTER_TEST_BASE_URL,
        search,
        prisma,
        queues,
        storage: recordingStorage(),
        bus,
        settings: stubSettings({
          'activity.editSessionSnapshotsEnabled': true,
          'activity.editSessionSnapshotIntervalMinutes': 1_440,
        }),
      });
      await processor(
        contextFor<'maintenance'>({
          documentId: null,
          correlationId: 'test-snap-active-4',
          task: 'snapshot-active-documents',
          workspaceId,
        }).context,
      );

      expect(
        await prisma.documentSnapshot.count({ where: { documentId, reason: 'SCHEDULED' } }),
      ).toBe(1);
    }, 30_000);

    it('keeps sweeping when a candidate page is deleted mid-run', async () => {
      // The sweep reads its candidates once and works through them afterwards,
      // so a page can be deleted in between -- and a page being deleted is
      // exactly a page someone was just editing, which is what put it on the
      // list. This showed up as a flaky foreign key violation whenever the API
      // suite ran against the same database at the same time. The point is not
      // that the doomed page is skipped, it is that the pages behind it in the
      // list still get their checkpoint.
      const doomedId = await createDocument();
      const survivorId = await createDocument();
      const recent = new Date(Date.now() - 60_000);
      await prisma.documentContent.updateMany({
        where: { documentId: { in: [doomedId, survivorId] } },
        data: { yjsUpdatedAt: recent },
      });

      const processor = createMaintenanceProcessor({
        openRouterBaseUrl: OPENROUTER_TEST_BASE_URL,
        search,
        prisma,
        queues,
        storage: recordingStorage(),
        bus,
        settings: stubSettings({
          'activity.editSessionSnapshotsEnabled': true,
          'activity.editSessionSnapshotIntervalMinutes': 15,
        }),
      });

      const realCreate = prisma.documentSnapshot.create.bind(prisma.documentSnapshot);
      let deleted = false;
      // Same as the outbox stub above: `create` returns a fluent client, the
      // sweep only awaits it, and the cast says so out loud.
      const spy = vi.spyOn(prisma.documentSnapshot, 'create').mockImplementation((async (
        args: Parameters<typeof realCreate>[0],
      ) => {
        if (!deleted) {
          deleted = true;
          await prisma.document.delete({ where: { id: doomedId } });
        }
        return realCreate(args);
      }) as unknown as typeof prisma.documentSnapshot.create);

      try {
        await processor(
          contextFor<'maintenance'>({
            documentId: null,
            correlationId: 'test-snap-active-6',
            task: 'snapshot-active-documents',
            workspaceId,
          }).context,
        );
      } finally {
        spy.mockRestore();
      }

      expect(
        await prisma.documentSnapshot.count({
          where: { documentId: survivorId, reason: 'SCHEDULED' },
        }),
      ).toBe(1);
    }, 30_000);

    it('leaves a page alone whose content has not changed recently at all', async () => {
      const documentId = await createDocument();
      await prisma.documentContent.update({
        where: { documentId },
        // Older than any reasonable interval: not "active" at all.
        data: { yjsUpdatedAt: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      });

      const processor = createMaintenanceProcessor({
        openRouterBaseUrl: OPENROUTER_TEST_BASE_URL,
        search,
        prisma,
        queues,
        storage: recordingStorage(),
        bus,
        settings: stubSettings({
          'activity.editSessionSnapshotsEnabled': true,
          'activity.editSessionSnapshotIntervalMinutes': 15,
        }),
      });
      await processor(
        contextFor<'maintenance'>({
          documentId: null,
          correlationId: 'test-snap-active-5',
          task: 'snapshot-active-documents',
          workspaceId,
        }).context,
      );

      expect(
        await prisma.documentSnapshot.count({ where: { documentId, reason: 'SCHEDULED' } }),
      ).toBe(0);
    }, 30_000);
  });
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
          overviewMode: 'off',
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
    })(contextFor<'document-cover'>(payload).context);

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
    })(contextFor<'document-cover'>(payload).context);

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
    })(contextFor<'document-cover'>(payload).context);

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
    })(contextFor<'document-cover'>(payload).context);

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
    reasoningControl: false,
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
    // A real provider reports its usage on the stream, and the run's usage
    // columns are filled from it (issue #10). Without this event the streamed
    // path would silently record no usage at all.
    yield {
      type: 'usage',
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
    yield { type: 'done', text: 'ok', finishReason: 'stop' };
  }
}

interface ScriptedTurn {
  text: string;
  finishReason: AiGenerateResult['finishReason'];
  toolCalls?: readonly AiToolCall[];
  /** Reasoning fragments emitted before the answer, as a thinking model does. */
  reasoningChunks?: number;
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
    reasoningControl: false,
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
    for (let index = 0; index < (turn.reasoningChunks ?? 0); index += 1) {
      yield { type: 'reasoning', charCount: 40 };
    }
    if (turn.text.length > 0) yield { type: 'delta', text: turn.text, sequence: 1 };
    if (turn.toolCalls !== undefined) yield { type: 'tool_calls', toolCalls: turn.toolCalls };
    yield { type: 'done', text: turn.text, finishReason: turn.finishReason };
  }
}

/**
 * Streams one delta, then keeps the turn open long enough for the run's
 * heartbeat to fire at least once. That is what lets a test observe the
 * partial answer the heartbeat persists (issue #6, point 6).
 */
class SlowStreamingAiProvider implements AiProvider {
  public readonly id = 'slow-test-provider';
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
    reasoningControl: false,
  };

  constructor(private readonly pauseMs: number) {}

  async generate(): Promise<AiGenerateResult> {
    throw new Error('The slow provider is only used for streaming');
  }

  async *stream(request: AiGenerateRequest): AsyncIterable<AiStreamEvent> {
    yield { type: 'start', model: request.model ?? 'test-model', provider: this.id };
    yield { type: 'delta', text: 'Teil eins', sequence: 1 };
    await new Promise<void>((resolve) => setTimeout(resolve, this.pauseMs));
    yield { type: 'delta', text: ' und Teil zwei', sequence: 2 };
    yield { type: 'done', text: 'Teil eins und Teil zwei', finishReason: 'stop' };
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
    reasoningControl: false,
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
      search: { hybrid: search, keyword: keywordSearch },
      prisma,
      providerFor: providerFor(provider),
      bus,
      storage: fakeStorage(Buffer.from('fake-image-bytes')),
      settings: stubSettings(),
      toolRunnerFactory: null,
      visionPreprocessorFor: () => fakeVisionPreprocessor('Eine Katze mit Hut.'),
      queues,
      modelRegistry: async () => null,
    });
    await processor(
      contextFor<'ai'>({ correlationId: 'test-ai-1', runId, workspaceId, userId }).context,
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

  /**
   * Issue #10: the usage view groups over columns, not over the JSON, and the
   * cost column it groups over has to distinguish a price a provider named from
   * one this deployment worked out itself.
   *
   * `CapturingAiProvider` reports one token in, one token out and no cost, so
   * the estimate is the registry's price for two tokens: 3 + 15 micro-USD per
   * million, times one token each, rounded.
   */
  it('writes the usage columns and estimates the cost the provider did not name', async () => {
    const documentId = await createDocument();
    const runId = await createRun(documentId);
    const provider = new CapturingAiProvider();

    const processor = createAiRunProcessor({
      search: { hybrid: search, keyword: keywordSearch },
      prisma,
      providerFor: providerFor(provider),
      bus,
      storage: fakeStorage(Buffer.from('unused')),
      settings: stubSettings(),
      toolRunnerFactory: null,
      visionPreprocessorFor: () => null,
      queues,
      modelRegistry: async () => toolCapableModelRow('priced-model'),
    });
    await processor(
      contextFor<'ai'>({ correlationId: 'test-ai-1', runId, workspaceId, userId }).context,
    );

    const run = await prisma.aiRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.status).toBe('COMPLETED');
    expect(run.inputTokens).toBe(1);
    expect(run.outputTokens).toBe(1);
    expect(run.cachedInputTokens).toBe(0);
    // Nothing reported, so the reported column stays empty rather than zero:
    // a zero here would count the run as free in every cost total.
    expect(run.providerCostMicroUsd).toBeNull();
    expect(run.estimatedCostMicroUsd).toBe(18);
    expect(run.payloadsPrunedAt).toBeNull();
  }, 60_000);

  it('does not inject a system message when the page has no images', async () => {
    const documentId = await createDocument();
    const runId = await createRun(documentId);
    const provider = new CapturingAiProvider();

    const processor = createAiRunProcessor({
      search: { hybrid: search, keyword: keywordSearch },
      prisma,
      providerFor: providerFor(provider),
      bus,
      storage: fakeStorage(Buffer.from('unused')),
      settings: stubSettings(),
      toolRunnerFactory: null,
      visionPreprocessorFor: () => fakeVisionPreprocessor('unused'),
      queues,
      modelRegistry: async () => null,
    });
    await processor(
      contextFor<'ai'>({ correlationId: 'test-ai-2', runId, workspaceId, userId }).context,
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
      search: { hybrid: search, keyword: keywordSearch },
      prisma,
      providerFor: providerFor(provider),
      bus,
      storage: fakeStorage(Buffer.from('unused')),
      settings: stubSettings(),
      toolRunnerFactory: null,
      visionPreprocessorFor: () => fakeVisionPreprocessor('unused'),
      queues,
      modelRegistry: async () => null,
    });
    await processor(
      contextFor<'ai'>({ correlationId: 'test-ai-3', runId, workspaceId, userId }).context,
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
      search: { hybrid: search, keyword: keywordSearch },
      prisma,
      providerFor: providerFor(provider),
      bus,
      storage: fakeStorage(Buffer.from('unused')),
      settings: stubSettings({ 'ai.maxOutputTokens': 12_288 }),
      toolRunnerFactory: null,
      visionPreprocessorFor: () => null,
      queues,
      modelRegistry: async () => null,
    });
    await processor(
      contextFor<'ai'>({ correlationId: 'test-ai-limit-1', runId, workspaceId, userId }).context,
    );

    expect(provider.lastRequest?.maxOutputTokens).toBe(12_288);
  }, 60_000);

  it("caps the output limit at the model's own maximum", async () => {
    const documentId = await createDocument();
    const runId = await createRun(documentId);
    const provider = new CapturingAiProvider();

    const processor = createAiRunProcessor({
      search: { hybrid: search, keyword: keywordSearch },
      prisma,
      providerFor: providerFor(provider),
      bus,
      storage: fakeStorage(Buffer.from('unused')),
      settings: stubSettings({ 'ai.maxOutputTokens': 100_000 }),
      toolRunnerFactory: null,
      visionPreprocessorFor: () => null,
      queues,
      modelRegistry: async () => ({ ...toolCapableModelRow('test-model'), maxOutputTokens: 8_000 }),
    });
    await processor(
      contextFor<'ai'>({ correlationId: 'test-ai-limit-2', runId, workspaceId, userId }).context,
    );

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
      search: { hybrid: search, keyword: keywordSearch },
      prisma,
      providerFor: providerFor(provider),
      bus,
      storage: fakeStorage(Buffer.from('unused')),
      settings: stubSettings(),
      toolRunnerFactory: null,
      visionPreprocessorFor: () => null,
      queues,
      modelRegistry: async () => null,
    });
    await processor(
      contextFor<'ai'>({ correlationId: 'test-ai-truncation-1', runId, workspaceId, userId })
        .context,
    );

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
          {
            id: 'call-1',
            name: 'exo_page_write',
            argumentsJson: '{"documentId":"abc","markdown":"# Gami',
          },
        ],
      },
    ]);

    const processor = createAiRunProcessor({
      search: { hybrid: search, keyword: keywordSearch },
      prisma,
      providerFor: providerFor(provider),
      bus,
      storage: fakeStorage(Buffer.from('unused')),
      settings: stubSettings(),
      toolRunnerFactory: null,
      visionPreprocessorFor: () => null,
      queues,
      modelRegistry: async () => null,
    });
    await processor(
      contextFor<'ai'>({ correlationId: 'test-ai-truncation-2', runId, workspaceId, userId })
        .context,
    );

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
      {
        text: '',
        finishReason: 'tool_calls',
        toolCalls: [{ id: '', name: '', argumentsJson: '{}' }],
      },
    ]);

    const processor = createAiRunProcessor({
      search: { hybrid: search, keyword: keywordSearch },
      prisma,
      providerFor: providerFor(provider),
      bus,
      storage: fakeStorage(Buffer.from('unused')),
      settings: stubSettings(),
      toolRunnerFactory: null,
      visionPreprocessorFor: () => null,
      queues,
      modelRegistry: async () => null,
    });
    await processor(
      contextFor<'ai'>({ correlationId: 'test-ai-tool-call-1', runId, workspaceId, userId })
        .context,
    );

    const run = await prisma.aiRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.status).toBe('FAILED');
    expect(run.errorCode).toBe('ai_tool_call_invalid');
  }, 60_000);

  it('names the thinking phase instead of letting it look like a stall (issue #6)', async () => {
    const documentId = await createDocument();
    const runId = await createRun(documentId);
    const published: { type: string; payload: Record<string, unknown> }[] = [];
    const provider = new ScriptedAiProvider([
      { text: 'Fertig.', finishReason: 'stop', reasoningChunks: 5 },
    ]);

    const processor = createAiRunProcessor({
      search: { hybrid: search, keyword: keywordSearch },
      prisma,
      providerFor: providerFor(provider),
      bus: recordingEventBus(published),
      storage: fakeStorage(Buffer.from('unused')),
      settings: stubSettings(),
      toolRunnerFactory: null,
      visionPreprocessorFor: () => null,
      queues,
      modelRegistry: async () => null,
    });
    await processor(
      contextFor<'ai'>({ correlationId: 'test-ai-phase-1', runId, workspaceId, userId }).context,
    );

    const phases = published.filter((event) => event.type === 'ai.run.phase');
    expect(phases.map((event) => event.payload.phase)).toContain('reasoning');
    expect(phases.map((event) => event.payload.phase)).toContain('generating');
    // Five fragments, one announcement: the throttle keeps a life sign from
    // turning into a flood.
    expect(phases.filter((event) => event.payload.phase === 'reasoning')).toHaveLength(1);
    // The thinking itself must never ride along on the bus.
    for (const event of phases) {
      expect(Object.keys(event.payload).sort()).toEqual(['phase', 'runId']);
    }
  }, 60_000);

  it('keeps the partial answer on the run while it streams, so a client can reload it', async () => {
    // Issue #6, point 6: a gap in ai.run.progress means the text stitched
    // together from deltas is wrong, and the client needs something
    // authoritative to fall back on. The heartbeat is what puts it there.
    const documentId = await createDocument();
    const runId = await createRun(documentId);

    const processor = createAiRunProcessor({
      search: { hybrid: search, keyword: keywordSearch },
      prisma,
      providerFor: providerFor(new SlowStreamingAiProvider(7_000)),
      bus,
      storage: fakeStorage(Buffer.from('unused')),
      settings: stubSettings(),
      toolRunnerFactory: null,
      visionPreprocessorFor: () => null,
      queues,
      modelRegistry: async () => null,
    });
    const finished = processor(
      contextFor<'ai'>({ correlationId: 'test-ai-partial-1', runId, workspaceId, userId }).context,
    );

    await new Promise<void>((resolve) => setTimeout(resolve, 6_000));
    const midRun = await prisma.aiRun.findUniqueOrThrow({ where: { id: runId } });
    expect(midRun.status).toBe('RUNNING');
    expect(midRun.resultText).toBe('Teil eins');

    await finished;
    const run = await prisma.aiRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.status).toBe('COMPLETED');
    expect(run.resultText).toBe('Teil eins und Teil zwei');
  }, 60_000);

  it('marks the run TIMED_OUT with ai_timeout once its own time budget elapses', async () => {
    const documentId = await createDocument();
    const runId = await createRun(documentId);
    const published: { type: string; payload: Record<string, unknown> }[] = [];

    const processor = createAiRunProcessor({
      search: { hybrid: search, keyword: keywordSearch },
      prisma,
      providerFor: providerFor(new HangingAiProvider()),
      bus: recordingEventBus(published),
      storage: fakeStorage(Buffer.from('unused')),
      settings: stubSettingsUnchecked({ 'ai.timeoutMs': 150, 'ai.maxRunMs': 150 }),
      toolRunnerFactory: null,
      visionPreprocessorFor: () => null,
      queues,
      modelRegistry: async () => null,
    });
    await processor(
      contextFor<'ai'>({ correlationId: 'test-ai-timeout-1', runId, workspaceId, userId }).context,
    );

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
      search: { hybrid: search, keyword: keywordSearch },
      prisma,
      providerFor: providerFor(new HangingAiProvider()),
      bus: recordingEventBus(published),
      storage: fakeStorage(Buffer.from('unused')),
      settings: stubSettings(),
      toolRunnerFactory: null,
      visionPreprocessorFor: () => null,
      queues,
      modelRegistry: async () => null,
    });

    const runPromise = processor(
      contextFor<'ai'>({ correlationId: 'test-ai-cancel-1', runId, workspaceId, userId }).context,
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
      search: { hybrid: search, keyword: keywordSearch },
      prisma,
      providerFor: providerFor(new CapturingAiProvider()),
      bus: recordingEventBus(published),
      storage: fakeStorage(Buffer.from('unused')),
      settings: stubSettings(),
      toolRunnerFactory: null,
      visionPreprocessorFor: () => null,
      queues,
      modelRegistry: async () => null,
    });
    await processor(
      contextFor<'ai'>({ correlationId: 'test-ai-fresh-1', runId, workspaceId, userId }).context,
    );

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
      search: { hybrid: search, keyword: keywordSearch },
      prisma,
      providerFor: providerFor(provider),
      bus: recordingEventBus(published),
      storage: fakeStorage(Buffer.from('unused')),
      settings: stubSettings(),
      toolRunnerFactory: null,
      visionPreprocessorFor: () => null,
      queues,
      modelRegistry: async () => null,
    });
    await processor(
      contextFor<'ai'>({ correlationId: 'test-ai-stale-1', runId, workspaceId, userId }).context,
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

async function createConversationRun(input: {
  conversationId: string;
  content: string;
  model?: string;
}): Promise<string> {
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
      search: { hybrid: search, keyword: keywordSearch },
      prisma,
      providerFor: providerFor(new MockAiProvider({ chunkDelayMs: 0 })),
      bus,
      storage: fakeStorage(Buffer.from('unused')),
      settings: stubSettings({ 'ai.maxToolIterations': 4 }),
      toolRunnerFactory: () => stubToolRunner([{ text: 'Werkzeugergebnis', isError: false }]),
      visionPreprocessorFor: () => null,
      queues,
      modelRegistry: async () => toolCapableModelRow('test-tool-model'),
    });

    await processor(
      contextFor<'ai'>({ correlationId: 'test-tool-loop-1', runId, workspaceId, userId }).context,
    );

    const run = await prisma.aiRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.status).toBe('COMPLETED');
    expect(run.toolIterations).toBe(1);
    expect(run.resultText).not.toBeNull();

    const messages = await prisma.aiConversationMessage.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'asc' },
    });
    const assistantWithToolCalls = messages.find(
      (message) => message.role === 'ASSISTANT' && message.toolCalls !== null,
    );
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
      search: { hybrid: search, keyword: keywordSearch },
      prisma,
      providerFor: providerFor(new MockAiProvider({ chunkDelayMs: 0 })),
      bus,
      storage: fakeStorage(Buffer.from('unused')),
      settings: stubSettings({ 'ai.maxToolIterations': 0 }),
      toolRunnerFactory: () => stubToolRunner([{ text: 'unused', isError: false }]),
      visionPreprocessorFor: () => null,
      queues,
      modelRegistry: async () => toolCapableModelRow('test-tool-model'),
    });

    await processor(
      contextFor<'ai'>({ correlationId: 'test-tool-limit-1', runId, workspaceId, userId }).context,
    );

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

    const provider = new MockAiProvider({
      chunkDelayMs: 0,
      fixedResponse: 'Kurze Zusammenfassung.',
    });
    const published: { type: string; payload: Record<string, unknown> }[] = [];
    const result = await compactIfNeeded({
      prisma,
      provider,
      bus: recordingEventBus(published),
      runId: 'run_compaction_1',
      conversationId,
      workspaceId,
      budgetInputTokens: 450,
      systemPromptTokens: 0,
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
    expect(active.find((message) => message.isSummary)?.content).toContain(
      'Kurze Zusammenfassung.',
    );

    // Issue #6, point 5: the compaction says so while it runs, not only once
    // it is over. Summarising a long transcript is exactly the kind of pause
    // that used to be indistinguishable from a dead run.
    const phases = published.filter((event) => event.type === 'ai.run.phase');
    expect(phases).toHaveLength(1);
    expect(phases[0]?.payload).toEqual({ runId: 'run_compaction_1', phase: 'compacting' });
    const compactedIndex = published.findIndex(
      (event) => event.type === 'ai.conversation.compacted',
    );
    expect(published.indexOf(phases[0]!)).toBeLessThan(compactedIndex);
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
      runId: 'run_compaction_2',
      conversationId,
      workspaceId,
      budgetInputTokens: 69_300,
      systemPromptTokens: 0,
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
      contextFor<'attachment-text'>({
        correlationId: 'test-attach-1',
        attachmentId,
        workspaceId,
        reason: 'upload',
      }).context,
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
      contextFor<'attachment-text'>({
        correlationId: 'test-attach-2',
        attachmentId,
        workspaceId,
        reason: 'upload',
      }).context,
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
      contextFor<'attachment-text'>({
        correlationId: 'test-attach-3',
        attachmentId,
        workspaceId,
        reason: 'upload',
      }).context,
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
      contextFor<'attachment-text'>({
        correlationId: 'test-attach-5',
        attachmentId,
        workspaceId,
        reason: 'upload',
      }).context,
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
        contextFor<'attachment-text'>({
          correlationId: 'test-attach-6',
          attachmentId,
          workspaceId,
          reason: 'upload',
        }).context,
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
      contextFor<'attachment-text'>({
        correlationId: 'test-attach-4',
        attachmentId,
        workspaceId,
        reason: 'upload',
      }).context,
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
      contextFor<'attachment-text'>({
        correlationId: 'test-attach-7',
        attachmentId,
        workspaceId,
        reason: 'upload',
      }).context,
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
      contextFor<'attachment-text'>({
        correlationId: 'test-attach-8',
        attachmentId,
        workspaceId,
        reason: 'upload',
      }).context,
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
      contextFor<'attachment-text'>({
        correlationId: 'test-attach-9',
        attachmentId,
        workspaceId,
        reason: 'retry',
      }).context,
    );
    expect(calls).toBe(0);
    expect(
      (await prisma.attachment.findUniqueOrThrow({ where: { id: attachmentId } })).extractedText,
    ).toBe('already read');

    // `forced` is the one reason allowed to skip the guard (issue #2): a
    // successful extraction can still be a wrong one.
    await processor(
      contextFor<'attachment-text'>({
        correlationId: 'test-attach-9b',
        attachmentId,
        workspaceId,
        reason: 'forced',
      }).context,
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
      extractors: () => [
        { extract: async () => ({ text: 'a fresh machine result', metadata: stubMetadata }) },
      ],
      documentInfo: noDocumentInfo,
      settings: stubSettings(),
    });

    await processor(
      contextFor<'attachment-text'>({
        correlationId: 'test-attach-10',
        attachmentId,
        workspaceId,
        reason: 'forced',
      }).context,
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
      contextFor<'attachment-text'>({
        correlationId: 'test-attach-11',
        attachmentId,
        workspaceId,
        reason: 'upload',
      }).context,
    );

    const truncated = await prisma.attachment.findUniqueOrThrow({ where: { id: attachmentId } });
    expect(truncated.textTruncated).toBe(true);
    expect(truncated.extractedText).toHaveLength(400_000);

    const processorShort = createAttachmentTextProcessor({
      prisma,
      storage: fakeStorage(Buffer.from('%PDF-1.7')),
      extractors: () => [
        { extract: async () => ({ text: 'short result', metadata: stubMetadata }) },
      ],
      documentInfo: noDocumentInfo,
      settings: stubSettings(),
    });
    await processorShort(
      contextFor<'attachment-text'>({
        correlationId: 'test-attach-11b',
        attachmentId,
        workspaceId,
        reason: 'forced',
      }).context,
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
    const processor = createMaterializeDocumentProcessor({
      prisma,
      queues,
      bus,
      settings: stubSettings(),
    });
    await processor(
      contextFor<'document-materialization'>({
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
      openRouterBaseUrl: OPENROUTER_TEST_BASE_URL,
      search,
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
      '# Quelle C\n\nEin Verweis auf [[Spätes Sammelsurium]].\n',
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
        title: 'Spätes Sammelsurium',
        orderKey: generateOrderKey(null, null),
        createdById: userId,
        updatedById: userId,
      },
    });
    await maintenance()(
      contextFor<'maintenance'>({
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

  /**
   * The sweep underneath the event-driven resolution.
   *
   * What it repairs is what a bulk import leaves behind: the pages and the
   * content that references them arrive in separate asynchronous steps, so a
   * target page's own event can fire while the references to it have not been
   * extracted yet. It matches nothing, and nothing ever comes back to those
   * rows. Reproduced here by creating the target *without* running the task
   * its creation would normally enqueue.
   */
  it('repairs references whose target existed all along but which no event revisited', async () => {
    const sourceId = await createLinkingDocument(
      '# Quelle R\n\nEin Verweis auf [[Übersehene Seite]].\n',
      'Quelle R',
    );
    await materialize(sourceId, 'test-links-repair');
    await prisma.document.create({
      data: {
        workspaceId,
        title: 'Übersehene Seite',
        orderKey: generateOrderKey(null, null),
        createdById: userId,
        updatedById: userId,
      },
    });

    // Exactly the state the Verweise tab reports as "no such page" although
    // the page is right there.
    const before = await prisma.documentLink.findFirstOrThrow({
      where: { sourceDocumentId: sourceId },
    });
    expect(before.targetDocumentId).toBeNull();

    await maintenance()(
      contextFor<'maintenance'>({
        correlationId: 'test-links-repair-2',
        task: 'repair-document-links',
        workspaceId,
        documentId: null,
      }).context,
    );

    const after = await prisma.documentLink.findFirstOrThrow({
      where: { sourceDocumentId: sourceId },
    });
    expect(after.targetDocumentId).not.toBeNull();
  }, 60_000);

  it('leaves a reference to a title nobody wrote unresolved, and says how many', async () => {
    const sourceId = await createLinkingDocument(
      '# Quelle S\n\nEin Verweis auf [[Diese Seite gibt es wirklich nicht]].\n',
      'Quelle S',
    );
    await materialize(sourceId, 'test-links-unresolvable');

    const result = await repairUnresolvedLinks(prisma, workspaceId);
    expect(result.unresolvable).toBeGreaterThanOrEqual(1);

    // And a second pass repairs nothing, because there is nothing left it can
    // reach: the sweep is idempotent and cheap to run on a schedule.
    expect((await repairUnresolvedLinks(prisma, workspaceId)).repaired).toBe(0);
    expect(
      (await prisma.documentLink.findFirstOrThrow({ where: { sourceDocumentId: sourceId } }))
        .targetDocumentId,
    ).toBeNull();
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
      contextFor<'maintenance'>({
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
      contextFor<'maintenance'>({
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
      contextFor<'maintenance'>({
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
      contextFor<'maintenance'>({
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

  /**
   * Issue #24: the same guarantee for the notation people actually type. A
   * `[[Titel]]` in running text is a `link` mark, and it carried nothing but
   * the title until now — so this is the half of the rename problem #14 left
   * standing.
   */
  it('keeps a [[Titel]] in running text pointing at its target after a rename', async () => {
    const target = await prisma.document.create({
      data: {
        workspaceId,
        title: 'Ziel im Fließtext',
        orderKey: generateOrderKey(null, null),
        createdById: userId,
        updatedById: userId,
      },
    });

    const imported = markdownToYjsState('Siehe [[Ziel im Fließtext]].\n', {
      transformDocument: (document) => bindPageLinkIdentities(document, () => target.id),
    });
    const source = await prisma.document.create({
      data: {
        workspaceId,
        title: 'Quelle mit Wikilink',
        orderKey: generateOrderKey(null, null),
        createdById: userId,
        updatedById: userId,
        content: {
          create: { yjsState: Buffer.from(imported.yjsState), yjsUpdatedAt: new Date() },
        },
      },
    });
    await materialize(source.id, 'test-links-wikimark');

    const initial = await prisma.documentLink.findFirstOrThrow({
      where: { sourceDocumentId: source.id },
    });
    expect(initial.kind).toBe('WIKI_MARK');
    expect(initial.targetHintId).toBe(target.id);
    expect(initial.targetDocumentId).toBe(target.id);

    await prisma.document.update({
      where: { id: target.id },
      data: { title: 'Anders benannt' },
    });
    await maintenance()(
      contextFor<'maintenance'>({
        correlationId: 'test-links-wikimark-b',
        task: 'resolve-document-links',
        workspaceId,
        documentId: target.id,
      }).context,
    );

    const afterRename = await prisma.documentLink.findFirstOrThrow({
      where: { sourceDocumentId: source.id },
    });
    expect(afterRename.targetDocumentId).toBe(target.id);
  }, 60_000);

  it('does nothing when the page it should resolve for is gone', async () => {
    await expect(
      maintenance()(
        contextFor<'maintenance'>({
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
    // Everything else in this workspace counts as already indexed, so the
    // batch below is exactly this page. The sweep takes `linkBackfillBatchSize`
    // rows in no particular order, and the earlier tests in this file leave
    // un-indexed pages behind; against the deployment database the running
    // worker had already swept them, against the isolated stack of issue #94
    // nothing has.
    await prisma.documentContent.updateMany({
      where: { linksIndexedAt: null, document: { workspaceId } },
      data: { linksIndexedAt: new Date() },
    });
    // Back to the state an existing deployment is in: derived JSON, no references.
    await prisma.documentLink.deleteMany({ where: { sourceDocumentId: sourceId } });
    await prisma.documentContent.update({
      where: { documentId: sourceId },
      data: { linksIndexedAt: null },
    });

    await maintenance()(
      contextFor<'maintenance'>({
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
      contextFor<'maintenance'>({
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

describe('rendering', () => {
  /**
   * The build processor, without ever starting a container (issue #44,
   * ADR-026).
   *
   * What is worth testing here is everything around the container: a job that
   * has already been claimed, a job somebody cancelled while it waited, and the
   * deployment where rendering is switched off. All three have to end as a
   * terminal status with a reason -- a render that leaves a row RUNNING for ever
   * is the one failure the dialog cannot recover from.
   */
  async function createRenderJob(
    overrides: Partial<{ status: 'PENDING' | 'RUNNING'; cancelledAt: Date | null }> = {},
  ): Promise<{ jobId: string; documentId: string }> {
    const documentId = await createDocument();
    const template = await prisma.renderTemplate.create({
      data: { workspaceId, name: 'Test', renderer: 'LATEX_PDF', source: null, createdById: userId },
    });
    const job = await prisma.renderJob.create({
      data: {
        workspaceId,
        documentId,
        documentTitle: 'Testseite',
        templateId: template.id,
        templateName: 'Test',
        renderer: 'LATEX_PDF',
        source: 'DOCUMENT',
        status: overrides.status ?? 'PENDING',
        variables: {},
        inputHash: `hash-${Date.now().toString(36)}`,
        cancelledAt: overrides.cancelledAt ?? null,
        createdById: userId,
      },
    });
    return { jobId: job.id, documentId };
  }

  function renderProcessor(settings: (workspaceId?: string) => Promise<Settings>) {
    return createRenderProcessor({
      prisma,
      storage: recordingStorage(),
      apiClientFor: null,
      settings,
      bus,
    });
  }

  it('leaves a job alone that another worker already picked up', async () => {
    const { jobId } = await createRenderJob({ status: 'RUNNING' });

    await renderProcessor(stubSettings({ 'render.enabled': true }))(
      contextFor<'render'>({ correlationId: 'render-1', jobId, workspaceId, userId }).context,
    );

    const row = await prisma.renderJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(row.status).toBe('RUNNING');
    expect(row.startedAt).toBeNull();
  });

  it('closes a job that was cancelled before it started', async () => {
    const { jobId } = await createRenderJob({ cancelledAt: new Date() });

    await renderProcessor(stubSettings({ 'render.enabled': true }))(
      contextFor<'render'>({ correlationId: 'render-2', jobId, workspaceId, userId }).context,
    );

    const row = await prisma.renderJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(row.status).toBe('CANCELLED');
    expect(row.finishedAt).not.toBeNull();
  });

  it('fails with a reason when rendering is switched off, instead of building', async () => {
    const { jobId } = await createRenderJob();

    await renderProcessor(stubSettings({ 'render.enabled': false }))(
      contextFor<'render'>({ correlationId: 'render-3', jobId, workspaceId, userId }).context,
    );

    const row = await prisma.renderJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(row.status).toBe('FAILED');
    expect(row.errorCode).toBe('renderer_unavailable');
    expect(row.log).not.toBeNull();
    expect(row.finishedAt).not.toBeNull();
  });

  it('says so when the page has no materialized content to build from', async () => {
    const { jobId, documentId } = await createRenderJob();
    await prisma.documentContent.update({
      where: { documentId },
      data: { markdown: null },
    });

    await renderProcessor(stubSettings({ 'render.enabled': true }))(
      contextFor<'render'>({ correlationId: 'render-4', jobId, workspaceId, userId }).context,
    );

    const row = await prisma.renderJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(row.status).toBe('FAILED');
    expect(row.errorCode).toBe('source_missing');
  });

  it('closes a build whose worker never came back, and keeps the recent one', async () => {
    const abandoned = await createRenderJob({ status: 'RUNNING' });
    await prisma.renderJob.update({
      where: { id: abandoned.jobId },
      data: {
        heartbeatAt: new Date(Date.now() - 120_000),
        startedAt: new Date(Date.now() - 120_000),
      },
    });
    const alive = await createRenderJob({ status: 'RUNNING' });
    await prisma.renderJob.update({
      where: { id: alive.jobId },
      data: { heartbeatAt: new Date(), startedAt: new Date() },
    });

    const maintenance = createMaintenanceProcessor({
      openRouterBaseUrl: OPENROUTER_TEST_BASE_URL,
      prisma,
      queues,
      storage: recordingStorage(),
      search,
      bus,
      settings: stubSettings({ 'render.jobRetentionDays': 0 }),
    });
    await maintenance(
      contextFor<'maintenance'>({
        correlationId: 'render-reap',
        task: 'reap-render-jobs',
        workspaceId: null,
        documentId: null,
      }).context,
    );

    expect(
      (await prisma.renderJob.findUniqueOrThrow({ where: { id: abandoned.jobId } })).status,
    ).toBe('FAILED');
    expect((await prisma.renderJob.findUniqueOrThrow({ where: { id: alive.jobId } })).status).toBe(
      'RUNNING',
    );
  });
});

/**
 * Endpoint snapshots (issue #68, ADR-032).
 *
 * The snapshot is what every request's provider allowlist is planned from, so
 * the two things that must never happen are a half-written one and an erased
 * one. Against the real database, because the guarantee is the transaction.
 */
describe('applyModelRouteSnapshot', () => {
  function endpoint(providerKey: string, contextWindowTokens: number) {
    return {
      providerKey,
      providerName: providerKey,
      contextWindowTokens,
      maxPromptTokens: null,
      maxOutputTokens: 131_072,
      inputMicroUsdPerMTok: 1_400_000,
      outputMicroUsdPerMTok: 4_400_000,
      supportsTools: true,
      supportsReasoningEffort: true,
      quantization: null,
    };
  }

  async function createModel(slug: string): Promise<string> {
    const created = await prisma.aiModel.create({
      data: {
        slug,
        displayName: slug,
        contextWindowTokens: 200_000,
        inputMicroUsdPerMTok: 1_000_000,
        outputMicroUsdPerMTok: 2_000_000,
        enabled: false,
      },
    });
    return created.id;
  }

  it('stores heterogeneous providers and the largest window as the model figure', async () => {
    const modelId = await createModel(`test/routes-${Date.now()}`);
    try {
      await applyModelRouteSnapshot(prisma, {
        modelId,
        targetSlug: 'z-ai/glm-5.3',
        aliasTargetSlug: null,
        endpoints: [endpoint('reka/fp8', 262_144), endpoint('together', 1_048_576)],
        fields: {
          contextWindowTokens: 1_048_576,
          maxOutputTokens: 131_072,
          inputMicroUsdPerMTok: 1_400_000,
          outputMicroUsdPerMTok: 4_400_000,
        },
      });

      const rows = await prisma.aiModelEndpoint.findMany({ where: { modelId } });
      expect(rows.map((row) => row.contextWindowTokens).sort((a, b) => a - b)).toEqual([
        262_144, 1_048_576,
      ]);
      const model = await prisma.aiModel.findUniqueOrThrow({ where: { id: modelId } });
      expect(model.contextWindowTokens).toBe(1_048_576);
      expect(model.endpointsSyncedAt).not.toBeNull();
    } finally {
      await prisma.aiModel.delete({ where: { id: modelId } });
    }
  });

  it('replaces the snapshot coherently when an alias moves to another model', async () => {
    const modelId = await createModel(`~test/latest-${Date.now()}`);
    try {
      await applyModelRouteSnapshot(prisma, {
        modelId,
        targetSlug: 'vendor/model-5.2',
        aliasTargetSlug: 'vendor/model-5.2',
        endpoints: [endpoint('old-provider', 200_000)],
      });
      await prisma.aiModel.update({
        where: { id: modelId },
        data: { endpointsStaleSince: new Date() },
      });

      await applyModelRouteSnapshot(prisma, {
        modelId,
        targetSlug: 'vendor/model-5.3',
        aliasTargetSlug: 'vendor/model-5.3',
        endpoints: [endpoint('new-provider', 1_000_000)],
      });

      const rows = await prisma.aiModelEndpoint.findMany({ where: { modelId } });
      // Never both targets at once: half of one model's capacities and half of
      // another's would be a plan for a model that does not exist.
      expect(rows.map((row) => row.providerKey)).toEqual(['new-provider']);
      expect(rows[0]?.targetSlug).toBe('vendor/model-5.3');
      const model = await prisma.aiModel.findUniqueOrThrow({ where: { id: modelId } });
      expect(model.aliasTargetSlug).toBe('vendor/model-5.3');
      expect(model.endpointsStaleSince).toBeNull();
    } finally {
      await prisma.aiModel.delete({ where: { id: modelId } });
    }
  });

  it('keeps the previous snapshot when a refresh comes back with nothing', async () => {
    const modelId = await createModel(`test/keeps-${Date.now()}`);
    try {
      await applyModelRouteSnapshot(prisma, {
        modelId,
        targetSlug: 'vendor/model',
        aliasTargetSlug: null,
        endpoints: [endpoint('known', 500_000)],
      });

      const result = await applyModelRouteSnapshot(prisma, {
        modelId,
        targetSlug: 'vendor/model',
        aliasTargetSlug: null,
        endpoints: [],
      });

      expect(result).toEqual({ written: 0, removed: 0 });
      const rows = await prisma.aiModelEndpoint.findMany({ where: { modelId } });
      expect(rows.map((row) => row.providerKey)).toEqual(['known']);
    } finally {
      await prisma.aiModel.delete({ where: { id: modelId } });
    }
  });
});
