import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadWorkerEnv } from '@exocortex/config';
import { createPrismaClient, generateOrderKey, type PrismaClient } from '@exocortex/database';
import { createLogger, type Logger } from '@exocortex/logger';

import { describeCollection } from './collection-context';

/**
 * `describeCollection` against real PostgreSQL.
 *
 * It is deliberately not unit-tested behind a fake Prisma: the whole point of
 * this function is that it runs the *same* filters and sorts through the *same*
 * query engine the table on screen uses, and a fake would let the description
 * and the screen drift apart without any test noticing.
 */
const env = loadWorkerEnv();
const logger: Logger = createLogger({ name: 'collection-context-test', level: 'silent' });

let prisma: PrismaClient;
let workspaceId: string;
let userId: string;
let collectionId: string;
let statusPropertyId: string;
let duePropertyId: string;
let openOptionId: string;
let doneOptionId: string;
let openViewId: string;
let allViewId: string;

beforeAll(async () => {
  prisma = createPrismaClient({ databaseUrl: env.DATABASE_URL });

  const suffix = Date.now().toString(36);
  const user = await prisma.user.create({
    data: { email: `collection-${suffix}@exocortex.test`, name: 'Collection Test', emailVerified: true },
  });
  userId = user.id;
  const workspace = await prisma.workspace.create({
    data: {
      name: `Collection ${suffix}`,
      slug: `collection-${suffix}`,
      members: { create: { userId, role: 'OWNER' } },
    },
  });
  workspaceId = workspace.id;

  const collection = await prisma.document.create({
    data: {
      workspaceId,
      title: 'Aufgaben',
      type: 'COLLECTION',
      orderKey: generateOrderKey(null, null),
      createdById: userId,
      updatedById: userId,
    },
  });
  collectionId = collection.id;

  const status = await prisma.databaseProperty.create({
    data: {
      documentId: collectionId,
      type: 'SELECT',
      name: 'Status',
      orderKey: 'a0',
      options: {
        create: [
          { label: 'Offen', color: 'blue', orderKey: 'a0' },
          { label: 'Erledigt', color: 'green', orderKey: 'a1' },
        ],
      },
    },
    include: { options: { orderBy: { orderKey: 'asc' } } },
  });
  statusPropertyId = status.id;
  openOptionId = status.options[0]?.id ?? '';
  doneOptionId = status.options[1]?.id ?? '';

  const due = await prisma.databaseProperty.create({
    data: { documentId: collectionId, type: 'DATE', name: 'Fällig', orderKey: 'a1' },
  });
  duePropertyId = due.id;

  const openView = await prisma.databaseView.create({
    data: {
      documentId: collectionId,
      type: 'TABLE',
      name: 'Offen',
      orderKey: 'a0',
      filters: {
        combinator: 'and',
        conditions: [{ propertyId: statusPropertyId, operator: 'equals', value: openOptionId }],
      },
      sorts: [{ propertyId: duePropertyId, direction: 'asc' }],
    },
  });
  openViewId = openView.id;

  const allView = await prisma.databaseView.create({
    data: {
      documentId: collectionId,
      type: 'BOARD',
      name: 'Alle',
      orderKey: 'a1',
      filters: { combinator: 'and', conditions: [] },
      sorts: [],
      groupByPropertyId: statusPropertyId,
    },
  });
  allViewId = allView.id;

  const rows: { title: string; status: string; due: string }[] = [
    { title: 'Steuererklärung', status: openOptionId, due: '2026-09-01' },
    { title: 'Rechnung schreiben', status: openOptionId, due: '2026-08-20' },
    { title: 'Kaffee gekauft', status: doneOptionId, due: '2026-08-01' },
  ];
  let previousKey: string | null = null;
  for (const row of rows) {
    const orderKey: string = generateOrderKey(previousKey, null);
    previousKey = orderKey;
    await prisma.document.create({
      data: {
        workspaceId,
        parentId: collectionId,
        title: row.title,
        type: 'PAGE',
        orderKey,
        createdById: userId,
        updatedById: userId,
        propertyValues: {
          create: [
            { propertyId: statusPropertyId, textValue: row.status },
            { propertyId: duePropertyId, dateValue: new Date(row.due) },
          ],
        },
      },
    });
  }
}, 60_000);

afterAll(async () => {
  await prisma.workspace.deleteMany({ where: { id: workspaceId } });
  await prisma.user.deleteMany({ where: { id: userId } });
  await prisma.$disconnect();
});

describe('describeCollection', () => {
  it('names the columns with their types and their selectable options', async () => {
    const description = await describeCollection({
      prisma,
      workspaceId,
      documentId: collectionId,
      viewId: openViewId,
      logger,
    });

    expect(description).toContain('- Status (Auswahl: Offen, Erledigt)');
    expect(description).toContain('- Fällig (Datum)');
  });

  it('describes the open view, resolving option ids to their labels', async () => {
    const description = await describeCollection({
      prisma,
      workspaceId,
      documentId: collectionId,
      viewId: openViewId,
      logger,
    });

    expect(description).toContain('Offene Ansicht „Offen“ (Tabelle)');
    expect(description).toContain('Filter: Status ist „Offen“');
    expect(description).toContain('Sortierung: Fällig aufsteigend');
    // The raw id would be unusable for the model and meaningless to the user.
    expect(description).not.toContain(openOptionId);
  });

  it('shows the rows that view actually produces, in that view order', async () => {
    const description = await describeCollection({
      prisma,
      workspaceId,
      documentId: collectionId,
      viewId: openViewId,
      logger,
    });

    expect(description).toContain('Rechnung schreiben');
    expect(description).toContain('Steuererklärung');
    // Filtered out by the view, so it must not appear.
    expect(description).not.toContain('Kaffee gekauft');
    // Sorted by due date ascending.
    expect(description?.indexOf('Rechnung schreiben')).toBeLessThan(
      description?.indexOf('Steuererklärung') ?? -1,
    );
    expect(description).toContain('2026-08-20');
  });

  it('describes a different view differently, which is the whole point', async () => {
    const description = await describeCollection({
      prisma,
      workspaceId,
      documentId: collectionId,
      viewId: allViewId,
      logger,
    });

    expect(description).toContain('Offene Ansicht „Alle“ (Board)');
    expect(description).toContain('Filter: keiner');
    expect(description).toContain('Gruppiert nach: Status');
    expect(description).toContain('Kaffee gekauft');
  });

  it('falls back to the first view when none is named, the way the UI does', async () => {
    const description = await describeCollection({
      prisma,
      workspaceId,
      documentId: collectionId,
      viewId: null,
      logger,
    });

    expect(description).toContain('Offene Ansicht „Offen“');
  });

  it('falls back to the first view when the named one no longer exists', async () => {
    const description = await describeCollection({
      prisma,
      workspaceId,
      documentId: collectionId,
      viewId: 'a-view-that-was-deleted',
      logger,
    });

    expect(description).toContain('Offene Ansicht „Offen“');
  });

  it('returns nothing for a document that is not a database', async () => {
    const page = await prisma.document.create({
      data: {
        workspaceId,
        title: 'Gewöhnliche Seite',
        orderKey: generateOrderKey(null, null),
        createdById: userId,
        updatedById: userId,
      },
    });

    expect(
      await describeCollection({ prisma, workspaceId, documentId: page.id, viewId: null, logger }),
    ).toBeNull();
  });

  it('degrades to columns and view instead of failing when a filter is unusable', async () => {
    const broken = await prisma.databaseView.create({
      data: {
        documentId: collectionId,
        type: 'TABLE',
        name: 'Kaputt',
        orderKey: 'a2',
        filters: {
          combinator: 'and',
          conditions: [{ propertyId: 'not-a-property-of-this-database', operator: 'equals', value: 'x' }],
        },
        sorts: [],
      },
    });

    const description = await describeCollection({
      prisma,
      workspaceId,
      documentId: collectionId,
      viewId: broken.id,
      logger,
    });

    expect(description).toContain('- Status (Auswahl');
    expect(description).toContain('Offene Ansicht „Kaputt“');
    // The query engine rejects the unknown property; the sample is dropped, the
    // rest of the description survives.
    expect(description).not.toContain('### Zeilen');

    await prisma.databaseView.delete({ where: { id: broken.id } });
  });
});
