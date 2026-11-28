import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AuthorizationError, WorkspaceAccessService } from '@exocortex/auth';
import { loadDotEnv } from '@exocortex/config';
import {
  createPrismaClient,
  findUnreferencedPropertyFiles,
  type PrismaClient,
} from '@exocortex/database';
import { createLogger, type Logger } from '@exocortex/logger';
import { QueueRegistry, testQueuePrefix } from '@exocortex/queue';
import { type ObjectStorage } from '@exocortex/storage';

import { CellFileCopyService } from '../attachments/cell-file-copy.service';
import { MemoryStorage, seedCellFile } from '../attachments/memory-storage.test-support';
import { OutboxService } from '../common/outbox.service';
import { DocumentMoveService } from '../documents/document-move.service';
import { DocumentTrashService } from '../documents/document-trash.service';
import { DocumentsService } from '../documents/documents.service';
import { type RealtimeService } from '../realtime/realtime.service';

import { DatabasePropertiesService } from './database-properties.service';
import { DatabaseRowActionsService } from './database-row-actions.service';
import { DatabaseRowsService } from './database-rows.service';

/**
 * Acting on several rows at once (issue #244): one set of values for a
 * selection, the selection into the trash, a copy of each row below it.
 */
loadDotEnv();

const logger: Logger = createLogger({ name: 'api-test', level: 'silent' });
const noopStorage = {} as unknown as ObjectStorage;
const storage = new MemoryStorage();
const correlationId = 'row-batch-test';

let prisma: PrismaClient;
let queues: QueueRegistry;
let documents: DocumentsService;
let properties: DatabasePropertiesService;
let rows: DatabaseRowsService;
let actions: DatabaseRowActionsService;
let workspaceId: string;
let ownerId: string;
let guestId: string;

const emitted: { type: string; rowId?: string }[] = [];
const realtime = {
  emit: async (type: string, _ws: string, _corr: string, payload: { rowId?: string }) => {
    emitted.push({ type, rowId: payload.rowId });
  },
} as unknown as RealtimeService;

beforeAll(async () => {
  prisma = createPrismaClient({ databaseUrl: process.env.DATABASE_URL });
  queues = new QueueRegistry({
    redisUrl: process.env.REDIS_URL ?? 'redis://127.0.0.1:6380',
    logger,
    prefix: testQueuePrefix('api-row-batch'),
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
  properties = new DatabasePropertiesService(prisma, access, outbox, realtime);
  rows = new DatabaseRowsService(prisma, access, documents, outbox, realtime);
  actions = new DatabaseRowActionsService(
    prisma,
    rows,
    documents,
    outbox,
    new CellFileCopyService(prisma, storage, queues, logger),
  );

  const suffix = Date.now().toString(36);
  const [owner, guest] = await Promise.all([
    prisma.user.create({
      data: { email: `batch-owner-${suffix}@exocortex.test`, name: 'Owner', emailVerified: true },
    }),
    prisma.user.create({
      data: { email: `batch-guest-${suffix}@exocortex.test`, name: 'Guest', emailVerified: true },
    }),
  ]);
  ownerId = owner.id;
  guestId = guest.id;
  const workspace = await prisma.workspace.create({
    data: {
      name: `Row batch ${suffix}`,
      slug: `row-batch-${suffix}`,
      members: {
        create: [
          { userId: ownerId, role: 'OWNER' },
          { userId: guestId, role: 'GUEST' },
        ],
      },
    },
  });
  workspaceId = workspace.id;
});

afterAll(async () => {
  await prisma.workspace.deleteMany({ where: { id: workspaceId } });
  await prisma.user.deleteMany({ where: { id: { in: [ownerId, guestId] } } });
  await queues.obliterateAll();
  await queues.close();
  await prisma.$disconnect();
});

async function database(): Promise<{ id: string; status: string; note: string }> {
  const collection = await documents.create({
    workspaceId,
    userId: ownerId,
    request: { title: 'Aufgaben', type: 'COLLECTION', parentId: null },
    correlationId,
  });
  const status = await properties.create({
    collectionDocumentId: collection.id,
    userId: ownerId,
    request: { type: 'CHECKBOX', name: 'Erledigt' },
    correlationId,
  });
  const note = await properties.create({
    collectionDocumentId: collection.id,
    userId: ownerId,
    request: { type: 'TEXT', name: 'Notiz' },
    correlationId,
  });
  return { id: collection.id, status: status.id, note: note.id };
}

async function row(collectionId: string, title: string, noteId?: string): Promise<string> {
  const created = await rows.create({
    collectionDocumentId: collectionId,
    userId: ownerId,
    request: {
      title,
      values: noteId === undefined ? [] : [{ propertyId: noteId, value: `${title} Notiz` }],
    },
    correlationId,
  });
  return created.document.id;
}

function valueOf(
  answer: { values: { propertyId: string; value: unknown }[] },
  propertyId: string,
): unknown {
  return answer.values.find((entry) => entry.propertyId === propertyId)?.value ?? null;
}

describe('updateMany', () => {
  it('writes the same values into every named row, one outbox event per row', async () => {
    const db = await database();
    const ids = [await row(db.id, 'A'), await row(db.id, 'B'), await row(db.id, 'C')];
    emitted.length = 0;

    const result = await rows.updateMany({
      collectionDocumentId: db.id,
      userId: ownerId,
      request: { rowIds: ids.slice(0, 2), values: [{ propertyId: db.status, value: true }] },
      correlationId,
    });

    expect(result.rows.map((entry) => entry.document.id)).toEqual(ids.slice(0, 2));
    for (const entry of result.rows) expect(valueOf(entry, db.status)).toBe(true);
    const untouched = await rows.getForDocument(ids[2]!, ownerId);
    expect(valueOf(untouched!, db.status)).toBeNull();

    const events = await prisma.outboxEvent.findMany({
      where: {
        workspaceId,
        type: 'database.row.updated',
        payload: { path: ['documentId'], equals: db.id },
      },
    });
    const eventRows = events.map((event) => (event.payload as { rowId: string }).rowId);
    expect(eventRows).toEqual(expect.arrayContaining(ids.slice(0, 2)));
    expect(emitted.filter((entry) => entry.type === 'database.row.updated')).toHaveLength(2);
  });

  it('changes nothing when one of the rows belongs elsewhere', async () => {
    const db = await database();
    const other = await database();
    const mine = await row(db.id, 'Meine');
    const foreign = await row(other.id, 'Fremde');

    await expect(
      rows.updateMany({
        collectionDocumentId: db.id,
        userId: ownerId,
        request: { rowIds: [mine, foreign], values: [{ propertyId: db.status, value: true }] },
        correlationId,
      }),
    ).rejects.toMatchObject({ code: 'database_rows_not_found', details: { rowIds: [foreign] } });
    expect(valueOf((await rows.getForDocument(mine, ownerId))!, db.status)).toBeNull();
  });

  it('refuses a reader before writing anything', async () => {
    const db = await database();
    const id = await row(db.id, 'Nur lesen');
    await expect(
      rows.updateMany({
        collectionDocumentId: db.id,
        userId: guestId,
        request: { rowIds: [id], values: [{ propertyId: db.status, value: true }] },
        correlationId,
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });
});

describe('trash', () => {
  it('archives every row, and each comes back on its own', async () => {
    const db = await database();
    const ids = [await row(db.id, 'Weg 1'), await row(db.id, 'Weg 2'), await row(db.id, 'Bleibt')];

    const result = await actions.trash({
      collectionDocumentId: db.id,
      userId: ownerId,
      request: { rowIds: ids.slice(0, 2) },
      correlationId,
    });
    expect(result.archived.map((entry) => entry.id).sort()).toEqual(ids.slice(0, 2).sort());

    const listed = await rows.query({
      collectionDocumentId: db.id,
      userId: ownerId,
      request: { limit: 50 },
    });
    expect(listed.rows.map((entry) => entry.document.id)).toEqual([ids[2]]);

    await documents.restore({ documentId: ids[0]!, userId: ownerId, correlationId });
    const again = await rows.query({
      collectionDocumentId: db.id,
      userId: ownerId,
      request: { limit: 50 },
    });
    expect(again.rows).toHaveLength(2);
  });

  it('refuses a row that is already in the trash, and moves none of the others', async () => {
    const db = await database();
    const gone = await row(db.id, 'Schon weg');
    const live = await row(db.id, 'Noch da');
    await documents.archive({ documentId: gone, userId: ownerId, correlationId });

    await expect(
      actions.trash({
        collectionDocumentId: db.id,
        userId: ownerId,
        request: { rowIds: [live, gone] },
        correlationId,
      }),
    ).rejects.toMatchObject({ code: 'database_rows_not_found' });
    const still = await prisma.document.findUniqueOrThrow({ where: { id: live } });
    expect(still.archivedAt).toBeNull();
  });

  it('refuses a reader', async () => {
    const db = await database();
    const id = await row(db.id, 'Geschützt');
    await expect(
      actions.trash({
        collectionDocumentId: db.id,
        userId: guestId,
        request: { rowIds: [id] },
        correlationId,
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });
});

describe('duplicate', () => {
  it('puts a copy with the same title and values directly below each row', async () => {
    const db = await database();
    const first = await row(db.id, 'Erste', db.note);
    const second = await row(db.id, 'Zweite', db.note);
    const third = await row(db.id, 'Dritte', db.note);

    const result = await actions.duplicate({
      collectionDocumentId: db.id,
      userId: ownerId,
      request: { rowIds: [first, third] },
      correlationId,
    });

    expect(result.rows.map((entry) => entry.document.title)).toEqual(['Erste', 'Dritte']);
    expect(result.rows.map((entry) => valueOf(entry, db.note))).toEqual([
      'Erste Notiz',
      'Dritte Notiz',
    ]);
    const [firstCopy, thirdCopy] = result.rows.map((entry) => entry.document.id);
    expect(firstCopy).not.toBe(first);

    const order = await prisma.document.findMany({
      where: { parentId: db.id, archivedAt: null },
      orderBy: [{ orderKey: 'asc' }, { id: 'asc' }],
      select: { id: true },
    });
    expect(order.map((entry) => entry.id)).toEqual([first, firstCopy, second, third, thirdCopy]);

    // A copy is its own row: changing it leaves the original alone.
    await rows.updateValues({
      rowId: firstCopy!,
      userId: ownerId,
      request: { values: [{ propertyId: db.note, value: 'geändert' }] },
      correlationId,
    });
    expect(valueOf((await rows.getForDocument(first, ownerId))!, db.note)).toBe('Erste Notiz');
  });

  it('gives each copy its own cell files, so emptying the source leaves it alone (issue #316)', async () => {
    const db = await database();
    const column = await properties.create({
      collectionDocumentId: db.id,
      userId: ownerId,
      request: { type: 'FILES', name: 'Belege' },
      correlationId,
    });
    const source = await row(db.id, 'Mit Dateien');
    const read = await seedCellFile(prisma, storage, {
      workspaceId,
      rowId: source,
      propertyId: column.id,
      createdById: ownerId,
      filename: 'gelesen.pdf',
      mimeType: 'application/pdf',
      body: Buffer.from('%PDF gelesen'),
      extension: 'pdf',
      text: { textStatus: 'READY', extractedText: 'schon gelesen', screening: 'CLEAN' },
    });
    const reading = await seedCellFile(prisma, storage, {
      workspaceId,
      rowId: source,
      propertyId: column.id,
      createdById: ownerId,
      filename: 'wird-gelesen.pdf',
      mimeType: 'application/pdf',
      body: Buffer.from('%PDF wird gelesen'),
      extension: 'pdf',
      text: { textStatus: 'PENDING' },
    });
    await prisma.documentPropertyValue.create({
      data: { documentId: source, propertyId: column.id, jsonValue: [read.id, reading.id] },
    });

    const result = await actions.duplicate({
      collectionDocumentId: db.id,
      userId: ownerId,
      request: { rowIds: [source] },
      correlationId,
    });
    const copyRow = result.rows[0]!.document.id;
    expect(result.copiedFiles.map((file) => [file.rowId, file.sourceAttachmentId])).toEqual([
      [copyRow, read.id],
      [copyRow, reading.id],
    ]);
    const copyIds = result.copiedFiles.map((file) => file.attachmentId);
    // The row in the answer already names the copies, by name too.
    expect(valueOf(result.rows[0]!, column.id)).toEqual(copyIds);
    expect(result.rows[0]!.files?.map((file) => file.filename)).toEqual([
      'gelesen.pdf',
      'wird-gelesen.pdf',
    ]);

    const copies = await prisma.attachment.findMany({ where: { id: { in: copyIds } } });
    const byName = new Map(copies.map((copy) => [copy.filename, copy]));
    expect(byName.get('gelesen.pdf')).toMatchObject({
      documentId: copyRow,
      propertyId: column.id,
      textStatus: 'READY',
      extractedText: 'schon gelesen',
      screening: 'CLEAN',
    });
    // A file still being read is read again for the copy, not copied half-done.
    expect(byName.get('wird-gelesen.pdf')).toMatchObject({
      textStatus: 'PENDING',
      extractedText: null,
    });

    await rows.updateValues({
      rowId: source,
      userId: ownerId,
      request: { values: [{ propertyId: column.id, value: [reading.id] }] },
      correlationId,
    });
    const unnamed = await findUnreferencedPropertyFiles(prisma, {
      before: new Date(Date.now() + 60_000),
      workspaceId,
      limit: 100,
    });
    expect(unnamed.map((file) => file.id)).toEqual([read.id]);
  });

  it('refuses a reader, who may not create rows', async () => {
    const db = await database();
    const id = await row(db.id, 'Vorlage');
    await expect(
      actions.duplicate({
        collectionDocumentId: db.id,
        userId: guestId,
        request: { rowIds: [id] },
        correlationId,
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });
});
