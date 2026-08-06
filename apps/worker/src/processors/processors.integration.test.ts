import { Readable } from 'node:stream';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  type AiGenerateRequest,
  type AiProvider,
  type AiProviderCapabilities,
  type AiStreamEvent,
  MockAiProvider,
  type PdfDocumentInfoReader,
  type VisionPreprocessor,
} from '@exocortex/ai';
import { loadWorkerEnv } from '@exocortex/config';
import {
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
import { markdownToYjsState } from '@exocortex/editor';
import { createLogger, type Logger } from '@exocortex/logger';
import { type JobContext, QueueRegistry, RedisEventBus } from '@exocortex/queue';
import { type ObjectStorage } from '@exocortex/storage';

import { compactIfNeeded } from '../compaction';
import { type ToolRunner } from '../tool-runner';

import { createAiRunProcessor, type ResolvedModelRow } from './ai-run';
import { createAttachmentTextProcessor } from './attachment-text';
import { createIndexDocumentProcessor } from './index-document';
import { createMaintenanceProcessor } from './maintenance';
import { createMaterializeDocumentProcessor } from './materialize-document';

/** A fully-defaulted `Settings` object with just the given keys overridden. */
function stubSettings(overrides: Partial<Settings> = {}): () => Promise<Settings> {
  const settings = settingsSchema.parse(overrides);
  return async () => settings;
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
});
