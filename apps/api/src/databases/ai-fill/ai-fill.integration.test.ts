import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { WorkspaceAccessService } from '@exocortex/auth';
import { loadDotEnv } from '@exocortex/config';
import { type Settings, settingsSchema } from '@exocortex/contracts';
import { createPrismaClient, type PrismaClient } from '@exocortex/database';
import { createLogger, type Logger } from '@exocortex/logger';
import { QueueRegistry, testQueuePrefix } from '@exocortex/queue';
import { type ObjectStorage } from '@exocortex/storage';

import { type AiModelResolverService } from '../../ai/ai-model-resolver.service';
import { AppError } from '../../common/app-error';
import { runWithRequestContext } from '../../common/correlation';
import { OutboxService } from '../../common/outbox.service';
import { DocumentMoveService } from '../../documents/document-move.service';
import { DocumentTrashService } from '../../documents/document-trash.service';
import { DocumentsService } from '../../documents/documents.service';
import { type SettingsService } from '../../platform/settings.service';
import { type RealtimeService } from '../../realtime/realtime.service';
import { DatabasePropertiesService } from '../database-properties.service';
import { DatabaseRowsService } from '../database-rows.service';

import { AiFillService } from './ai-fill.service';
import { AiFillConfigService } from './ai-fill-config.service';
import { AiFillWorkerService } from './ai-fill-worker.service';

/**
 * A column filled by its AI instruction (issue #237, ADR-099), through the
 * API half: the instruction, which cells a batch takes, the two worker
 * routes, the marks a row carries afterwards. The model is not called here;
 * the worker's half is the answer it posts.
 */
loadDotEnv();

const logger: Logger = createLogger({ name: 'api-test', level: 'silent' });
const noopStorage = {} as unknown as ObjectStorage;
const correlationId = 'ai-fill-test';

let prisma: PrismaClient;
let queues: QueueRegistry;
let documents: DocumentsService;
let properties: DatabasePropertiesService;
let rows: DatabaseRowsService;
let config: AiFillConfigService;
let fills: AiFillService;
let worker: AiFillWorkerService;
let workspaceId: string;
let ownerId: string;
let readerId: string;
let settingsValue: Settings;

const realtime = { emit: async () => undefined } as unknown as RealtimeService;

beforeAll(async () => {
  prisma = createPrismaClient({ databaseUrl: process.env.DATABASE_URL });
  queues = new QueueRegistry({
    redisUrl: process.env.REDIS_URL ?? 'redis://127.0.0.1:6380',
    logger,
    prefix: testQueuePrefix('api-ai-fill'),
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
  settingsValue = settingsSchema.parse({});
  const settings = {
    getForWorkspace: async () => settingsValue,
  } as unknown as SettingsService;
  const models = {
    resolveDefault: async () => ({ slug: 'mock/fill', provider: 'mock' }),
  } as unknown as AiModelResolverService;
  config = new AiFillConfigService(prisma, access, realtime);
  fills = new AiFillService(prisma, queues, access, rows, settings, models, realtime);
  worker = new AiFillWorkerService(prisma, access, rows, properties, fills);

  const suffix = Date.now().toString(36);
  const [owner, reader] = await Promise.all([
    prisma.user.create({
      data: {
        email: `fill-owner-${suffix}@exocortex.test`,
        name: 'Anna Beispiel',
        emailVerified: true,
      },
    }),
    prisma.user.create({
      data: { email: `fill-reader-${suffix}@exocortex.test`, name: 'Leser', emailVerified: true },
    }),
  ]);
  ownerId = owner.id;
  readerId = reader.id;
  const workspace = await prisma.workspace.create({
    data: {
      name: `AI fill ${suffix}`,
      slug: `ai-fill-${suffix}`,
      members: {
        create: [
          { userId: ownerId, role: 'OWNER' },
          { userId: readerId, role: 'GUEST' },
        ],
      },
    },
  });
  workspaceId = workspace.id;
});

afterAll(async () => {
  await prisma.aiRun.deleteMany({ where: { workspaceId } });
  await prisma.workspace.deleteMany({ where: { id: workspaceId } });
  await prisma.user.deleteMany({ where: { id: { in: [ownerId, readerId] } } });
  await queues.obliterateAll();
  await queues.close();
  await prisma.$disconnect();
});

async function setup() {
  const collection = await documents.create({
    workspaceId,
    userId: ownerId,
    request: { title: 'Post', type: 'COLLECTION', parentId: null },
    correlationId,
  });
  const summary = await properties.create({
    collectionDocumentId: collection.id,
    userId: ownerId,
    request: { type: 'TEXT', name: 'Kurzfassung' },
    correlationId,
  });
  const kind = await properties.create({
    collectionDocumentId: collection.id,
    userId: ownerId,
    request: { type: 'SELECT', name: 'Art' },
    correlationId,
  });
  await properties.createOption({
    propertyId: kind.id,
    userId: ownerId,
    request: { label: 'Rechnung', color: 'blue' },
    correlationId,
  });
  const rowIds: string[] = [];
  for (const title of ['Brief A', 'Brief B', 'Brief C']) {
    const created = await rows.create({
      collectionDocumentId: collection.id,
      userId: ownerId,
      request: {
        title,
        values: title === 'Brief B' ? [{ propertyId: summary.id, value: 'Von Hand.' }] : [],
      },
      correlationId,
    });
    rowIds.push(created.document.id);
  }
  return { databaseId: collection.id, summaryId: summary.id, kindId: kind.id, rowIds };
}

function asWorker<T>(runId: string, operation: () => Promise<T>): Promise<T> {
  return runWithRequestContext({ correlationId, aiRunId: runId }, operation);
}

async function cellsOf(runId: string) {
  return prisma.databaseAiFillCell.findMany({
    where: { aiRunId: runId },
    orderBy: { position: 'asc' },
  });
}

describe('AI fill', () => {
  it('refuses an instruction that does not fit the column, and stores one that does', async () => {
    const { databaseId, summaryId } = await setup();
    await expect(
      config.set({
        collectionDocumentId: databaseId,
        propertyId: summaryId,
        userId: ownerId,
        request: { preset: 'document_date' },
        correlationId,
      }),
    ).rejects.toMatchObject({ code: 'database_property_ai_invalid' });
    const property = await config.set({
      collectionDocumentId: databaseId,
      propertyId: summaryId,
      userId: ownerId,
      request: { preset: 'summary', instruction: 'Auf Deutsch.' },
      correlationId,
    });
    expect(property.ai).toMatchObject({
      preset: 'summary',
      autoFill: 'off',
      instruction: 'Auf Deutsch.',
    });

    // A partial change keeps what it does not name.
    const switched = await config.set({
      collectionDocumentId: databaseId,
      propertyId: summaryId,
      userId: ownerId,
      request: { autoFill: 'on_create' },
      correlationId,
    });
    expect(switched.ai).toMatchObject({
      preset: 'summary',
      instruction: 'Auf Deutsch.',
      autoFill: 'on_create',
    });

    await expect(
      config.set({
        collectionDocumentId: databaseId,
        propertyId: summaryId,
        userId: readerId,
        request: { preset: 'summary' },
        correlationId,
      }),
    ).rejects.toBeInstanceOf(Error);
  });

  it('fills only the empty cells, writes the answer with its mark and keeps a person’s value', async () => {
    const { databaseId, summaryId, rowIds } = await setup();
    await expect(
      fills.start({
        collectionDocumentId: databaseId,
        userId: ownerId,
        request: { propertyId: summaryId },
        correlationId,
      }),
    ).rejects.toMatchObject({ code: 'ai_fill_not_configured' });
    await config.set({
      collectionDocumentId: databaseId,
      propertyId: summaryId,
      userId: ownerId,
      request: { preset: 'summary' },
      correlationId,
    });

    const dry = await fills.start({
      collectionDocumentId: databaseId,
      userId: ownerId,
      request: { propertyId: summaryId, dryRun: true },
      correlationId,
    });
    expect(dry).toMatchObject({ run: null, queued: 2, skippedNotEmpty: 1, remaining: 0 });

    const started = await fills.start({
      collectionDocumentId: databaseId,
      userId: ownerId,
      request: { propertyId: summaryId },
      correlationId,
    });
    const runId = started.run?.id ?? '';
    expect(started.run).toMatchObject({ status: 'pending', counts: { total: 2, queued: 2 } });
    const run = await prisma.aiRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run).toMatchObject({ kind: 'FILL', model: 'mock/fill', createdById: ownerId });

    // A second batch over the same column takes nothing the first one holds.
    const second = await fills.start({
      collectionDocumentId: databaseId,
      userId: ownerId,
      request: { propertyId: summaryId, dryRun: true },
      correlationId,
    });
    expect(second).toMatchObject({ queued: 0, skippedActive: 2 });

    const [first, last] = await cellsOf(runId);
    // Only this batch's own token reaches the worker routes.
    await expect(worker.material(runId, first?.id ?? '', ownerId)).rejects.toMatchObject({
      code: 'ai_fill_worker_only',
    });
    await prisma.aiRun.update({ where: { id: runId }, data: { status: 'RUNNING' } });
    const material = await asWorker(runId, () => worker.material(runId, first?.id ?? '', ownerId));
    expect(material).toMatchObject({
      status: 'ready',
      property: { name: 'Kurzfassung', type: 'TEXT' },
      row: { title: 'Brief A' },
    });

    const answered = await asWorker(runId, () =>
      worker.result(runId, first?.id ?? '', ownerId, { outcome: 'answer', value: 'Ein Brief.' }),
    );
    expect(answered).toEqual({ status: 'filled', errorCode: null });
    const filledRow = await rows.toRowResponse(databaseId, rowIds[0] ?? '');
    expect(filledRow.values.find((entry) => entry.propertyId === summaryId)?.value).toBe(
      'Ein Brief.',
    );
    expect(filledRow.aiCells).toEqual([
      expect.objectContaining({ propertyId: summaryId, state: 'filled', runId }),
    ]);

    // Somebody types into the last cell while the batch runs: it is kept.
    await rows.updateValues({
      rowId: rowIds[2] ?? '',
      userId: ownerId,
      request: { values: [{ propertyId: summaryId, value: 'Gerade getippt.' }] },
      correlationId,
    });
    const kept = await asWorker(runId, () =>
      worker.result(runId, last?.id ?? '', ownerId, { outcome: 'answer', value: 'Überschrieben?' }),
    );
    expect(kept).toEqual({ status: 'skipped', errorCode: 'not_empty' });

    // A person's edit of an AI value takes the mark away.
    await rows.updateValues({
      rowId: rowIds[0] ?? '',
      userId: ownerId,
      request: { values: [{ propertyId: summaryId, value: 'Korrigiert.' }] },
      correlationId,
    });
    const edited = await rows.toRowResponse(databaseId, rowIds[0] ?? '');
    expect(edited.aiCells).toBeUndefined();
  });

  it('records a failure on the cell, retries it, and cancels what is still waiting', async () => {
    const { databaseId, kindId, rowIds } = await setup();
    await config.set({
      collectionDocumentId: databaseId,
      propertyId: kindId,
      userId: ownerId,
      request: { preset: 'tags' },
      correlationId,
    });
    const started = await fills.start({
      collectionDocumentId: databaseId,
      userId: ownerId,
      request: { propertyId: kindId, rowIds: [rowIds[0] ?? '', rowIds[1] ?? ''] },
      correlationId,
    });
    const runId = started.run?.id ?? '';
    await prisma.aiRun.update({ where: { id: runId }, data: { status: 'RUNNING' } });
    const [first, second] = await cellsOf(runId);

    // An option the column does not have, and none may be added.
    const unknown = await asWorker(runId, () =>
      worker.result(runId, first?.id ?? '', ownerId, { outcome: 'answer', value: 'Vertrag' }),
    );
    expect(unknown).toEqual({ status: 'failed', errorCode: 'option_unknown' });
    const failedRow = await rows.toRowResponse(databaseId, rowIds[0] ?? '');
    expect(failedRow.aiCells).toEqual([
      expect.objectContaining({ state: 'failed', errorCode: 'option_unknown' }),
    ]);

    const cancelled = await fills.cancel(runId, ownerId, correlationId);
    expect(cancelled).toMatchObject({ status: 'cancelled', counts: { failed: 1, cancelled: 1 } });
    await expect(
      asWorker(runId, () =>
        worker.result(runId, second?.id ?? '', ownerId, { outcome: 'answer', value: 'Rechnung' }),
      ),
    ).rejects.toBeInstanceOf(AppError);

    const retried = await fills.retry(runId, ownerId, correlationId);
    expect(retried).toMatchObject({ queued: 2 });
    expect(retried.run?.id).not.toBe(runId);
    const retryCells = await cellsOf(retried.run?.id ?? '');
    expect(retryCells.map((cell) => cell.rowId)).toEqual([rowIds[0], rowIds[1]]);
  });

  it('refuses a batch larger than the limit when rows are named', async () => {
    const { databaseId, summaryId, rowIds } = await setup();
    await config.set({
      collectionDocumentId: databaseId,
      propertyId: summaryId,
      userId: ownerId,
      request: { preset: 'summary' },
      correlationId,
    });
    settingsValue = { ...settingsValue, 'ai.fillMaxRowsPerRun': 1 };
    try {
      await expect(
        fills.start({
          collectionDocumentId: databaseId,
          userId: ownerId,
          request: { propertyId: summaryId, rowIds: [rowIds[0] ?? '', rowIds[2] ?? ''] },
          correlationId,
        }),
      ).rejects.toMatchObject({ code: 'ai_fill_too_many_rows' });
      const whole = await fills.start({
        collectionDocumentId: databaseId,
        userId: ownerId,
        request: { propertyId: summaryId, dryRun: true },
        correlationId,
      });
      expect(whole).toMatchObject({ queued: 1, remaining: 1, limit: 1 });
    } finally {
      settingsValue = settingsSchema.parse({});
    }
  });

  it('fills a row by itself only when the column says so, as its author, never over a person', async () => {
    const { databaseId, summaryId, rowIds } = await setup();
    const [first = '', handWritten = ''] = rowIds;
    const auto = (userId: string, rowId: string, trigger: 'created' | 'changed') =>
      fills.startAutomatic({
        collectionDocumentId: databaseId,
        userId,
        request: { propertyId: summaryId, rowId, trigger },
        correlationId,
      });

    await config.set({
      collectionDocumentId: databaseId,
      propertyId: summaryId,
      userId: ownerId,
      request: { preset: 'summary' },
      correlationId,
    });
    // Off by default: nothing fills itself.
    await expect(auto(ownerId, first, 'created')).rejects.toMatchObject({
      code: 'ai_fill_not_configured',
    });

    await config.set({
      collectionDocumentId: databaseId,
      propertyId: summaryId,
      userId: ownerId,
      request: { autoFill: 'on_create' },
      correlationId,
    });
    // A new row, not a changed one; and only as the instruction's author.
    await expect(auto(ownerId, first, 'changed')).rejects.toMatchObject({
      code: 'ai_fill_not_configured',
    });
    await expect(auto(readerId, first, 'created')).rejects.toMatchObject({
      code: 'ai_fill_not_configured',
    });

    const started = await auto(ownerId, first, 'created');
    expect(started).toMatchObject({ queued: 1, run: { origin: 'automatic', mode: 'replace_ai' } });

    // A person's value stays: the automatic batch is `replace_ai`.
    const kept = await auto(ownerId, handWritten, 'created');
    expect(kept).toMatchObject({ run: null, queued: 0, skippedNotEmpty: 1 });
  });
});
