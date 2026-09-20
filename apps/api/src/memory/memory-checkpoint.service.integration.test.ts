import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { type AiProvider } from '@exocortex/ai';
import { WorkspaceAccessService } from '@exocortex/auth';
import { loadDotEnv } from '@exocortex/config';
import { resolveSettings, type SearchResponse, type Settings } from '@exocortex/contracts';
import { createPrismaClient, type PrismaClient } from '@exocortex/database';
import { type ProseMirrorDocument, serializePlainText } from '@exocortex/editor';
import { createLogger, type Logger } from '@exocortex/logger';
import { QueueRegistry, testQueuePrefix } from '@exocortex/queue';
import { type ObjectStorage } from '@exocortex/storage';

import { OutboxService } from '../common/outbox.service';
import {
  type ApplyToLiveSessionResult,
  type CollaborationBridgeService,
} from '../documents/collaboration-bridge.service';
import { DocumentContentService } from '../documents/document-content.service';
import { DocumentMoveService } from '../documents/document-move.service';
import { DocumentTrashService } from '../documents/document-trash.service';
import { DocumentsService } from '../documents/documents.service';
import { PageLinkIdentityService } from '../documents/page-link-identity.service';
import { EntityProfileService } from '../entities/entity-profile.service';
import { EntityRegistryService } from '../entities/entity-registry.service';
import { type SettingsService } from '../platform/settings.service';
import { type RealtimeService } from '../realtime/realtime.service';
import { type SearchService } from '../search/search.service';

import { MemoryService } from './memory.service';
import { MemoryCheckpointService } from './memory-checkpoint.service';

/**
 * The checkpoint against the real database (issue #92, ADR-046).
 *
 * The database is the point here and cannot be stubbed: what the endpoint
 * promises is that a second checkpoint of an overlapping conversation costs the
 * new turns only, and that promise lives entirely in the receipts of earlier
 * calls. The model is stubbed, because what it answers is not under test; that
 * it is asked once, and not twice, is.
 */
loadDotEnv();

const logger: Logger = createLogger({ name: 'api-test', level: 'silent' });
const noopStorage = {} as unknown as ObjectStorage;
const correlationId = 'test-checkpoint';

let prisma: PrismaClient;
let queues: QueueRegistry;
let service: MemoryCheckpointService;
let memoryWorkspaceId: string;
let agentId: string;
let settings: Settings;

/** Every prompt the stubbed model was handed, so "was it asked again?" has an answer. */
let prompts: string[];
/** What the stubbed model answers next. */
let answer: string;
/** Set to make the provider fail the way an outage does. */
let providerError: Error | null;

const realtime = { emit: async () => {} } as unknown as RealtimeService;

const liveResult: ApplyToLiveSessionResult = {
  applied: false,
  clientsCount: 0,
  yjsUpdatedAt: null,
  reachable: true,
};
const collaboration = {
  applyToLiveSession: async (input: { proseMirrorJson: ProseMirrorDocument }) => {
    serializePlainText(input.proseMirrorJson);
    return liveResult;
  },
} as unknown as CollaborationBridgeService;

const search = {
  search: async (): Promise<SearchResponse> => ({
    query: 'egal',
    results: [],
    adapter: 'stub',
    tookMs: 0,
  }),
} as unknown as SearchService;

const provider = {
  id: 'stub',
  generate: async (request: { messages: { content: string }[] }) => {
    prompts.push(request.messages.map((message) => message.content).join('\n'));
    if (providerError !== null) throw providerError;
    return { text: answer, usage: null, model: 'stub', finishReason: 'stop' };
  },
} as unknown as AiProvider;

/** One message of evidence, spelled the way Hermes hands it over. */
function message(role: string, text: string): { role: string; text: string } {
  return { role, text };
}

beforeAll(async () => {
  prisma = createPrismaClient({ databaseUrl: process.env.DATABASE_URL });
  queues = new QueueRegistry({
    redisUrl: process.env.REDIS_URL ?? 'redis://127.0.0.1:6380',
    logger,
    prefix: testQueuePrefix('api-checkpoint'),
  });

  const suffix = Date.now().toString(36);
  const agent = await prisma.user.create({
    data: { email: `cp-agent-${suffix}@exocortex.test`, name: 'Agent', emailVerified: true },
  });
  agentId = agent.id;

  const memoryWorkspace = await prisma.workspace.create({
    data: {
      name: `Memory ${suffix}`,
      slug: `cp-memory-${suffix}`,
      isMemory: true,
      members: { create: { userId: agentId, role: 'MEMBER' } },
    },
  });
  memoryWorkspaceId = memoryWorkspace.id;

  const access = new WorkspaceAccessService(prisma);
  const outbox = new OutboxService(prisma, logger);
  const documents = new DocumentsService(
    prisma,
    queues,
    logger,
    noopStorage,
    access,
    outbox,
    realtime,
    new DocumentTrashService(prisma, queues, logger, noopStorage, access, outbox, realtime),
    new DocumentMoveService(prisma, queues, logger, access, outbox, realtime),
  );
  const content = new DocumentContentService(
    prisma,
    queues,
    logger,
    access,
    outbox,
    realtime,
    collaboration,
    new PageLinkIdentityService(prisma),
  );

  // Bound to this test's own workspace. A stub that answers for every
  // workspace id has archived real memory notes before (issue #94's sibling).
  const settingsService = {
    get: async () => settings,
    getForWorkspace: async (workspaceId: string) => {
      if (workspaceId !== memoryWorkspaceId) {
        throw new Error(`the checkpoint test must not read settings of ${workspaceId}`);
      }
      return settings;
    },
  } as unknown as SettingsService;

  const entityRegistry = new EntityRegistryService(prisma, settingsService, access);
  const memory = new MemoryService(
    prisma,
    queues,
    logger,
    { APP_URL: 'https://exocortex.test' } as never,
    settingsService,
    search,
    documents,
    content,
    entityRegistry,
    new EntityProfileService(prisma, entityRegistry, settingsService),
  );

  service = new MemoryCheckpointService(
    prisma,
    logger,
    'stub/model',
    provider,
    settingsService,
    memory,
  );
});

beforeEach(async () => {
  prompts = [];
  providerError = null;
  answer = 'TITEL: Der Provider ist gebaut\n\n- entschieden: HTTP statt MCP\n- offen: Doku';
  settings = resolveSettings({ rows: [], env: {} }).settings;
  await prisma.memoryCheckpoint.deleteMany({ where: { userId: agentId } });
});

afterAll(async () => {
  await prisma.workspace.deleteMany({ where: { id: memoryWorkspaceId } });
  await prisma.user.deleteMany({ where: { id: agentId } });
  await queues.obliterateAll();
  await queues.close();
  await prisma.$disconnect();
});

describe('checkpoint', () => {
  it('writes the note before it answers, and records what it saw', async () => {
    const response = await service.checkpoint({
      userId: agentId,
      correlationId,
      request: {
        project: '/var/www/exocortex',
        client: 'hermes',
        sessionId: 'session-a',
        messages: [message('user', 'Bau den Provider'), message('assistant', 'Erledigt')],
      },
    });

    expect(response.deduplicated).toBe(false);
    expect(response.newMessages).toBe(2);
    expect(response.documentId).not.toBeNull();
    // `remember` dates every note it files, the same way a capture's is dated.
    expect(response.title).toMatch(/^\d{4}-\d{2}-\d{2} Der Provider ist gebaut$/);

    // The page exists by the time the caller is allowed to forget.
    const page = await prisma.document.findUniqueOrThrow({
      where: { id: response.documentId! },
      select: { workspaceId: true, title: true },
    });
    expect(page.workspaceId).toBe(memoryWorkspaceId);

    const receipt = await prisma.memoryCheckpoint.findUniqueOrThrow({
      where: { id: response.checkpointId },
      select: { messageCount: true, evidenceChars: true, messageDigests: true, client: true },
    });
    expect(receipt.messageCount).toBe(2);
    expect(receipt.messageDigests).toHaveLength(2);
    expect(receipt.client).toBe('hermes');
    // The receipt is a receipt: no evidence made it into the row.
    expect(JSON.stringify(receipt)).not.toContain('Bau den Provider');
  });

  it('answers a repeated checkpoint from the receipt, without asking the model again', async () => {
    const messages = [message('user', 'eins'), message('assistant', 'zwei')];
    const first = await service.checkpoint({
      userId: agentId,
      correlationId,
      request: { project: 'p', client: 'hermes', sessionId: 'session-b', messages },
    });

    const second = await service.checkpoint({
      userId: agentId,
      correlationId,
      request: { project: 'p', client: 'hermes', sessionId: 'session-b', messages },
    });

    expect(second.deduplicated).toBe(true);
    expect(second.newMessages).toBe(0);
    expect(second.checkpointId).toBe(first.checkpointId);
    expect(prompts).toHaveLength(1);
  });

  it('distils only the new turns when the second window overlaps the first', async () => {
    // The case that actually happens: Hermes compacts at turn two and again at
    // turn four, with the first two turns still in the list.
    await service.checkpoint({
      userId: agentId,
      correlationId,
      request: {
        project: 'p',
        client: 'hermes',
        sessionId: 'session-c',
        messages: [message('user', 'eins'), message('assistant', 'zwei')],
      },
    });

    const second = await service.checkpoint({
      userId: agentId,
      correlationId,
      request: {
        project: 'p',
        client: 'hermes',
        sessionId: 'session-c',
        messages: [
          message('user', 'eins'),
          message('assistant', 'zwei'),
          message('user', 'drei'),
          message('assistant', 'vier'),
        ],
      },
    });

    expect(second.deduplicated).toBe(false);
    expect(second.newMessages).toBe(2);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('drei');
    expect(prompts[1]).not.toContain('eins');
  });

  it('keeps the same evidence apart when it belongs to two sessions', async () => {
    const messages = [message('user', 'dasselbe')];
    await service.checkpoint({
      userId: agentId,
      correlationId,
      request: { project: 'p', client: 'hermes', sessionId: 'session-d', messages },
    });
    const other = await service.checkpoint({
      userId: agentId,
      correlationId,
      request: { project: 'p', client: 'hermes', sessionId: 'session-e', messages },
    });

    expect(other.deduplicated).toBe(false);
    expect(prompts).toHaveLength(2);
  });

  it('throws when the model cannot be reached, so the caller does not compact', async () => {
    providerError = new Error('upstream is down');

    await expect(
      service.checkpoint({
        userId: agentId,
        correlationId,
        request: {
          project: 'p',
          client: 'hermes',
          sessionId: 'session-f',
          messages: [message('user', 'etwas')],
        },
      }),
    ).rejects.toThrow('upstream is down');

    // Nothing was recorded, so the next attempt distils the same turns again
    // rather than skipping evidence nothing ever wrote down.
    const receipts = await prisma.memoryCheckpoint.count({
      where: { userId: agentId, sessionId: 'session-f' },
    });
    expect(receipts).toBe(0);
  });

  it('throws when the memory area is switched off', async () => {
    settings = { ...settings, 'memory.enabled': false };

    await expect(
      service.checkpoint({
        userId: agentId,
        correlationId,
        request: {
          project: 'p',
          client: 'hermes',
          sessionId: 'session-g',
          messages: [message('user', 'etwas')],
        },
      }),
    ).rejects.toThrow(/memory area is switched off/);
  });

  it('succeeds with no note when the model finds nothing worth keeping', async () => {
    // A successful checkpoint: the judgement was made and recorded, and
    // refusing the compaction would pin small talk in the context forever.
    answer = 'NICHTS';

    const response = await service.checkpoint({
      userId: agentId,
      correlationId,
      request: {
        project: 'p',
        client: 'hermes',
        sessionId: 'session-h',
        messages: [message('user', 'hallo'), message('assistant', 'hallo')],
      },
    });

    expect(response.documentId).toBeNull();
    expect(response.deduplicated).toBe(false);

    // And the receipt still covers those turns, so they are not re-distilled.
    const again = await service.checkpoint({
      userId: agentId,
      correlationId,
      request: {
        project: 'p',
        client: 'hermes',
        sessionId: 'session-h',
        messages: [message('user', 'hallo'), message('assistant', 'hallo')],
      },
    });
    expect(again.deduplicated).toBe(true);
    expect(prompts).toHaveLength(1);
  });
});
