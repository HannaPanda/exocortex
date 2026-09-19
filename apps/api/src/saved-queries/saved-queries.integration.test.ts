import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AuthorizationError, WorkspaceAccessService } from '@exocortex/auth';
import { loadDotEnv } from '@exocortex/config';
import { createPrismaClient, PostgresSearchAdapter, type PrismaClient } from '@exocortex/database';
import { createLogger, type Logger } from '@exocortex/logger';
import { QueueRegistry, testQueuePrefix } from '@exocortex/queue';
import { type ObjectStorage } from '@exocortex/storage';

import { AppError } from '../common/app-error';
import { OutboxService } from '../common/outbox.service';
import { DocumentMoveService } from '../documents/document-move.service';
import { DocumentTrashService } from '../documents/document-trash.service';
import { DocumentsService } from '../documents/documents.service';
import { type RealtimeService } from '../realtime/realtime.service';

import { SavedQueriesService } from './saved-queries.service';

/**
 * Saved queries against the real database (issue #74, ADR-042).
 *
 * What is worth proving here is the half that no unit test can: that the
 * structural predicate really is SQL over the live tree, and that a stored
 * question keeps moving. Moving a page into a saved subtree has to change the
 * answer without anybody editing the query, and that only shows up against a
 * database.
 *
 * The text half is deliberately not exercised. Filling `document_search_index`
 * needs the worker, and what the words do is already pinned in
 * `packages/database/src/saved-query.test.ts` with a fake adapter.
 */
loadDotEnv();

const logger: Logger = createLogger({ name: 'api-test', level: 'silent' });
const correlationId = 'test-correlation';

let prisma: PrismaClient;
let queues: QueueRegistry;
let documents: DocumentsService;
let savedQueries: SavedQueriesService;
let workspaceId: string;
let ownerId: string;
let strangerId: string;

const realtime = { emit: async () => undefined } as unknown as RealtimeService;
const storage = { deleteObject: async () => undefined } as unknown as ObjectStorage;

beforeAll(async () => {
  prisma = createPrismaClient({ databaseUrl: process.env.DATABASE_URL });
  queues = new QueueRegistry({
    redisUrl: process.env.REDIS_URL ?? 'redis://127.0.0.1:6380',
    logger,
    prefix: testQueuePrefix('api-saved-queries'),
  });
  const access = new WorkspaceAccessService(prisma);
  const outbox = new OutboxService(prisma, logger);
  documents = new DocumentsService(
    prisma,
    queues,
    logger,
    storage,
    access,
    outbox,
    realtime,
    new DocumentTrashService(prisma, queues, logger, storage, access, outbox, realtime),
    new DocumentMoveService(prisma, queues, logger, access, outbox, realtime),
  );
  // The keyword adapter on both sides: a test must never reach a model, and
  // the text half is covered by the unit test with a fake adapter.
  const adapter = new PostgresSearchAdapter(prisma);
  savedQueries = new SavedQueriesService(prisma, adapter, adapter, access, realtime);

  const suffix = Date.now().toString(36);
  const owner = await prisma.user.create({
    data: { email: `sq-${suffix}@exocortex.test`, name: 'Owner', emailVerified: true },
  });
  ownerId = owner.id;
  const stranger = await prisma.user.create({
    data: { email: `sq-out-${suffix}@exocortex.test`, name: 'Stranger', emailVerified: true },
  });
  strangerId = stranger.id;
  const workspace = await prisma.workspace.create({
    data: {
      name: `Saved queries ${suffix}`,
      slug: `saved-queries-${suffix}`,
      members: { create: { userId: ownerId, role: 'OWNER' } },
    },
  });
  workspaceId = workspace.id;
});

afterAll(async () => {
  await prisma.savedQuery.deleteMany({ where: { workspaceId } });
  await prisma.workspace.deleteMany({ where: { id: workspaceId } });
  await prisma.user.deleteMany({ where: { id: { in: [ownerId, strangerId] } } });
  await queues.obliterateAll();
  await queues.close();
  await prisma.$disconnect();
});

async function createPage(title: string, parentId: string | null = null): Promise<string> {
  const page = await documents.create({
    workspaceId,
    userId: ownerId,
    request: { title, type: 'PAGE', parentId },
    correlationId,
  });
  return page.id;
}

async function save(name: string, definition: Record<string, unknown>): Promise<string> {
  const response = await savedQueries.create({
    workspaceId,
    userId: ownerId,
    request: {
      name,
      definition: {
        text: null,
        textMode: 'HYBRID',
        types: [],
        underDocumentId: null,
        collectionId: null,
        propertyFilter: null,
        entityIds: [],
        entityMatch: 'ANY',
        updated: { withinDays: null, after: null, before: null },
        created: { withinDays: null, after: null, before: null },
        includeArchived: false,
        sort: 'UPDATED_DESC',
        limit: 25,
        ...definition,
      } as never,
    },
    correlationId,
  });
  return response.savedQuery.id;
}

async function titlesOf(savedQueryId: string): Promise<string[]> {
  const result = await savedQueries.run({ savedQueryId, userId: ownerId });
  return result.results.map((hit) => hit.title);
}

describe('a saved query answers the structural half against the live tree', () => {
  it('follows a subtree that changes after the query was saved', async () => {
    const root = await createPage('Projekte');
    const inside = await createPage('Angebot', root);
    const outside = await createPage('Privates');

    const savedQueryId = await save('Alles unter Projekte', {
      underDocumentId: root,
      sort: 'TITLE_ASC',
    });
    expect(await titlesOf(savedQueryId)).toEqual(['Angebot', 'Projekte']);

    // Nobody edits the query: the page moves, and the answer moves with it.
    await documents.move({
      documentId: outside,
      userId: ownerId,
      request: { parentId: root },
      correlationId,
    });
    expect(await titlesOf(savedQueryId)).toEqual(['Angebot', 'Privates', 'Projekte']);

    await documents.move({
      documentId: inside,
      userId: ownerId,
      request: { parentId: null },
      correlationId,
    });
    expect(await titlesOf(savedQueryId)).toEqual(['Privates', 'Projekte']);
  });

  it('hides archived pages unless the query asks for them', async () => {
    const root = await createPage('Ablage');
    const gone = await createPage('Alter Kram', root);

    const plain = await save('Ablage', { underDocumentId: root, sort: 'TITLE_ASC' });
    const withTrash = await save('Ablage mit Papierkorb', {
      underDocumentId: root,
      includeArchived: true,
      sort: 'TITLE_ASC',
    });
    expect(await titlesOf(plain)).toContain('Alter Kram');

    await documents.archive({ documentId: gone, userId: ownerId, correlationId });

    expect(await titlesOf(plain)).not.toContain('Alter Kram');
    expect(await titlesOf(withTrash)).toContain('Alter Kram');
  });

  it('filters by type and says when the limit cut the answer short', async () => {
    const root = await createPage('Sammlung');
    await createPage('Seite A', root);
    await createPage('Seite B', root);
    await documents.create({
      workspaceId,
      userId: ownerId,
      request: { title: 'Datenbank', type: 'COLLECTION', parentId: root },
      correlationId,
    });

    const onlyPages = await save('Nur Seiten', {
      underDocumentId: root,
      types: ['PAGE'],
      sort: 'TITLE_ASC',
    });
    expect(await titlesOf(onlyPages)).toEqual(['Sammlung', 'Seite A', 'Seite B']);

    const capped = await save('Gekappt', {
      underDocumentId: root,
      types: ['PAGE'],
      sort: 'TITLE_ASC',
      limit: 2,
    });
    const result = await savedQueries.run({ savedQueryId: capped, userId: ownerId });
    expect(result.results).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });

  it('counts a relative window back from now rather than from the save', async () => {
    const root = await createPage('Frisch');
    await createPage('Heute angelegt', root);

    const recent = await save('Letzte Woche', {
      underDocumentId: root,
      created: { withinDays: 7, after: null, before: null },
    });
    expect(await titlesOf(recent)).toContain('Heute angelegt');

    const ancient = await save('Vor langer Zeit', {
      underDocumentId: root,
      created: { withinDays: null, after: null, before: '2020-01-01T00:00:00.000Z' },
    });
    expect(await titlesOf(ancient)).toEqual([]);
  });
});

describe('a saved query is a question, not a permission', () => {
  it('refuses to answer for somebody who is not a member', async () => {
    const savedQueryId = await save('Alles', { sort: 'TITLE_ASC' });
    await expect(savedQueries.run({ savedQueryId, userId: strangerId })).rejects.toThrow(
      AuthorizationError,
    );
  });

  it('refuses a definition naming a page from another workspace', async () => {
    const otherWorkspace = await prisma.workspace.create({
      data: {
        name: `Fremd ${Date.now().toString(36)}`,
        slug: `fremd-${Date.now().toString(36)}`,
        members: { create: { userId: strangerId, role: 'OWNER' } },
      },
    });
    const foreign = await prisma.document.create({
      data: {
        workspaceId: otherWorkspace.id,
        title: 'Fremde Seite',
        orderKey: 'a1',
        createdById: strangerId,
        updatedById: strangerId,
      },
    });

    await expect(save('Fremd', { underDocumentId: foreign.id })).rejects.toThrow(AppError);

    await prisma.workspace.delete({ where: { id: otherWorkspace.id } });
  });
});

describe('the list and the navigation order', () => {
  it('puts the smart views first and keeps them in the order they were given', async () => {
    const first = await save('View eins', {});
    const second = await save('View zwei', {});
    for (const savedQueryId of [first, second]) {
      await savedQueries.update({
        savedQueryId,
        userId: ownerId,
        request: { inSidebar: true },
        correlationId,
      });
    }

    await savedQueries.reorder({
      savedQueryId: second,
      userId: ownerId,
      request: { beforeId: first },
      correlationId,
    });

    const listed = await savedQueries.list({ workspaceId, userId: ownerId });
    const sidebar = listed.savedQueries.filter((entry) => entry.inSidebar).map((e) => e.name);
    expect(sidebar.indexOf('View zwei')).toBeLessThan(sidebar.indexOf('View eins'));
  });

  it('deletes the question and leaves every page it found alone', async () => {
    const root = await createPage('Bleibt');
    const savedQueryId = await save('Weg damit', { underDocumentId: root });

    await savedQueries.remove({ savedQueryId, userId: ownerId, correlationId });

    await expect(savedQueries.get({ savedQueryId, userId: ownerId })).rejects.toThrow(AppError);
    const page = await prisma.document.findUnique({ where: { id: root } });
    expect(page?.archivedAt).toBeNull();
  });
});
