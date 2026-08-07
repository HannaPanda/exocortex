import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AuthorizationError, WorkspaceAccessService } from '@exocortex/auth';
import { loadDotEnv } from '@exocortex/config';
import { IMPLEMENTED_PROPERTY_TYPES } from '@exocortex/contracts';
import { createPrismaClient, type PrismaClient } from '@exocortex/database';
import { createLogger, type Logger } from '@exocortex/logger';
import { QueueRegistry, testQueuePrefix } from '@exocortex/queue';

import { AppError } from '../common/app-error';
import { OutboxService } from '../common/outbox.service';
import { DocumentsService } from '../documents/documents.service';
import { type RealtimeService } from '../realtime/realtime.service';

import { DatabasePropertiesService } from './database-properties.service';
import { DatabaseRowsService } from './database-rows.service';
import { DatabaseViewsService } from './database-views.service';

/**
 * Database schema (properties/views) and row/query-engine tests against the
 * real database, following the pattern `documents.integration.test.ts`
 * already establishes: services constructed directly, no HTTP layer.
 */
loadDotEnv();

const logger: Logger = createLogger({ name: 'api-test', level: 'silent' });

let prisma: PrismaClient;
let queues: QueueRegistry;
let documents: DocumentsService;
let properties: DatabasePropertiesService;
let views: DatabaseViewsService;
let rows: DatabaseRowsService;
let workspaceId: string;
let otherWorkspaceId: string;
let ownerId: string;
let guestId: string;

const emitted: { type: string; documentId?: string }[] = [];
const realtime = {
  emit: async (type: string, _workspaceId: string, _correlationId: string, payload: { documentId?: string }) => {
    emitted.push({ type, documentId: payload.documentId });
  },
} as unknown as RealtimeService;

const correlationId = 'db-test-correlation';

beforeAll(async () => {
  prisma = createPrismaClient({ databaseUrl: process.env.DATABASE_URL });
  queues = new QueueRegistry({
    redisUrl: process.env.REDIS_URL ?? 'redis://127.0.0.1:6380',
    logger,
    prefix: testQueuePrefix('api-databases'),
  });
  const access = new WorkspaceAccessService(prisma);
  const outbox = new OutboxService(prisma, logger);
  documents = new DocumentsService(prisma, queues, logger, access, outbox, realtime);
  properties = new DatabasePropertiesService(prisma, access, outbox, realtime);
  views = new DatabaseViewsService(prisma, access, realtime);
  rows = new DatabaseRowsService(prisma, access, documents);

  const suffix = Date.now().toString(36);
  const [owner, guest] = await Promise.all([
    prisma.user.create({
      data: { email: `db-owner-${suffix}@exocortex.test`, name: 'Owner', emailVerified: true },
    }),
    prisma.user.create({
      data: { email: `db-guest-${suffix}@exocortex.test`, name: 'Guest', emailVerified: true },
    }),
  ]);
  ownerId = owner.id;
  guestId = guest.id;

  const workspace = await prisma.workspace.create({
    data: {
      name: `Databases ${suffix}`,
      slug: `databases-${suffix}`,
      members: { create: [{ userId: ownerId, role: 'OWNER' }, { userId: guestId, role: 'GUEST' }] },
    },
  });
  workspaceId = workspace.id;

  const other = await prisma.workspace.create({
    data: { name: `Other DB ${suffix}`, slug: `other-db-${suffix}`, members: { create: { userId: ownerId, role: 'OWNER' } } },
  });
  otherWorkspaceId = other.id;
});

afterAll(async () => {
  await prisma.workspace.deleteMany({ where: { id: { in: [workspaceId, otherWorkspaceId] } } });
  await prisma.user.deleteMany({ where: { id: { in: [ownerId, guestId] } } });
  await queues.obliterateAll();
  await queues.close();
  await prisma.$disconnect();
});

async function createCollection(title: string, targetWorkspaceId = workspaceId): Promise<string> {
  const document = await documents.create({
    workspaceId: targetWorkspaceId,
    userId: ownerId,
    request: { title, type: 'COLLECTION', parentId: null },
    correlationId,
  });
  return document.id;
}

describe('database properties', () => {
  it('creates a property for every implemented type', async () => {
    const collectionId = await createCollection('Aufgaben');
    for (const type of IMPLEMENTED_PROPERTY_TYPES) {
      const property = await properties.create({
        collectionDocumentId: collectionId,
        userId: ownerId,
        request: { type, name: `Feld ${type}` },
        correlationId,
      });
      expect(property.type).toBe(type);
      expect(property.documentId).toBe(collectionId);
    }
  });

  it('rejects a reserved property type', async () => {
    const collectionId = await createCollection('Reserviert');
    await expect(
      properties.create({
        collectionDocumentId: collectionId,
        userId: ownerId,
        request: { type: 'RELATION', name: 'Verknüpfung' },
        correlationId,
      }),
    ).rejects.toMatchObject({ code: 'database_property_reserved' });
  });

  it('rejects adding a property to a plain page', async () => {
    const page = await documents.create({
      workspaceId,
      userId: ownerId,
      request: { title: 'Keine Datenbank', type: 'PAGE', parentId: null },
      correlationId,
    });
    await expect(
      properties.create({
        collectionDocumentId: page.id,
        userId: ownerId,
        request: { type: 'TEXT', name: 'Feld' },
        correlationId,
      }),
    ).rejects.toBeInstanceOf(AppError);
  });

  it('denies a guest managing the schema but allows reading it', async () => {
    const collectionId = await createCollection('Gastschutz');
    await properties.create({
      collectionDocumentId: collectionId,
      userId: ownerId,
      request: { type: 'TEXT', name: 'Titel' },
      correlationId,
    });

    await expect(
      properties.create({
        collectionDocumentId: collectionId,
        userId: guestId,
        request: { type: 'TEXT', name: 'Noch ein Feld' },
        correlationId,
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);

    const list = await properties.list(collectionId, guestId);
    expect(list).toHaveLength(1);
  });

  it('rejects a property reference from a different workspace document', async () => {
    const foreignCollectionId = await createCollection('Fremd', otherWorkspaceId);
    await expect(properties.list(foreignCollectionId, guestId)).rejects.toBeInstanceOf(AuthorizationError);
  });

  it('orders new properties after existing ones and supports reorder', async () => {
    const collectionId = await createCollection('Reihenfolge');
    const first = await properties.create({
      collectionDocumentId: collectionId,
      userId: ownerId,
      request: { type: 'TEXT', name: 'Erstes' },
      correlationId,
    });
    const second = await properties.create({
      collectionDocumentId: collectionId,
      userId: ownerId,
      request: { type: 'TEXT', name: 'Zweites' },
      correlationId,
    });
    expect(first.orderKey < second.orderKey).toBe(true);

    const reordered = await properties.reorder({
      propertyId: second.id,
      userId: ownerId,
      request: { afterPropertyId: null },
      correlationId,
    });
    const list = await properties.list(collectionId, ownerId);
    expect(list[0]?.id).toBe(reordered.id);
  });

  it('manages SELECT options', async () => {
    const collectionId = await createCollection('Status');
    const property = await properties.create({
      collectionDocumentId: collectionId,
      userId: ownerId,
      request: { type: 'SELECT', name: 'Status' },
      correlationId,
    });
    const option = await properties.createOption({
      propertyId: property.id,
      userId: ownerId,
      request: { label: 'Erledigt', color: 'green' },
      correlationId,
    });
    expect(option.color).toBe('green');

    const renamed = await properties.updateOption({
      optionId: option.id,
      userId: ownerId,
      request: { label: 'Fertig' },
      correlationId,
    });
    expect(renamed.label).toBe('Fertig');

    await properties.deleteOption({ optionId: option.id, userId: ownerId, correlationId });
    const [reloaded] = await properties.list(collectionId, ownerId);
    expect(reloaded?.options).toEqual([]);
  });

  it('audits and cascades a property deletion', async () => {
    const collectionId = await createCollection('Löschbar');
    const property = await properties.create({
      collectionDocumentId: collectionId,
      userId: ownerId,
      request: { type: 'TEXT', name: 'Weg damit' },
      correlationId,
    });

    await properties.delete({ propertyId: property.id, userId: ownerId, correlationId });

    const audited = await prisma.auditLog.findFirst({
      where: { action: 'database.property.deleted', targetId: property.id },
    });
    expect(audited).not.toBeNull();
    expect(await prisma.databaseProperty.findUnique({ where: { id: property.id } })).toBeNull();
  });
});

describe('database views', () => {
  it('creates a view of every type with empty defaults', async () => {
    const collectionId = await createCollection('Ansichten');
    for (const type of ['TABLE', 'BOARD', 'GALLERY', 'CALENDAR'] as const) {
      const view = await views.create({
        collectionDocumentId: collectionId,
        userId: ownerId,
        request: { type, name: `Ansicht ${type}` },
        correlationId,
      });
      expect(view.type).toBe(type);
      expect(view.filters).toEqual({ combinator: 'and', conditions: [] });
      expect(view.sorts).toEqual([]);
    }
  });

  it('updates filters and sorts on a view', async () => {
    const collectionId = await createCollection('Filterbar');
    const property = await properties.create({
      collectionDocumentId: collectionId,
      userId: ownerId,
      request: { type: 'CHECKBOX', name: 'Erledigt' },
      correlationId,
    });
    const view = await views.create({
      collectionDocumentId: collectionId,
      userId: ownerId,
      request: { type: 'TABLE', name: 'Offen' },
      correlationId,
    });

    const updated = await views.update({
      viewId: view.id,
      userId: ownerId,
      request: {
        filters: { combinator: 'and', conditions: [{ propertyId: property.id, operator: 'equals', value: false }] },
        sorts: [{ propertyId: property.id, direction: 'asc' }],
      },
      correlationId,
    });

    expect(updated.filters.conditions).toHaveLength(1);
    expect(updated.sorts).toEqual([{ propertyId: property.id, direction: 'asc' }]);
  });

  it('reorders views', async () => {
    const collectionId = await createCollection('View-Reihenfolge');
    const a = await views.create({
      collectionDocumentId: collectionId,
      userId: ownerId,
      request: { type: 'TABLE', name: 'A' },
      correlationId,
    });
    const b = await views.create({
      collectionDocumentId: collectionId,
      userId: ownerId,
      request: { type: 'TABLE', name: 'B' },
      correlationId,
    });
    await views.reorder({ viewId: b.id, userId: ownerId, request: { afterViewId: null }, correlationId });

    const list = await views.list(collectionId, ownerId);
    expect(list.map((entry) => entry.id)).toEqual([b.id, a.id]);
  });

  it('deletes a view', async () => {
    const collectionId = await createCollection('Löschbare Ansicht');
    const view = await views.create({
      collectionDocumentId: collectionId,
      userId: ownerId,
      request: { type: 'TABLE', name: 'Weg' },
      correlationId,
    });
    await views.delete({ viewId: view.id, userId: ownerId, correlationId });
    expect(await views.list(collectionId, ownerId)).toEqual([]);
  });

  it('denies a guest managing views', async () => {
    const collectionId = await createCollection('Gast-Views');
    await expect(
      views.create({
        collectionDocumentId: collectionId,
        userId: guestId,
        request: { type: 'TABLE', name: 'Verboten' },
        correlationId,
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });
});

describe('database rows', () => {
  async function setupTaskDatabase() {
    const collectionId = await createCollection('Aufgabenliste');
    const status = await properties.create({
      collectionDocumentId: collectionId,
      userId: ownerId,
      request: { type: 'SELECT', name: 'Status' },
      correlationId,
    });
    const done = await properties.createOption({
      propertyId: status.id,
      userId: ownerId,
      request: { label: 'Erledigt', color: 'green' },
      correlationId,
    });
    const priority = await properties.create({
      collectionDocumentId: collectionId,
      userId: ownerId,
      request: { type: 'NUMBER', name: 'Priorität' },
      correlationId,
    });
    const urgent = await properties.create({
      collectionDocumentId: collectionId,
      userId: ownerId,
      request: { type: 'CHECKBOX', name: 'Dringend' },
      correlationId,
    });
    return { collectionId, status, done, priority, urgent };
  }

  it('creates a row as a real, editable child document with its own content', async () => {
    const { collectionId, status, done } = await setupTaskDatabase();
    const row = await rows.create({
      collectionDocumentId: collectionId,
      userId: ownerId,
      request: { title: 'Rechnung schreiben', values: [{ propertyId: status.id, value: done.id }] },
      correlationId,
    });

    expect(row.document.parentId).toBe(collectionId);
    const detail = await documents.getDetail(row.document.id, ownerId);
    expect(detail.title).toBe('Rechnung schreiben');
    const content = await prisma.documentContent.findUnique({ where: { documentId: row.document.id } });
    expect(content?.yjsState.byteLength).toBeGreaterThan(0);

    const statusValue = row.values.find((value) => value.propertyId === status.id);
    expect(statusValue?.value).toBe(done.id);
  });

  it('exposes computed properties without a stored value', async () => {
    const collectionId = await createCollection('Berechnete Felder');
    const createdBy = await properties.create({
      collectionDocumentId: collectionId,
      userId: ownerId,
      request: { type: 'CREATED_BY', name: 'Erstellt von' },
      correlationId,
    });
    const row = await rows.create({
      collectionDocumentId: collectionId,
      userId: ownerId,
      request: { title: 'Zeile', values: [] },
      correlationId,
    });

    const value = row.values.find((entry) => entry.propertyId === createdBy.id);
    expect(value?.value).toBe(ownerId);
    expect(await prisma.documentPropertyValue.count({ where: { propertyId: createdBy.id } })).toBe(0);
  });

  it('rejects writing a computed property directly', async () => {
    const collectionId = await createCollection('Schreibschutz');
    const createdAt = await properties.create({
      collectionDocumentId: collectionId,
      userId: ownerId,
      request: { type: 'CREATED_TIME', name: 'Erstellt am' },
      correlationId,
    });
    const row = await rows.create({
      collectionDocumentId: collectionId,
      userId: ownerId,
      request: { title: 'Zeile', values: [] },
      correlationId,
    });

    await expect(
      rows.updateValues({
        rowId: row.document.id,
        userId: ownerId,
        request: { values: [{ propertyId: createdAt.id, value: '2026-01-01T00:00:00.000Z' }] },
        correlationId,
      }),
    ).rejects.toBeInstanceOf(AppError);
  });

  it('updates and clears row values', async () => {
    const { collectionId, priority } = await setupTaskDatabase();
    const row = await rows.create({
      collectionDocumentId: collectionId,
      userId: ownerId,
      request: { title: 'Zeile', values: [{ propertyId: priority.id, value: 3 }] },
      correlationId,
    });

    const updated = await rows.updateValues({
      rowId: row.document.id,
      userId: ownerId,
      request: { values: [{ propertyId: priority.id, value: null }] },
      correlationId,
    });
    expect(updated.values.find((entry) => entry.propertyId === priority.id)?.value).toBeNull();
  });

  it('filters rows by a SELECT value and a NUMBER comparison', async () => {
    const { collectionId, status, done, priority } = await setupTaskDatabase();
    await rows.create({
      collectionDocumentId: collectionId,
      userId: ownerId,
      request: {
        title: 'Wichtig und erledigt',
        values: [{ propertyId: status.id, value: done.id }, { propertyId: priority.id, value: 5 }],
      },
      correlationId,
    });
    await rows.create({
      collectionDocumentId: collectionId,
      userId: ownerId,
      request: { title: 'Offen', values: [{ propertyId: priority.id, value: 1 }] },
      correlationId,
    });

    const result = await rows.query({
      collectionDocumentId: collectionId,
      userId: ownerId,
      request: {
        filters: {
          combinator: 'and',
          conditions: [
            { propertyId: status.id, operator: 'equals', value: done.id },
            { propertyId: priority.id, operator: 'greater_than', value: 3 },
          ],
        },
        limit: 20,
      },
    });

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.document.title).toBe('Wichtig und erledigt');
  });

  it('sorts rows by a NUMBER property', async () => {
    const { collectionId, priority } = await setupTaskDatabase();
    await rows.create({
      collectionDocumentId: collectionId,
      userId: ownerId,
      request: { title: 'Niedrig', values: [{ propertyId: priority.id, value: 1 }] },
      correlationId,
    });
    await rows.create({
      collectionDocumentId: collectionId,
      userId: ownerId,
      request: { title: 'Hoch', values: [{ propertyId: priority.id, value: 9 }] },
      correlationId,
    });

    const result = await rows.query({
      collectionDocumentId: collectionId,
      userId: ownerId,
      request: { sorts: [{ propertyId: priority.id, direction: 'desc' }], limit: 20 },
    });

    expect(result.rows.map((row) => row.document.title)).toEqual(['Hoch', 'Niedrig']);
  });

  it('queries through a saved view', async () => {
    const { collectionId, urgent } = await setupTaskDatabase();
    await rows.create({
      collectionDocumentId: collectionId,
      userId: ownerId,
      request: { title: 'Dringend', values: [{ propertyId: urgent.id, value: true }] },
      correlationId,
    });
    await rows.create({
      collectionDocumentId: collectionId,
      userId: ownerId,
      request: { title: 'Kann warten', values: [{ propertyId: urgent.id, value: false }] },
      correlationId,
    });
    const view = await views.create({
      collectionDocumentId: collectionId,
      userId: ownerId,
      request: { type: 'TABLE', name: 'Nur dringend' },
      correlationId,
    });
    await views.update({
      viewId: view.id,
      userId: ownerId,
      request: {
        filters: { combinator: 'and', conditions: [{ propertyId: urgent.id, operator: 'equals', value: true }] },
      },
      correlationId,
    });

    const result = await rows.query({ collectionDocumentId: collectionId, userId: ownerId, request: { viewId: view.id, limit: 20 } });
    expect(result.rows.map((row) => row.document.title)).toEqual(['Dringend']);
  });

  it('paginates with a cursor', async () => {
    const collectionId = await createCollection('Viele Zeilen');
    for (let index = 0; index < 5; index += 1) {
      await rows.create({
        collectionDocumentId: collectionId,
        userId: ownerId,
        request: { title: `Zeile ${index}`, values: [] },
        correlationId,
      });
    }

    const firstPage = await rows.query({ collectionDocumentId: collectionId, userId: ownerId, request: { limit: 2 } });
    expect(firstPage.rows).toHaveLength(2);
    expect(firstPage.nextCursor).not.toBeNull();

    const secondPage = await rows.query({
      collectionDocumentId: collectionId,
      userId: ownerId,
      request: { limit: 2, cursor: firstPage.nextCursor ?? undefined },
    });
    expect(secondPage.rows).toHaveLength(2);
    expect(secondPage.rows[0]?.document.id).not.toBe(firstPage.rows[0]?.document.id);
  });

  it('rejects a filter that references a property from a different collection', async () => {
    const { collectionId } = await setupTaskDatabase();
    const otherCollectionId = await createCollection('Andere Datenbank');
    const otherProperty = await properties.create({
      collectionDocumentId: otherCollectionId,
      userId: ownerId,
      request: { type: 'TEXT', name: 'Fremdes Feld' },
      correlationId,
    });

    await expect(
      rows.query({
        collectionDocumentId: collectionId,
        userId: ownerId,
        request: {
          filters: { combinator: 'and', conditions: [{ propertyId: otherProperty.id, operator: 'is_empty' }] },
          limit: 20,
        },
      }),
    ).rejects.toBeInstanceOf(AppError);
  });

  it('never returns rows from another workspace', async () => {
    const foreignCollectionId = await createCollection('Fremdes Board', otherWorkspaceId);
    await rows.create({
      collectionDocumentId: foreignCollectionId,
      userId: ownerId,
      request: { title: 'Fremde Zeile', values: [] },
      correlationId,
    });

    await expect(rows.query({ collectionDocumentId: foreignCollectionId, userId: guestId, request: { limit: 20 } })).rejects.toBeInstanceOf(
      AuthorizationError,
    );
  });
});
