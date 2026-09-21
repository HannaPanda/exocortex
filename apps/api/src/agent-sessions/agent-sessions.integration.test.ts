import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { WorkspaceAccessService } from '@exocortex/auth';
import { type ApiEnv, loadDotEnv } from '@exocortex/config';
import { createPrismaClient, type PrismaClient } from '@exocortex/database';
import {
  type ProseMirrorDocument,
  serializePlainText,
  yjsStateToProseMirrorJson,
} from '@exocortex/editor';
import { createLogger, type Logger } from '@exocortex/logger';
import { QueueRegistry, testQueuePrefix } from '@exocortex/queue';
import { type ObjectStorage } from '@exocortex/storage';

import { runWithRequestContext } from '../common/correlation';
import { OutboxService } from '../common/outbox.service';
import {
  type ApplyToLiveSessionResult,
  type CollaborationBridgeService,
} from '../documents/collaboration-bridge.service';
import { DocumentContentService } from '../documents/document-content.service';
import { DocumentMoveService } from '../documents/document-move.service';
import { DocumentSnapshotService } from '../documents/document-snapshot.service';
import { DocumentTrashService } from '../documents/document-trash.service';
import { DocumentWriteCommitService } from '../documents/document-write-commit.service';
import { DocumentsService } from '../documents/documents.service';
import { PageLinkIdentityService } from '../documents/page-link-identity.service';
import { type RealtimeService } from '../realtime/realtime.service';

import { AgentSessionRevertService } from './agent-session-revert.service';
import { AgentSessionsService } from './agent-sessions.service';

/** `DocumentContentService` reads one value from the environment: the origin
 * an image's address is judged against (issue #117). */
const CONTENT_TEST_ENV = { APP_URL: 'https://exocortex.test' } as unknown as ApiEnv;

/**
 * Provenance end to end, against the real database (issue #49, ADR-022).
 *
 * Everything worth proving here spans more than one call: that a write made
 * inside an agent session leaves a row pointing at the state before it, that
 * reverting the session actually puts that state back, and -- the one that
 * matters most -- that a page somebody else has touched since is named rather
 * than overwritten. None of it is visible in a single response, so the
 * assertions read the pages and the rows back.
 *
 * The request context is entered by hand with `runWithRequestContext`, which is
 * exactly what the Fastify hook does per request. That is the seam being
 * tested: no service takes the session as an argument, so if the context ever
 * stops reaching `OutboxService`, every one of these goes red.
 */
loadDotEnv();

const logger: Logger = createLogger({ name: 'api-test', level: 'silent' });
const noopStorage = {} as unknown as ObjectStorage;
const correlationId = 'agent-sessions-test';

let prisma: PrismaClient;
let queues: QueueRegistry;
let documents: DocumentsService;
let content: DocumentContentService;
let sessions: AgentSessionsService;
let workspaceId: string;
let agentUserId: string;
let humanUserId: string;

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

/** Runs `operation` as if the request had carried the provenance headers. */
async function asAgent<T>(
  externalId: string,
  userId: string,
  operation: () => Promise<T>,
): Promise<T> {
  return runWithRequestContext(
    { correlationId, userId, agentSession: { externalId, clientLabel: 'claude-code 1.0' } },
    operation,
  );
}

async function createPage(title: string): Promise<string> {
  const document = await documents.create({
    workspaceId,
    userId: agentUserId,
    request: { title, type: 'PAGE', parentId: null },
    correlationId,
  });
  return document.id;
}

async function write(documentId: string, markdown: string, userId = agentUserId): Promise<void> {
  await content.write({
    documentId,
    userId,
    request: { markdown, mode: 'replace' },
    correlationId,
    source: 'ai',
  });
}

/**
 * Reads the page out of its canonical Yjs state, not out of `markdown`.
 *
 * A restore writes the binary state and clears `materializedAt` so the job
 * rebuilds the derived columns (ADR-005/007); no worker runs in this suite, so
 * `markdown` here is still the text the revert took away. Deriving it in the
 * test is what makes the assertion about the restore rather than about the
 * materialization queue.
 */
async function textOf(documentId: string): Promise<string> {
  const row = await prisma.documentContent.findUniqueOrThrow({
    where: { documentId },
    select: { yjsState: true },
  });
  return serializePlainText(yjsStateToProseMirrorJson(row.yjsState));
}

beforeAll(async () => {
  prisma = createPrismaClient({ databaseUrl: process.env.DATABASE_URL });
  queues = new QueueRegistry({
    redisUrl: process.env.REDIS_URL ?? 'redis://127.0.0.1:6380',
    logger,
    prefix: testQueuePrefix('api-agent-sessions'),
  });

  const access = new WorkspaceAccessService(prisma);
  const outbox = new OutboxService(prisma, logger);
  documents = new DocumentsService(
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
  content = new DocumentContentService(
    prisma,
    logger,
    CONTENT_TEST_ENV,
    access,
    new DocumentWriteCommitService(prisma, queues, logger, outbox, realtime, collaboration),
    new PageLinkIdentityService(prisma),
  );
  const snapshots = new DocumentSnapshotService(
    prisma,
    queues,
    logger,
    access,
    outbox,
    realtime,
    collaboration,
  );
  sessions = new AgentSessionsService(
    prisma,
    logger,
    new AgentSessionRevertService(prisma, logger, snapshots),
  );

  const suffix = Date.now().toString(36);
  const [agent, human] = await Promise.all([
    prisma.user.create({
      data: { email: `agent-${suffix}@exocortex.test`, name: 'Agent', emailVerified: true },
    }),
    prisma.user.create({
      data: { email: `human-${suffix}@exocortex.test`, name: 'Mensch', emailVerified: true },
    }),
  ]);
  agentUserId = agent.id;
  humanUserId = human.id;

  const workspace = await prisma.workspace.create({
    data: {
      name: `Agenten ${suffix}`,
      slug: `agent-sessions-${suffix}`,
      members: {
        create: [
          { userId: agentUserId, role: 'OWNER' },
          { userId: humanUserId, role: 'MEMBER' },
        ],
      },
    },
  });
  workspaceId = workspace.id;
}, 30_000);

afterAll(async () => {
  await prisma.workspace.deleteMany({ where: { id: workspaceId } });
  await prisma.user.deleteMany({ where: { id: { in: [agentUserId, humanUserId] } } });
  await queues.obliterateAll();
  await queues.close();
  await prisma.$disconnect();
});

describe('the journal', () => {
  it('records a write against the session and points it at the state before', async () => {
    const documentId = await createPage('Journal');
    await write(documentId, 'Vorher');
    await asAgent('sess-journal', agentUserId, () => write(documentId, 'Nachher'));

    const rows = await prisma.agentWriteJournal.findMany({
      where: { documentId, session: { externalId: 'sess-journal' } },
      select: { snapshotBeforeId: true, action: true, documentTitle: true },
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.action).toBe('document.updated');
    expect(rows[0]?.documentTitle).toBe('Journal');
    expect(rows[0]?.snapshotBeforeId).not.toBeNull();
  });

  it('ignores a write nobody claimed a session for', async () => {
    const documentId = await createPage('Ohne Sitzung');
    await write(documentId, 'Etwas');

    const count = await prisma.agentWriteJournal.count({ where: { documentId } });
    expect(count).toBe(0);
  });

  it('keeps two accounts using the same session id apart', async () => {
    const documentId = await createPage('Geteilte Id');
    await asAgent('sess-shared', agentUserId, () => write(documentId, 'Vom Agenten'));
    await asAgent('sess-shared', humanUserId, () => write(documentId, 'Vom Menschen'));

    const rows = await prisma.agentSession.findMany({
      where: { externalId: 'sess-shared' },
      select: { userId: true },
    });
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.userId))).toEqual(new Set([agentUserId, humanUserId]));
  });
});

describe('the bulk revert', () => {
  it('puts every page of the session back and reports what it did', async () => {
    const first = await createPage('Eins');
    const second = await createPage('Zwei');
    await write(first, 'Original eins');
    await write(second, 'Original zwei');

    await asAgent('sess-revert', agentUserId, async () => {
      await write(first, 'Agent eins');
      await write(first, 'Agent eins, zweiter Versuch');
      await write(second, 'Agent zwei');
    });

    const session = await prisma.agentSession.findFirstOrThrow({
      where: { externalId: 'sess-revert', userId: agentUserId },
      select: { id: true },
    });
    const result = await sessions.revert(session.id, agentUserId, correlationId);

    expect(result.skipped).toEqual([]);
    expect(result.reverted.map((entry) => entry.documentId).sort()).toEqual([first, second].sort());
    // Back to before the *first* write of the session, not the last one.
    expect(await textOf(first)).toContain('Original eins');
    expect(await textOf(second)).toContain('Original zwei');
  });

  it('leaves a page alone that another session wrote afterwards, and names it', async () => {
    const documentId = await createPage('Umstritten');
    await write(documentId, 'Original');
    await asAgent('sess-first', agentUserId, () => write(documentId, 'Vom ersten Agenten'));
    await asAgent('sess-second', agentUserId, () => write(documentId, 'Vom zweiten Agenten'));

    const session = await prisma.agentSession.findFirstOrThrow({
      where: { externalId: 'sess-first', userId: agentUserId },
      select: { id: true },
    });
    const result = await sessions.revert(session.id, agentUserId, correlationId);

    expect(result.reverted).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.reason).toBe('changed_since');
    expect(await textOf(documentId)).toContain('Vom zweiten Agenten');
  });

  it('reports a rename as nothing it can take back', async () => {
    const documentId = await createPage('Alter Titel');
    await asAgent('sess-rename', agentUserId, () =>
      documents.update({
        documentId,
        userId: agentUserId,
        request: { title: 'Neuer Titel' },
        correlationId,
      }),
    );

    const session = await prisma.agentSession.findFirstOrThrow({
      where: { externalId: 'sess-rename', userId: agentUserId },
      select: { id: true },
    });
    const result = await sessions.revert(session.id, agentUserId, correlationId);

    expect(result.reverted).toEqual([]);
    expect(result.skipped[0]?.reason).toBe('no_snapshot');
  });
});

describe('reading sessions', () => {
  it('shows a stranger nothing, not even that the session exists', async () => {
    const documentId = await createPage('Fremd');
    await asAgent('sess-private', agentUserId, () => write(documentId, 'Geheim'));
    const session = await prisma.agentSession.findFirstOrThrow({
      where: { externalId: 'sess-private', userId: agentUserId },
      select: { id: true },
    });

    await expect(sessions.detail(session.id, humanUserId)).rejects.toThrow(/not found/i);
  });

  it('counts writes and pages without reading every row', async () => {
    const first = await createPage('Zählen eins');
    const second = await createPage('Zählen zwei');
    await asAgent('sess-count', agentUserId, async () => {
      await write(first, 'a');
      await write(first, 'b');
      await write(second, 'c');
    });

    const listed = await sessions.list(agentUserId);
    const session = listed.sessions.find((entry) => entry.externalId === 'sess-count');

    expect(session?.writeCount).toBe(3);
    expect(session?.documentCount).toBe(2);
    expect(session?.revertable).toBe(true);
    expect(session?.clientLabel).toBe('claude-code 1.0');
  });
});
