import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AuthorizationError, WorkspaceAccessService } from '@exocortex/auth';
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

import { OutboxService } from '../common/outbox.service';
import { type RealtimeService } from '../realtime/realtime.service';

import {
  type ApplyToLiveSessionResult,
  type CollaborationBridgeService,
} from './collaboration-bridge.service';
import { DocumentContentService } from './document-content.service';
import { DocumentDiffService } from './document-diff.service';
import { DocumentMoveService } from './document-move.service';
import { DocumentSnapshotService } from './document-snapshot.service';
import { DocumentTrashService } from './document-trash.service';
import { DocumentWriteCommitService } from './document-write-commit.service';
import { DocumentsService } from './documents.service';
import { PageLinkIdentityService } from './page-link-identity.service';

/** `DocumentContentService` reads one value from the environment: the origin
 * an image's address is judged against (issue #117). */
const CONTENT_TEST_ENV = { APP_URL: 'https://exocortex.test' } as unknown as ApiEnv;

/**
 * Comparing two states of a page and taking single blocks back (issue #77).
 *
 * Against the real database and the real Yjs states, because that is where the
 * interesting failures live: a block identifier that does not survive the
 * Markdown round trip, a partial restore that lands on the state the diff was
 * rendered against instead of on the page as it stands, an open editing
 * session that is handed the wrong document.
 */
loadDotEnv();

const logger: Logger = createLogger({ name: 'api-test', level: 'silent' });
const noopStorage = {} as unknown as ObjectStorage;

let prisma: PrismaClient;
let queues: QueueRegistry;
let documents: DocumentsService;
let content: DocumentContentService;
let snapshots: DocumentSnapshotService;
let diffs: DocumentDiffService;
let workspaceId: string;
let ownerId: string;
let outsiderId: string;

const realtime = { emit: async () => {} } as unknown as RealtimeService;
const liveResult: ApplyToLiveSessionResult = {
  applied: false,
  clientsCount: 0,
  yjsUpdatedAt: null,
  reachable: true,
};
const liveApplications: { documentId: string; mode: string; plainText: string }[] = [];
const collaboration = {
  applyToLiveSession: async (input: {
    documentId: string;
    mode: string;
    proseMirrorJson: ProseMirrorDocument;
  }) => {
    liveApplications.push({
      documentId: input.documentId,
      mode: input.mode,
      plainText: serializePlainText(input.proseMirrorJson),
    });
    return liveResult;
  },
} as unknown as CollaborationBridgeService;

const correlationId = 'diff-test-correlation';

const A = 'aaaaaaaaaaa1';
const B = 'bbbbbbbbbbb1';
const C = 'ccccccccccc1';
const D = 'ddddddddddd1';

beforeAll(async () => {
  prisma = createPrismaClient({ databaseUrl: process.env.DATABASE_URL });
  queues = new QueueRegistry({
    redisUrl: process.env.REDIS_URL ?? 'redis://127.0.0.1:6380',
    logger,
    prefix: testQueuePrefix('api-document-diff'),
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
  snapshots = new DocumentSnapshotService(
    prisma,
    queues,
    logger,
    access,
    outbox,
    realtime,
    collaboration,
  );
  content = new DocumentContentService(
    prisma,
    logger,
    CONTENT_TEST_ENV,
    access,
    new DocumentWriteCommitService(prisma, queues, logger, outbox, realtime, collaboration),
    new PageLinkIdentityService(prisma),
  );
  diffs = new DocumentDiffService(prisma, logger, access, snapshots);

  const suffix = Date.now().toString(36);
  const [owner, outsider] = await Promise.all([
    prisma.user.create({
      data: { email: `diff-owner-${suffix}@exocortex.test`, name: 'Owner', emailVerified: true },
    }),
    prisma.user.create({
      data: { email: `diff-out-${suffix}@exocortex.test`, name: 'Outsider', emailVerified: true },
    }),
  ]);
  ownerId = owner.id;
  outsiderId = outsider.id;

  const workspace = await prisma.workspace.create({
    data: {
      name: `Diff ${suffix}`,
      slug: `diff-${suffix}`,
      members: { create: [{ userId: ownerId, role: 'OWNER' }] },
    },
  });
  workspaceId = workspace.id;
}, 30_000);

afterAll(async () => {
  await prisma.workspace.deleteMany({ where: { id: workspaceId } });
  await prisma.user.deleteMany({ where: { id: { in: [ownerId, outsiderId] } } });
  await queues.obliterateAll();
  await queues.close();
  await prisma.$disconnect();
});

async function createPage(title: string): Promise<string> {
  const document = await documents.create({
    workspaceId,
    userId: ownerId,
    request: { title, type: 'PAGE', parentId: null },
    correlationId,
  });
  return document.id;
}

async function write(documentId: string, markdown: string): Promise<void> {
  await content.write({
    documentId,
    userId: ownerId,
    request: { markdown, mode: 'replace' },
    correlationId,
    source: 'api',
  });
}

async function plainTextOf(documentId: string): Promise<string> {
  const row = await prisma.documentContent.findUniqueOrThrow({
    where: { documentId },
    select: { yjsState: true },
  });
  return serializePlainText(yjsStateToProseMirrorJson(row.yjsState));
}

describe('DocumentDiffService.diff', () => {
  it('names what was added, removed, changed and moved', async () => {
    const documentId = await createPage('Vergleich');
    await write(documentId, `Eins ^${A}\n\nZwei ^${B}\n\nDrei ^${C}`);
    const snapshot = await snapshots.create({ documentId, userId: ownerId, reason: 'manual' });
    await write(documentId, `Drei ^${C}\n\nEins geändert ^${A}\n\nVier ^${D}`);

    const diff = await diffs.diff({
      documentId,
      snapshotId: snapshot.id,
      against: 'current',
      userId: ownerId,
    });

    const byId = new Map(diff.blocks.map((block) => [block.blockId, block]));
    expect(byId.get(A)?.kind).toBe('changed');
    expect(byId.get(B)?.kind).toBe('removed');
    expect(byId.get(C)?.kind).toBe('unchanged');
    expect(byId.get(C)?.moved).toBe(true);
    expect(byId.get(D)?.kind).toBe('added');
    expect(diff.fromSnapshotId).toBe(snapshot.id);
    expect(diff.toSnapshotId).toBeNull();
  });

  it('shows the word that changed inside a block', async () => {
    const documentId = await createPage('Wortvergleich');
    await write(documentId, `Der Hund bellt laut ^${A}`);
    const snapshot = await snapshots.create({ documentId, userId: ownerId, reason: 'manual' });
    await write(documentId, `Der Kater bellt laut ^${A}`);

    const diff = await diffs.diff({
      documentId,
      snapshotId: snapshot.id,
      against: 'current',
      userId: ownerId,
    });

    const block = diff.blocks.find((entry) => entry.blockId === A);
    expect(block?.segments.filter((segment) => segment.kind === 'removed')[0]?.text).toBe('Hund');
    expect(block?.segments.filter((segment) => segment.kind === 'inserted')[0]?.text).toBe('Kater');
  });

  it('orders the two states by age, whichever one the caller named', async () => {
    const documentId = await createPage('Reihenfolge');
    await write(documentId, `Alt ^${A}`);
    const older = await snapshots.create({ documentId, userId: ownerId, reason: 'manual' });
    await write(documentId, `Alt ^${A}\n\nNeu ^${B}`);
    const newer = await snapshots.create({ documentId, userId: ownerId, reason: 'manual' });

    const diff = await diffs.diff({
      documentId,
      snapshotId: newer.id,
      against: older.id,
      userId: ownerId,
    });

    expect(diff.fromSnapshotId).toBe(older.id);
    expect(diff.toSnapshotId).toBe(newer.id);
    expect(diff.blocks.find((block) => block.blockId === B)?.kind).toBe('added');
  });

  it('compares against the current content even when nothing was written since', async () => {
    const documentId = await createPage('Frisch gesichert');
    await write(documentId, `Eins ^${A}`);
    const snapshot = await snapshots.create({ documentId, userId: ownerId, reason: 'manual' });

    const diff = await diffs.diff({
      documentId,
      snapshotId: snapshot.id,
      against: 'current',
      userId: ownerId,
    });

    expect(diff.fromSnapshotId).toBe(snapshot.id);
    expect(diff.toSnapshotId).toBeNull();
    expect(diff.summary).toMatchObject({ added: 0, removed: 0, changed: 0, moved: 0 });
  });

  it('refuses a snapshot of a different page and a caller without access', async () => {
    const documentId = await createPage('Fremd');
    const other = await createPage('Anders');
    await write(documentId, `Eins ^${A}`);
    const snapshot = await snapshots.create({ documentId, userId: ownerId, reason: 'manual' });

    await expect(
      diffs.diff({
        documentId: other,
        snapshotId: snapshot.id,
        against: 'current',
        userId: ownerId,
      }),
    ).rejects.toThrow();
    await expect(
      diffs.diff({ documentId, snapshotId: snapshot.id, against: 'current', userId: outsiderId }),
    ).rejects.toThrow(AuthorizationError);
  });
});

describe('DocumentDiffService.restoreBlocks', () => {
  it('puts one block back without touching what was written after the snapshot', async () => {
    const documentId = await createPage('Teilweise');
    await write(documentId, `Eins ^${A}\n\nZwei ^${B}`);
    const snapshot = await snapshots.create({ documentId, userId: ownerId, reason: 'manual' });
    await write(documentId, `Eins geändert ^${A}\n\nZwei ^${B}\n\nSpäter dazu ^${D}`);

    const result = await diffs.restoreBlocks({
      documentId,
      snapshotId: snapshot.id,
      blockIds: [A],
      userId: ownerId,
      correlationId,
    });

    expect(result.restored).toEqual([A]);
    expect(result.snapshotBeforeId).not.toBeNull();
    const text = await plainTextOf(documentId);
    expect(text).toContain('Eins');
    expect(text).not.toContain('Eins geändert');
    expect(text).toContain('Später dazu');
  });

  it('re-inserts a deleted block next to the neighbour it had', async () => {
    const documentId = await createPage('Wieder da');
    await write(documentId, `Eins ^${A}\n\nZwei ^${B}\n\nDrei ^${C}`);
    const snapshot = await snapshots.create({ documentId, userId: ownerId, reason: 'manual' });
    await write(documentId, `Eins ^${A}\n\nDrei ^${C}`);

    await diffs.restoreBlocks({
      documentId,
      snapshotId: snapshot.id,
      blockIds: [B],
      userId: ownerId,
      correlationId,
    });

    expect(await plainTextOf(documentId)).toBe('Eins\nZwei\nDrei');
  });

  it('takes a block out again when the snapshot never had it', async () => {
    const documentId = await createPage('Rückgängig');
    await write(documentId, `Eins ^${A}`);
    const snapshot = await snapshots.create({ documentId, userId: ownerId, reason: 'manual' });
    await write(documentId, `Eins ^${A}\n\nDazugekommen ^${D}`);

    const result = await diffs.restoreBlocks({
      documentId,
      snapshotId: snapshot.id,
      blockIds: [D],
      userId: ownerId,
      correlationId,
    });

    expect(result.removed).toEqual([D]);
    expect(await plainTextOf(documentId)).toBe('Eins');
  });

  it('hands the merged page to an open editing session, not the whole snapshot', async () => {
    const documentId = await createPage('Sitzung');
    await write(documentId, `Eins ^${A}`);
    const snapshot = await snapshots.create({ documentId, userId: ownerId, reason: 'manual' });
    await write(documentId, `Eins geändert ^${A}\n\nNeu ^${D}`);

    liveApplications.length = 0;
    await diffs.restoreBlocks({
      documentId,
      snapshotId: snapshot.id,
      blockIds: [A],
      userId: ownerId,
      correlationId,
    });

    const applied = liveApplications.find((entry) => entry.documentId === documentId);
    expect(applied?.mode).toBe('replace');
    expect(applied?.plainText).toContain('Neu');
  });

  it('refuses identifiers neither state knows', async () => {
    const documentId = await createPage('Unbekannt');
    await write(documentId, `Eins ^${A}`);
    const snapshot = await snapshots.create({ documentId, userId: ownerId, reason: 'manual' });

    await expect(
      diffs.restoreBlocks({
        documentId,
        snapshotId: snapshot.id,
        blockIds: ['zzzzzzzzzzz1'],
        userId: ownerId,
        correlationId,
      }),
    ).rejects.toThrow();
  });

  it('writes nothing when the selection changes nothing', async () => {
    const documentId = await createPage('Unverändert');
    await write(documentId, `Eins ^${A}`);
    const snapshot = await snapshots.create({ documentId, userId: ownerId, reason: 'manual' });

    const before = await prisma.documentSnapshot.count({ where: { documentId } });
    const result = await diffs.restoreBlocks({
      documentId,
      snapshotId: snapshot.id,
      blockIds: [A],
      userId: ownerId,
      correlationId,
    });

    expect(result.snapshotBeforeId).toBeNull();
    expect(await prisma.documentSnapshot.count({ where: { documentId } })).toBe(before);
  });
});
