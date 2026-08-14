import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

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
import { type SettingsService } from '../platform/settings.service';
import { type RealtimeService } from '../realtime/realtime.service';
import { type SearchService } from '../search/search.service';

import { MemoryService } from './memory.service';

/**
 * Memory tests against the real database.
 *
 * Writing is the half that has to be real: a memory is an ordinary page under
 * an ordinary parent, and what is worth proving is that two sessions of one
 * project end up under one project page rather than as two roots.
 *
 * Search is the half that is stubbed. Real hits would need the worker to have
 * materialized and indexed the pages first, and the behaviour under test here
 * is not whether Postgres finds a word: it is how hits from the agents' own
 * area and from the curated workspaces are ranked into one list.
 */
loadDotEnv();

const logger: Logger = createLogger({ name: 'api-test', level: 'silent' });

/** Nothing here deletes a page, so the storage half of the service is never reached. */
const noopStorage = {} as unknown as ObjectStorage;
const correlationId = 'test-memory';

let prisma: PrismaClient;
let queues: QueueRegistry;
let service: MemoryService;
let memoryWorkspaceId: string;
let brainWorkspaceId: string;
let agentId: string;
let strangerId: string;

/** What the stubbed search returns next, per workspace. */
let searchResults: Map<string, SearchResponse['results']>;

let settings: Settings;

const realtime = {
  emit: async () => {},
} as unknown as RealtimeService;

const liveResult: ApplyToLiveSessionResult = {
  applied: false,
  clientsCount: 0,
  yjsUpdatedAt: null,
  reachable: true,
};
const collaboration = {
  applyToLiveSession: async (input: { proseMirrorJson: ProseMirrorDocument }) => {
    // Serializing keeps the stub honest: a document the bridge could not read
    // would throw here rather than pass silently.
    serializePlainText(input.proseMirrorJson);
    return liveResult;
  },
} as unknown as CollaborationBridgeService;

const search = {
  search: async (workspaceId: string): Promise<SearchResponse> => ({
    query: 'egal',
    results: searchResults.get(workspaceId) ?? [],
    adapter: 'stub',
    tookMs: 0,
  }),
} as unknown as SearchService;

function hit(input: {
  documentId: string;
  workspaceId: string;
  title: string;
  rank: number;
  path?: { id: string; title: string }[];
}): SearchResponse['results'][number] {
  return {
    documentId: input.documentId,
    workspaceId: input.workspaceId,
    title: input.title,
    icon: null,
    iconColor: null,
    type: 'PAGE',
    path: input.path ?? [],
    snippet: `Ausschnitt zu ${input.title}`,
    rank: input.rank,
    archivedAt: null,
    updatedAt: new Date().toISOString(),
  };
}

beforeAll(async () => {
  prisma = createPrismaClient({ databaseUrl: process.env.DATABASE_URL });
  queues = new QueueRegistry({
    redisUrl: process.env.REDIS_URL ?? 'redis://127.0.0.1:6380',
    logger,
    prefix: testQueuePrefix('api-memory'),
  });

  const suffix = Date.now().toString(36);
  const [agent, stranger] = await Promise.all([
    prisma.user.create({
      data: { email: `agent-${suffix}@exocortex.test`, name: 'Agent', emailVerified: true },
    }),
    prisma.user.create({
      data: { email: `stranger-${suffix}@exocortex.test`, name: 'Stranger', emailVerified: true },
    }),
  ]);
  agentId = agent.id;
  strangerId = stranger.id;

  const memoryWorkspace = await prisma.workspace.create({
    data: {
      name: `Memory ${suffix}`,
      slug: `memory-${suffix}`,
      members: { create: { userId: agentId, role: 'MEMBER' } },
    },
  });
  memoryWorkspaceId = memoryWorkspace.id;

  const brain = await prisma.workspace.create({
    data: {
      name: `Brain ${suffix}`,
      slug: `brain-${suffix}`,
      members: { create: { userId: agentId, role: 'GUEST' } },
    },
  });
  brainWorkspaceId = brain.id;

  const access = new WorkspaceAccessService(prisma);
  const outbox = new OutboxService(prisma, logger);
  const documents = new DocumentsService(prisma, queues, logger, noopStorage, access, outbox, realtime, new DocumentTrashService(prisma, queues, logger, noopStorage, access, outbox, realtime), new DocumentMoveService(prisma, queues, logger, access, outbox, realtime));
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

  const settingsService = {
    get: async () => settings,
  } as unknown as SettingsService;

  service = new MemoryService(
    prisma,
    queues,
    logger,
    { APP_URL: 'https://exocortex.test' } as never,
    settingsService,
    search,
    documents,
    content,
  );
});

beforeEach(() => {
  searchResults = new Map();
  settings = resolveSettings({
    rows: [{ key: 'memory.workspaceId', value: memoryWorkspaceId }],
    env: {},
  }).settings;
});

afterAll(async () => {
  await prisma.workspace.deleteMany({
    where: { id: { in: [memoryWorkspaceId, brainWorkspaceId] } },
  });
  await prisma.user.deleteMany({ where: { id: { in: [agentId, strangerId] } } });
  await queues.obliterateAll();
  await queues.close();
  await prisma.$disconnect();
});

describe('remember', () => {
  it('files two notes of one project under a single project page', async () => {
    const first = await service.remember({
      userId: agentId,
      request: {
        project: '/var/www/beispiel',
        title: 'Erste Sitzung',
        text: '- etwas gelernt',
        client: 'claude-code',
        tags: [],
        appendToday: false,
      },
      correlationId,
    });
    const second = await service.remember({
      userId: agentId,
      request: {
        // The trailing slash is the same project: a working directory arrives
        // spelled both ways and must not collect two pages.
        project: '/var/www/beispiel/',
        title: 'Zweite Sitzung',
        text: '- noch etwas',
        client: 'hermes',
        tags: [],
        appendToday: false,
      },
      correlationId,
    });

    expect(first.documentId).not.toBe(second.documentId);
    const rows = await prisma.document.findMany({
      where: { id: { in: [first.documentId, second.documentId] } },
      select: { parentId: true },
    });
    const parents = new Set(rows.map((row) => row.parentId));
    expect(parents.size).toBe(1);

    const projectPages = await prisma.document.findMany({
      where: { workspaceId: memoryWorkspaceId, parentId: null, title: '/var/www/beispiel' },
    });
    expect(projectPages).toHaveLength(1);
  });

  it('appends to today’s note instead of starting a new page', async () => {
    const first = await service.remember({
      userId: agentId,
      request: {
        project: 'chat-projekt',
        title: 'Gedanke',
        text: '- erster Gedanke',
        client: 'chatgpt',
        tags: ['test'],
        appendToday: true,
      },
      correlationId,
    });
    const second = await service.remember({
      userId: agentId,
      request: {
        project: 'chat-projekt',
        title: 'Noch ein Gedanke',
        text: '- zweiter Gedanke',
        client: 'chatgpt',
        tags: [],
        appendToday: true,
      },
      correlationId,
    });

    expect(second.appended).toBe(true);
    expect(second.documentId).toBe(first.documentId);

    const content = await prisma.documentContent.findUnique({
      where: { documentId: first.documentId },
      select: { plainText: true },
    });
    expect(content?.plainText).toContain('erster Gedanke');
    expect(content?.plainText).toContain('zweiter Gedanke');
  });

  it('refuses to write when no memory workspace is configured', async () => {
    settings = resolveSettings({ rows: [], env: {} }).settings;
    await expect(
      service.remember({
        userId: agentId,
        request: {
          project: 'irgendwas',
          text: '- etwas',
          client: 'other',
          tags: [],
          appendToday: false,
        },
        correlationId,
      }),
    ).rejects.toMatchObject({ code: 'memory_unavailable' });
  });
});

describe('recall', () => {
  it('returns the newest notes of a project when no query is given', async () => {
    await service.remember({
      userId: agentId,
      request: {
        project: '/var/www/recall',
        title: 'Alt',
        text: '- alte Notiz',
        client: 'claude-code',
        tags: [],
        appendToday: false,
      },
      correlationId,
    });
    await service.remember({
      userId: agentId,
      request: {
        project: '/var/www/recall',
        title: 'Neu',
        text: '- neue Notiz',
        client: 'claude-code',
        tags: [],
        appendToday: false,
      },
      correlationId,
    });

    const recalled = await service.recall(agentId, {
      project: '/var/www/recall',
      limit: 5,
      maxChars: 6_000,
      includeKnowledge: true,
    });

    expect(recalled.hits.length).toBeGreaterThanOrEqual(2);
    expect(recalled.hits.every((entry) => entry.source === 'memory')).toBe(true);
    expect(recalled.text).toContain('Erinnerung');
  });

  it('ranks a memory of the named project above an equally ranked knowledge page', async () => {
    const projectPage = await prisma.document.create({
      data: {
        workspaceId: memoryWorkspaceId,
        title: '/var/www/ranking',
        type: 'PAGE',
        orderKey: 'a0',
        createdById: agentId,
        updatedById: agentId,
      },
      select: { id: true, title: true },
    });

    searchResults.set(memoryWorkspaceId, [
      hit({
        documentId: 'mem-1'.padEnd(10, '0'),
        workspaceId: memoryWorkspaceId,
        title: 'Sitzung im Projekt',
        rank: 0.5,
        path: [{ id: projectPage.id, title: '/var/www/ranking' }],
      }),
    ]);
    searchResults.set(brainWorkspaceId, [
      hit({
        documentId: 'brain-1'.padEnd(10, '0'),
        workspaceId: brainWorkspaceId,
        title: 'Gepflegte Seite',
        rank: 0.5,
      }),
    ]);

    const recalled = await service.recall(agentId, {
      q: 'ranking',
      project: '/var/www/ranking',
      limit: 5,
      maxChars: 6_000,
      includeKnowledge: true,
    });

    expect(recalled.hits.map((entry) => entry.source)).toEqual(['memory', 'knowledge']);
    expect(recalled.hits[0]?.score).toBeGreaterThan(recalled.hits[1]?.score ?? 0);
  });

  it('leaves the curated workspaces out when asked to', async () => {
    searchResults.set(memoryWorkspaceId, [
      hit({ documentId: 'mem-2'.padEnd(10, '0'), workspaceId: memoryWorkspaceId, title: 'Notiz', rank: 0.1 }),
    ]);
    searchResults.set(brainWorkspaceId, [
      hit({ documentId: 'brain-2'.padEnd(10, '0'), workspaceId: brainWorkspaceId, title: 'Wissen', rank: 0.9 }),
    ]);

    const recalled = await service.recall(agentId, {
      q: 'egal',
      limit: 5,
      maxChars: 6_000,
      includeKnowledge: false,
    });

    expect(recalled.hits.map((entry) => entry.title)).toEqual(['Notiz']);
  });

  it('stays inside the character budget and says so', async () => {
    const long = 'x'.repeat(300);
    searchResults.set(memoryWorkspaceId, [
      hit({ documentId: 'mem-3'.padEnd(10, '0'), workspaceId: memoryWorkspaceId, title: long, rank: 0.9 }),
      hit({ documentId: 'mem-4'.padEnd(10, '0'), workspaceId: memoryWorkspaceId, title: long, rank: 0.8 }),
      hit({ documentId: 'mem-5'.padEnd(10, '0'), workspaceId: memoryWorkspaceId, title: long, rank: 0.7 }),
    ]);

    const recalled = await service.recall(agentId, {
      q: 'egal',
      limit: 5,
      maxChars: 500,
      includeKnowledge: true,
    });

    expect(recalled.truncated).toBe(true);
    expect(recalled.hits.length).toBeLessThan(3);
    expect(recalled.text.length).toBeLessThanOrEqual(1_200);
  });

  it('tells a stranger nothing, because they are in no workspace', async () => {
    const recalled = await service.recall(strangerId, {
      q: 'egal',
      limit: 5,
      maxChars: 6_000,
      includeKnowledge: true,
    });
    expect(recalled.hits).toEqual([]);
  });
});

describe('capture', () => {
  it('queues a session and reports the job', async () => {
    const response = await service.capture({
      userId: agentId,
      request: {
        project: '/var/www/capture',
        client: 'claude-code',
        transcript: 'user: '.padEnd(2_000, 'a'),
      },
      correlationId,
    });

    expect(response.accepted).toBe(true);
    expect(response.jobId).not.toBeNull();
    expect(response.reason).toBeNull();
  });

  it('turns a session too short to be worth keeping away, without an error', async () => {
    // A hook must never see an exception for something the person cannot fix,
    // so the refusal is part of the answer.
    const response = await service.capture({
      userId: agentId,
      request: { project: '/var/www/capture', client: 'claude-code', transcript: 'user: hi' },
      correlationId,
    });

    expect(response.accepted).toBe(false);
    expect(response.reason).toBe('transcript_too_short');
  });

  it('refuses politely when no memory workspace is configured', async () => {
    settings = resolveSettings({ rows: [], env: {} }).settings;
    const response = await service.capture({
      userId: agentId,
      request: {
        project: '/var/www/capture',
        client: 'claude-code',
        transcript: 'user: '.padEnd(2_000, 'a'),
      },
      correlationId,
    });

    expect(response.accepted).toBe(false);
    expect(response.reason).toBe('memory_workspace_not_configured');
  });
});
