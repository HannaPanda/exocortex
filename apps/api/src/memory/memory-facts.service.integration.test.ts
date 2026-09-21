import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { WorkspaceAccessService } from '@exocortex/auth';
import { type ApiEnv, loadDotEnv } from '@exocortex/config';
import {
  type MemoryFactVerdict,
  resolveSettings,
  type SearchResponse,
  type Settings,
} from '@exocortex/contracts';
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
import { DocumentWriteCommitService } from '../documents/document-write-commit.service';
import { DocumentsService } from '../documents/documents.service';
import { PageLinkIdentityService } from '../documents/page-link-identity.service';
import { EntityProfileService } from '../entities/entity-profile.service';
import { EntityRegistryService } from '../entities/entity-registry.service';
import { type SettingsService } from '../platform/settings.service';
import { settingsStub } from '../platform/settings.test-support';
import { type RealtimeService } from '../realtime/realtime.service';
import { type SearchService } from '../search/search.service';

import { MemoryService } from './memory.service';
import { MemoryFactsService } from './memory-facts.service';

/** `DocumentContentService` reads one value from the environment: the origin
 * an image's address is judged against (issue #117). */
const CONTENT_TEST_ENV = { APP_URL: 'https://exocortex.test' } as unknown as ApiEnv;

/**
 * The distilled layer, against the real database (issue #46, ADR-021).
 *
 * Everything worth proving here is about state that survives one call: that a
 * confirmation raises a fact instead of creating a second one, that a
 * correction leaves the old wording findable and marked, that a note is read
 * exactly once however the run goes, and that a made-up id changes nothing.
 * None of that is visible in a single response, so the assertions read the
 * rows back.
 */
loadDotEnv();

const logger: Logger = createLogger({ name: 'api-test', level: 'silent' });
const noopStorage = {} as unknown as ObjectStorage;
const correlationId = 'test-memory-facts';

let prisma: PrismaClient;
let queues: QueueRegistry;
let facts: MemoryFactsService;
let memory: MemoryService;
let memoryWorkspaceId: string;
let brainWorkspaceId: string;
let agentId: string;
let settings: Settings;

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

/** One note under the project page, which is what a consolidation run reads. */
async function writeNote(project: string, title: string): Promise<string> {
  const written = await memory.remember({
    userId: agentId,
    request: {
      project,
      title,
      text: `- ${title}`,
      client: 'claude-code',
      tags: [],
      appendToday: false,
    },
    correlationId,
  });
  return written.documentId;
}

function verdict(input: Partial<MemoryFactVerdict> & { noteId: string }): MemoryFactVerdict {
  return {
    kind: 'new',
    factId: null,
    statement: null,
    detail: '',
    ...input,
  };
}

beforeAll(async () => {
  prisma = createPrismaClient({ databaseUrl: process.env.DATABASE_URL });
  queues = new QueueRegistry({
    redisUrl: process.env.REDIS_URL ?? 'redis://127.0.0.1:6380',
    logger,
    prefix: testQueuePrefix('api-memory-facts'),
  });

  const suffix = Date.now().toString(36);
  const agent = await prisma.user.create({
    data: { email: `facts-${suffix}@exocortex.test`, name: 'Agent', emailVerified: true },
  });
  agentId = agent.id;

  const memoryWorkspace = await prisma.workspace.create({
    data: {
      name: `Memory ${suffix}`,
      slug: `memory-facts-${suffix}`,
      isMemory: true,
      members: { create: { userId: agentId, role: 'MEMBER' } },
    },
  });
  memoryWorkspaceId = memoryWorkspace.id;

  const brain = await prisma.workspace.create({
    data: {
      name: `Brain ${suffix}`,
      slug: `brain-facts-${suffix}`,
      members: { create: { userId: agentId, role: 'MEMBER' } },
    },
  });
  brainWorkspaceId = brain.id;

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
    logger,
    CONTENT_TEST_ENV,
    access,
    new DocumentWriteCommitService(prisma, queues, logger, outbox, realtime, collaboration),
    new PageLinkIdentityService(prisma),
    settingsStub(),
  );
  const settingsService = {
    get: async () => settings,
    getForWorkspace: async () => settings,
  } as unknown as SettingsService;
  const env = { APP_URL: 'https://exocortex.test' } as never;

  const entityRegistry = new EntityRegistryService(prisma, settingsService, access);
  memory = new MemoryService(
    prisma,
    queues,
    logger,
    env,
    settingsService,
    search,
    documents,
    content,
    entityRegistry,
    new EntityProfileService(prisma, entityRegistry, settingsService),
  );
  facts = new MemoryFactsService(prisma, logger, env, settingsService, documents, content);
});

beforeEach(() => {
  settings = resolveSettings({
    rows: [],
    env: {},
  }).settings;
});

afterAll(async () => {
  await prisma.workspace.deleteMany({
    where: { id: { in: [memoryWorkspaceId, brainWorkspaceId] } },
  });
  await prisma.user.deleteMany({ where: { id: agentId } });
  await queues.obliterateAll();
  await queues.close();
  await prisma.$disconnect();
});

describe('consolidate', () => {
  it('turns a new verdict into a page under Fakten and a row beside it', async () => {
    const project = `/tmp/neu-${Date.now().toString(36)}`;
    const noteId = await writeNote(project, 'Erste Sitzung');

    const applied = await facts.consolidate({
      userId: agentId,
      request: {
        project,
        noteIds: [noteId],
        verdicts: [verdict({ noteId, statement: 'Der Dienst läuft auf Port 3211.' })],
      },
      correlationId,
    });

    expect(applied.created).toBe(1);
    const row = await prisma.memoryFact.findFirst({
      where: { workspaceId: memoryWorkspaceId, projectKey: project },
      include: { document: { select: { title: true, parent: { select: { title: true } } } } },
    });
    expect(row?.document.title).toBe('Der Dienst läuft auf Port 3211.');
    // Beside the notes, not among them: a person opening the workspace should
    // be able to read what is known without reading what happened.
    expect(row?.document.parent?.title).toBe('Fakten');
    expect(row?.confirmations).toBe(1);
  });

  it('raises a fact on confirmation instead of writing it a second time', async () => {
    const project = `/tmp/bestaetigt-${Date.now().toString(36)}`;
    const first = await writeNote(project, 'Sitzung eins');
    await facts.consolidate({
      userId: agentId,
      request: {
        project,
        noteIds: [first],
        verdicts: [verdict({ noteId: first, statement: 'Backups laufen alle sechs Stunden.' })],
      },
      correlationId,
    });
    const created = await prisma.memoryFact.findFirstOrThrow({
      where: { workspaceId: memoryWorkspaceId, projectKey: project },
    });

    const second = await writeNote(project, 'Sitzung zwei');
    await facts.consolidate({
      userId: agentId,
      request: {
        project,
        noteIds: [second],
        verdicts: [verdict({ kind: 'confirms', noteId: second, factId: created.id })],
      },
      correlationId,
    });

    const after = await prisma.memoryFact.findFirstOrThrow({ where: { id: created.id } });
    expect(after.confirmations).toBe(2);
    expect(after.confidence).toBeGreaterThan(created.confidence);
    expect(
      await prisma.memoryFact.count({
        where: { workspaceId: memoryWorkspaceId, projectKey: project },
      }),
    ).toBe(1);
    // Both notes are recorded as evidence, and the second one as a confirmation.
    const sources = await prisma.memoryFactSource.findMany({ where: { factId: created.id } });
    expect(sources.map((source) => source.confirming).sort()).toEqual([false, true]);
  });

  it('keeps the old wording and points it at its successor when superseded', async () => {
    const project = `/tmp/ersetzt-${Date.now().toString(36)}`;
    const first = await writeNote(project, 'Alter Stand');
    await facts.consolidate({
      userId: agentId,
      request: {
        project,
        noteIds: [first],
        verdicts: [verdict({ noteId: first, statement: 'Die Datenbank liegt auf Host A.' })],
      },
      correlationId,
    });
    const old = await prisma.memoryFact.findFirstOrThrow({
      where: { workspaceId: memoryWorkspaceId, projectKey: project },
    });

    const second = await writeNote(project, 'Neuer Stand');
    const applied = await facts.consolidate({
      userId: agentId,
      request: {
        project,
        noteIds: [second],
        verdicts: [
          verdict({
            kind: 'supersedes',
            noteId: second,
            factId: old.id,
            statement: 'Die Datenbank liegt auf Host B.',
          }),
        ],
      },
      correlationId,
    });

    expect(applied.superseded).toBe(1);
    const after = await prisma.memoryFact.findFirstOrThrow({ where: { id: old.id } });
    expect(after.status).toBe('SUPERSEDED');
    expect(after.supersededById).not.toBeNull();

    // "What used to be true" is still an answer, but never the default one.
    const current = await facts.list(agentId, { project, status: ['current'], limit: 20 });
    expect(current.facts.map((fact) => fact.statement)).toEqual([
      'Die Datenbank liegt auf Host B.',
    ]);
  });

  it('marks every note in the batch as read, verdicts or not', async () => {
    const project = `/tmp/gelesen-${Date.now().toString(36)}`;
    const worthless = await writeNote(project, 'Nichts passiert');
    const useful = await writeNote(project, 'Etwas passiert');

    const applied = await facts.consolidate({
      userId: agentId,
      request: {
        project,
        noteIds: [worthless, useful],
        verdicts: [
          verdict({ kind: 'discard', noteId: worthless }),
          verdict({ noteId: useful, statement: 'Der Cron läuft nachts um drei.' }),
        ],
      },
      correlationId,
    });

    expect(applied.discarded).toBe(1);
    expect(applied.notesRead).toBe(2);
    // The cursor: without a row for the worthless note it would be re-read,
    // and re-paid for, every single night.
    expect(
      await prisma.memoryConsolidation.count({ where: { noteId: { in: [worthless, useful] } } }),
    ).toBe(2);
  });

  it('drops a verdict that names a fact nobody wrote', async () => {
    const project = `/tmp/erfunden-${Date.now().toString(36)}`;
    const noteId = await writeNote(project, 'Sitzung');

    const applied = await facts.consolidate({
      userId: agentId,
      request: {
        project,
        noteIds: [noteId],
        verdicts: [verdict({ kind: 'confirms', noteId, factId: 'gibtesnicht' })],
      },
      correlationId,
    });

    expect(applied.rejected).toBe(1);
    expect(applied.confirmed).toBe(0);
    expect(
      await prisma.memoryFact.count({
        where: { workspaceId: memoryWorkspaceId, projectKey: project },
      }),
    ).toBe(0);
  });
});

describe('recall', () => {
  it('puts what is held to be true in front of the hits', async () => {
    const project = `/tmp/abruf-${Date.now().toString(36)}`;
    const noteId = await writeNote(project, 'Sitzung');
    await facts.consolidate({
      userId: agentId,
      request: {
        project,
        noteIds: [noteId],
        verdicts: [verdict({ noteId, statement: 'Der Schlüssel liegt in der Umgebung.' })],
      },
      correlationId,
    });

    const recalled = await memory.recall(agentId, {
      project,
      limit: 5,
      maxChars: 6_000,
      includeKnowledge: false,
    });

    expect(recalled.facts.map((fact) => fact.statement)).toEqual([
      'Der Schlüssel liegt in der Umgebung.',
    ]);
    expect(recalled.text.startsWith('Stand der Dinge')).toBe(true);

    // The fact page and the `Fakten` page it hangs under are answered above,
    // so neither may take one of the five slots below as well.
    const titles = recalled.hits.map((hit) => hit.title);
    expect(titles).not.toContain('Fakten');
    expect(titles).not.toContain('Der Schlüssel liegt in der Umgebung.');
  });
});

describe('promote', () => {
  it('copies a fact into a curated workspace and does it once', async () => {
    const project = `/tmp/befoerdert-${Date.now().toString(36)}`;
    const noteId = await writeNote(project, 'Sitzung');
    await facts.consolidate({
      userId: agentId,
      request: {
        project,
        noteIds: [noteId],
        verdicts: [verdict({ noteId, statement: 'Der Zugang läuft über das gh CLI.' })],
      },
      correlationId,
    });
    const fact = await prisma.memoryFact.findFirstOrThrow({
      where: { workspaceId: memoryWorkspaceId, projectKey: project },
    });

    const promoted = await facts.promote({
      userId: agentId,
      factId: fact.id,
      request: { workspaceId: brainWorkspaceId, parentId: null },
      correlationId,
    });
    expect(promoted.alreadyPromoted).toBe(false);
    expect(promoted.workspaceId).toBe(brainWorkspaceId);

    const again = await facts.promote({
      userId: agentId,
      factId: fact.id,
      request: { workspaceId: brainWorkspaceId, parentId: null },
      correlationId,
    });
    // A second call must hand back the same page rather than filling the brain
    // with copies of one fact.
    expect(again.alreadyPromoted).toBe(true);
    expect(again.documentId).toBe(promoted.documentId);
  });
});
