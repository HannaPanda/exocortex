import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { WorkspaceAccessService } from '@exocortex/auth';
import { type ApiEnv, loadDotEnv } from '@exocortex/config';
import { createPrismaClient, type PrismaClient } from '@exocortex/database';
import { serializePlainText, yjsStateToProseMirrorJson } from '@exocortex/editor';
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
import { DocumentDiffService } from '../documents/document-diff.service';
import { DocumentEditService } from '../documents/document-edit.service';
import { DocumentMoveService } from '../documents/document-move.service';
import { DocumentSnapshotService } from '../documents/document-snapshot.service';
import { DocumentTrashService } from '../documents/document-trash.service';
import { DocumentWriteCommitService } from '../documents/document-write-commit.service';
import { DocumentsService } from '../documents/documents.service';
import { PageLinkIdentityService } from '../documents/page-link-identity.service';
import { settingsStub } from '../platform/settings.test-support';
import { type RealtimeService } from '../realtime/realtime.service';

import { runSessionExternalId } from './run-changes';
import { RunChangesService } from './run-changes.service';

/**
 * Taking one AI run back, against the real database (issue #248).
 *
 * The run writes under its own agent session the way the worker's tool loop
 * does (`ai-run-<id>`, ADR-022); a person then changes one of the blocks the
 * run wrote. What has to hold is the whole point of the feature: everything
 * still as the run left it goes back, the block the person changed stays and
 * is named, and a second undo finds nothing left to do.
 */
loadDotEnv();

const CONTENT_TEST_ENV = { APP_URL: 'https://exocortex.test' } as unknown as ApiEnv;
const logger: Logger = createLogger({ name: 'api-test', level: 'silent' });
const correlationId = 'run-changes-test';

let prisma: PrismaClient;
let queues: QueueRegistry;
let documents: DocumentsService;
let content: DocumentContentService;
let edits: DocumentEditService;
let runChanges: RunChangesService;
let workspaceId: string;
let requesterId: string;
let otherId: string;

const realtime = { emit: async () => {} } as unknown as RealtimeService;
const liveResult: ApplyToLiveSessionResult = {
  applied: false,
  clientsCount: 0,
  yjsUpdatedAt: null,
  reachable: true,
};
const collaboration = {
  applyToLiveSession: async () => liveResult,
} as unknown as CollaborationBridgeService;

async function asRun<T>(runId: string, operation: () => Promise<T>): Promise<T> {
  return runWithRequestContext(
    {
      correlationId,
      userId: requesterId,
      agentSession: { externalId: runSessionExternalId(runId), clientLabel: 'eXocortex KI' },
    },
    operation,
  );
}

async function createRun(): Promise<string> {
  const run = await prisma.aiRun.create({
    data: {
      workspaceId,
      createdById: requesterId,
      provider: 'mock',
      model: 'mock',
      messages: [],
      status: 'COMPLETED',
    },
  });
  return run.id;
}

async function createPage(title: string, markdown: string): Promise<string> {
  const document = await documents.create({
    workspaceId,
    userId: requesterId,
    request: { title, type: 'PAGE', parentId: null },
    correlationId,
  });
  await content.write({
    documentId: document.id,
    userId: requesterId,
    request: { markdown, mode: 'replace' },
    correlationId,
    source: 'api',
    growth: 'guarded',
  });
  return document.id;
}

async function createChild(title: string, parentId: string | null, userId = requesterId) {
  const document = await documents.create({
    workspaceId,
    userId,
    request: { title, type: 'PAGE', parentId },
    correlationId,
  });
  return document.id;
}

async function write(documentId: string, userId: string, markdown: string) {
  await content.write({
    documentId,
    userId,
    request: { markdown, mode: 'replace' },
    correlationId,
    source: userId === requesterId ? 'ai' : 'api',
    growth: 'guarded',
  });
}

async function finishRun(runId: string) {
  await prisma.aiRun.update({ where: { id: runId }, data: { finishedAt: new Date() } });
}

async function patch(documentId: string, userId: string, oldText: string, newText: string) {
  await edits.patch({
    documentId,
    userId,
    request: { oldText, newText, replaceAll: false },
    correlationId,
    source: userId === requesterId ? 'ai' : 'api',
  });
}

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
    prefix: testQueuePrefix('api-run-changes'),
  });
  const access = new WorkspaceAccessService(prisma);
  const outbox = new OutboxService(prisma, logger);
  const noopStorage = {} as unknown as ObjectStorage;
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
  const commits = new DocumentWriteCommitService(
    prisma,
    queues,
    logger,
    outbox,
    realtime,
    collaboration,
  );
  content = new DocumentContentService(
    prisma,
    logger,
    CONTENT_TEST_ENV,
    access,
    commits,
    new PageLinkIdentityService(prisma),
    settingsStub(),
  );
  edits = new DocumentEditService(
    prisma,
    logger,
    CONTENT_TEST_ENV,
    access,
    commits,
    new PageLinkIdentityService(prisma),
    settingsStub(),
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
  runChanges = new RunChangesService(
    prisma,
    logger,
    access,
    new DocumentDiffService(prisma, logger, access, snapshots),
    documents,
  );

  const suffix = Date.now().toString(36);
  const [requester, other] = await Promise.all([
    prisma.user.create({
      data: { email: `run-owner-${suffix}@exocortex.test`, name: 'Fragende', emailVerified: true },
    }),
    prisma.user.create({
      data: { email: `run-other-${suffix}@exocortex.test`, name: 'Andere', emailVerified: true },
    }),
  ]);
  requesterId = requester.id;
  otherId = other.id;
  const workspace = await prisma.workspace.create({
    data: {
      name: `Lauf ${suffix}`,
      slug: `run-changes-${suffix}`,
      members: {
        create: [
          { userId: requesterId, role: 'OWNER' },
          { userId: otherId, role: 'MEMBER' },
        ],
      },
    },
  });
  workspaceId = workspace.id;
}, 30_000);

afterAll(async () => {
  await prisma.workspace.deleteMany({ where: { id: workspaceId } });
  await prisma.user.deleteMany({ where: { id: { in: [requesterId, otherId] } } });
  await queues.obliterateAll();
  await queues.close();
  await prisma.$disconnect();
});

describe('taking one AI run back', () => {
  it('records the blocks each of the run’s writes changed', async () => {
    const documentId = await createPage('Journal', 'Apfel\n\nBirne\n\nPflaume');
    const runId = await createRun();
    await asRun(runId, () => patch(documentId, requesterId, 'Birne', 'Kirsche'));

    const rows = await prisma.agentWriteJournal.findMany({
      where: { documentId, session: { externalId: runSessionExternalId(runId) } },
      select: { writtenBlocks: true },
    });
    expect(rows).toHaveLength(1);
    expect(Array.isArray(rows[0]?.writtenBlocks)).toBe(true);
    expect(rows[0]?.writtenBlocks as unknown[]).not.toHaveLength(0);
  });

  it('restores what still stands as the run left it and names what somebody changed since', async () => {
    const documentId = await createPage('Obst', 'Apfel\n\nBirne\n\nPflaume');
    const runId = await createRun();
    await asRun(runId, async () => {
      await patch(documentId, requesterId, 'Birne', 'Kirsche');
      await patch(documentId, requesterId, 'Pflaume', 'Pflaumen');
    });
    // Somebody else edits one of the run's blocks afterwards.
    await patch(documentId, otherId, 'Pflaumen', 'Zwetschgen');

    const before = await runChanges.changes(runId, requesterId);
    expect(before.canRevert).toBe(true);
    expect(before.pages).toHaveLength(1);
    expect(before.changedSince).toBe(1);
    expect(before.revertible).toBeGreaterThanOrEqual(1);
    // The run replaced "Pflaume"; the replacement was reworded since, so the
    // whole change is named and left alone rather than the old block put back
    // beside the new one.
    const named = before.pages[0]?.blocks.filter((block) => block.state === 'changed_since');
    expect(named?.map((block) => block.excerpt)).toContain('Pflaume');
    // The person's rewrite has an identifier of its own; it is what the
    // undo holds back, so it is what the preview shows, not the run's text.
    expect(named?.flatMap((block) => block.standing.map((entry) => entry.excerpt))).toEqual([
      'Zwetschgen',
    ]);
    expect(named?.map((block) => block.excerpt)).not.toContain('Pflaumen');

    const result = await runChanges.revert({ runId, userId: requesterId, correlationId });
    expect(result.restored).toHaveLength(1);
    const text = await textOf(documentId);
    expect(text).toContain('Birne');
    expect(text).not.toContain('Kirsche');
    expect(text).toContain('Zwetschgen');
    expect(text).not.toMatch(/Pflaume\b/);
    expect(result.after.revertible).toBe(0);
    expect(result.after.changedSince).toBe(1);

    // A second undo has nothing left to take back and overwrites nothing.
    const again = await runChanges.revert({ runId, userId: requesterId, correlationId });
    expect(again.restored).toHaveLength(0);
    expect(await textOf(documentId)).toBe(text);
  });

  it('removes a block the run added and puts back one it removed', async () => {
    const documentId = await createPage('Liste', 'Eins\n\nZwei\n\nDrei');
    const runId = await createRun();
    await asRun(runId, async () => {
      await patch(documentId, requesterId, 'Zwei', 'Zwei\n\nNeu dazu');
      await patch(documentId, requesterId, '\n\nDrei', '');
    });
    const changed = await textOf(documentId);
    expect(changed).toContain('Neu dazu');
    expect(changed).not.toContain('Drei');

    await runChanges.revert({ runId, userId: requesterId, correlationId });
    const text = await textOf(documentId);
    expect(text).not.toContain('Neu dazu');
    expect(text).toContain('Drei');
  });

  it('lets only the person the run worked for take it back', async () => {
    const documentId = await createPage('Fremd', 'Hallo');
    const runId = await createRun();
    await asRun(runId, () => patch(documentId, requesterId, 'Hallo', 'Tschüss'));

    const seen = await runChanges.changes(runId, otherId);
    expect(seen.canRevert).toBe(false);
    await expect(
      runChanges.revert({ runId, userId: otherId, correlationId }),
    ).rejects.toMatchObject({ status: 403 });
    expect(await textOf(documentId)).toContain('Tschüss');
  });

  it('takes back a rename, a move and a new page while each stands as the run left it', async () => {
    const home = await createChild('Zuhause', null);
    const elsewhere = await createChild('Woanders', null);
    const moved = await createChild('Umzug', home);
    const renamed = await createChild('Alter Name', null);
    const runId = await createRun();
    const [fresh, edited] = await asRun(runId, async () => {
      await documents.move({
        documentId: moved,
        userId: requesterId,
        request: { parentId: elsewhere },
        correlationId,
      });
      await documents.update({
        documentId: renamed,
        userId: requesterId,
        request: { title: 'Neuer Name' },
        correlationId,
      });
      const created = await createChild('Neu von der KI', null);
      await write(created, requesterId, 'Von der KI geschrieben');
      const other = await createChild('Auch neu', null);
      await write(other, requesterId, 'Auch von der KI');
      return [created, other];
    });
    await finishRun(runId);
    // Somebody writes in one of the new pages afterwards.
    await write(edited, otherId, 'Von Hand weitergeschrieben');

    const reading = await runChanges.changes(runId, requesterId);
    const structureOf = (documentId: string) =>
      reading.pages.find((page) => page.documentId === documentId)?.structure ?? [];
    expect(structureOf(moved)).toMatchObject([
      { kind: 'moved', state: 'revertible', fromParentId: home, fromParentTitle: 'Zuhause' },
    ]);
    expect(structureOf(renamed)).toMatchObject([
      { kind: 'renamed', state: 'revertible', fromTitle: 'Alter Name', toTitle: 'Neuer Name' },
    ]);
    expect(structureOf(fresh)).toMatchObject([{ kind: 'created', state: 'revertible' }]);
    expect(structureOf(edited)).toMatchObject([
      { kind: 'created', state: 'changed_since', reason: 'edited' },
    ]);

    const result = await runChanges.revert({ runId, userId: requesterId, correlationId });
    const rows = await prisma.document.findMany({
      where: { id: { in: [moved, renamed, fresh, edited] } },
      select: { id: true, parentId: true, title: true, archivedAt: true },
    });
    const row = (id: string) => rows.find((entry) => entry.id === id);
    expect(row(moved)?.parentId).toBe(home);
    expect(row(renamed)?.title).toBe('Alter Name');
    // Into the trash, not deleted for good.
    expect(row(fresh)?.archivedAt).not.toBeNull();
    expect(row(edited)?.archivedAt).toBeNull();
    expect(result.after.revertible).toBe(0);
    expect(result.after.changedSince).toBe(1);
  });

  it('holds back a new page somebody put a page of their own under', async () => {
    const runId = await createRun();
    const created = await asRun(runId, () => createChild('Neue Sammlung', null));
    await finishRun(runId);
    await createChild('Meine Unterseite', created, otherId);

    const reading = await runChanges.changes(runId, requesterId);
    expect(reading.pages[0]?.structure).toMatchObject([
      { kind: 'created', state: 'changed_since', reason: 'children' },
    ]);
    await runChanges.revert({ runId, userId: requesterId, correlationId });
    const row = await prisma.document.findUniqueOrThrow({
      where: { id: created },
      select: { archivedAt: true },
    });
    expect(row.archivedAt).toBeNull();
  });

  it('leaves a move alone once the page stands somewhere else', async () => {
    const first = await createChild('Erster Ort', null);
    const second = await createChild('Zweiter Ort', null);
    const page = await createChild('Wandert', null);
    const runId = await createRun();
    await asRun(runId, () =>
      documents.move({
        documentId: page,
        userId: requesterId,
        request: { parentId: first },
        correlationId,
      }),
    );
    await finishRun(runId);
    await documents.move({
      documentId: page,
      userId: otherId,
      request: { parentId: second },
      correlationId,
    });

    const reading = await runChanges.changes(runId, requesterId);
    expect(reading.pages[0]?.structure).toMatchObject([
      { kind: 'moved', state: 'changed_since', reason: 'moved' },
    ]);
    expect(reading.revertible).toBe(0);
  });
});
