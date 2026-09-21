import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AuthorizationError, WorkspaceAccessService } from '@exocortex/auth';
import { type ApiEnv, loadDotEnv } from '@exocortex/config';
import { createPrismaClient, type PrismaClient } from '@exocortex/database';
import { type ProseMirrorDocument, serializePlainText } from '@exocortex/editor';
import { createLogger, type Logger } from '@exocortex/logger';
import { QueueRegistry, testQueuePrefix } from '@exocortex/queue';
import { type ObjectStorage } from '@exocortex/storage';

import { OutboxService } from '../common/outbox.service';
import { settingsStub } from '../platform/settings.test-support';
import { type RealtimeService } from '../realtime/realtime.service';

import {
  type ApplyToLiveSessionResult,
  type CollaborationBridgeService,
} from './collaboration-bridge.service';
import { DocumentActivityService } from './document-activity.service';
import { DocumentContentService } from './document-content.service';
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
 * `DocumentActivityService` merges three sources that are each incomplete on
 * their own (issue #20): `DocumentSnapshot`, the audit log, and the document
 * row itself. These tests exercise the merge against the real database
 * rather than mocking any of the three, because the interesting bugs here are
 * at the seams -- an audit action that was never mapped, a rename outbox
 * event misread as a content edit, an actor id that never gets a name.
 */
loadDotEnv();

const logger: Logger = createLogger({ name: 'api-test', level: 'silent' });

/** Nothing here deletes a page, so the storage half of the service is never reached. */
const noopStorage = {} as unknown as ObjectStorage;

let prisma: PrismaClient;
let queues: QueueRegistry;
let documents: DocumentsService;
let content: DocumentContentService;
let snapshots: DocumentSnapshotService;
let activity: DocumentActivityService;
let workspaceId: string;
let ownerId: string;
let memberId: string;
let adminId: string;
let outsiderId: string;

const realtime = { emit: async () => {} } as unknown as RealtimeService;
const liveResult: ApplyToLiveSessionResult = {
  applied: false,
  clientsCount: 0,
  yjsUpdatedAt: null,
  reachable: true,
};
/** Records what was handed to the (not actually running) collaboration server. */
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

const correlationId = 'activity-test-correlation';

beforeAll(async () => {
  prisma = createPrismaClient({ databaseUrl: process.env.DATABASE_URL });
  queues = new QueueRegistry({
    redisUrl: process.env.REDIS_URL ?? 'redis://127.0.0.1:6380',
    logger,
    prefix: testQueuePrefix('api-document-activity'),
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
    settingsStub(),
  );
  activity = new DocumentActivityService(prisma, access, snapshots);

  const suffix = Date.now().toString(36);
  const [owner, member, admin, outsider] = await Promise.all([
    prisma.user.create({
      data: {
        email: `activity-owner-${suffix}@exocortex.test`,
        name: 'Owner',
        emailVerified: true,
      },
    }),
    prisma.user.create({
      data: {
        email: `activity-member-${suffix}@exocortex.test`,
        name: 'Member',
        emailVerified: true,
      },
    }),
    prisma.user.create({
      data: {
        email: `activity-admin-${suffix}@exocortex.test`,
        name: 'Admin',
        emailVerified: true,
      },
    }),
    prisma.user.create({
      data: {
        email: `activity-out-${suffix}@exocortex.test`,
        name: 'Outsider',
        emailVerified: true,
      },
    }),
  ]);
  ownerId = owner.id;
  memberId = member.id;
  adminId = admin.id;
  outsiderId = outsider.id;

  const workspace = await prisma.workspace.create({
    data: {
      name: `Activity ${suffix}`,
      slug: `activity-${suffix}`,
      members: {
        create: [
          { userId: ownerId, role: 'OWNER' },
          { userId: memberId, role: 'MEMBER' },
          { userId: adminId, role: 'ADMIN' },
        ],
      },
    },
  });
  workspaceId = workspace.id;
}, 30_000);

afterAll(async () => {
  await prisma.workspace.deleteMany({ where: { id: workspaceId } });
  await prisma.user.deleteMany({ where: { id: { in: [ownerId, memberId, adminId, outsiderId] } } });
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

describe('DocumentActivityService.list: merging sources', () => {
  it('surfaces created, renamed, moved, archived and restored from Document + AuditLog', async () => {
    const documentId = await createPage('Ursprung');
    const otherParent = await createPage('Zielordner');

    await documents.update({
      documentId,
      userId: ownerId,
      request: { title: 'Umbenannt' },
      correlationId,
    });
    await documents.move({
      documentId,
      userId: ownerId,
      request: { parentId: otherParent },
      correlationId,
    });
    await documents.archive({ documentId, userId: ownerId, correlationId });
    await documents.restore({ documentId, userId: ownerId, correlationId });

    const result = await activity.list(documentId, ownerId);
    const types = result.entries.map((entry) => entry.type);

    expect(types).toContain('created');
    expect(types).toContain('renamed');
    expect(types).toContain('moved');
    expect(types).toContain('archived');
    expect(types).toContain('restored');

    const created = result.entries.find((entry) => entry.type === 'created');
    expect(created?.actorId).toBe(ownerId);
    expect(created?.actorName).toBe('Owner');

    const renamed = result.entries.find((entry) => entry.type === 'renamed');
    expect(renamed).toMatchObject({ previousTitle: 'Ursprung', nextTitle: 'Umbenannt' });

    // Reverse-chronological: the most recent thing that happened (restore)
    // is first.
    expect(result.entries[0]?.type).toBe('restored');
  });

  it('surfaces a content write as a restorable snapshot, and a restore of it as its own entry', async () => {
    const documentId = await createPage('Inhaltsseite');

    const write = await content.write({
      documentId,
      userId: ownerId,
      request: { markdown: 'Neuer Inhalt', mode: 'replace' },
      correlationId,
      source: 'api',
      growth: 'guarded',
    });

    let result = await activity.list(documentId, ownerId);
    const writeSnapshot = result.entries.find(
      (entry) => entry.type === 'snapshot' && entry.id === write.snapshotId,
    );
    expect(writeSnapshot).toBeDefined();
    expect(writeSnapshot).toMatchObject({ reason: 'api_write', actorId: ownerId });

    await snapshots.restore({ snapshotId: write.snapshotId, userId: ownerId, correlationId });

    result = await activity.list(documentId, ownerId);
    const restored = result.entries.find((entry) => entry.type === 'snapshotRestored');
    expect(restored).toMatchObject({ restoredFromSnapshotId: write.snapshotId, actorId: ownerId });
    // The restore itself snapshots the pre-restore state (PRE_RESTORE), so a
    // second restorable snapshot now exists too.
    expect(
      result.entries.filter((entry) => entry.type === 'snapshot' && entry.reason === 'pre_restore'),
    ).toHaveLength(1);
  });

  it('folds close-together SCHEDULED snapshots by the same actor into one editingSession entry', async () => {
    const documentId = await createPage('Sitzungsseite');
    const state = Buffer.from(new Uint8Array([0, 1, 2]));

    const start = new Date(Date.now() - 20 * 60 * 1000);
    const end = new Date(Date.now() - 5 * 60 * 1000);
    await prisma.documentSnapshot.create({
      data: {
        documentId,
        yjsState: state,
        createdById: memberId,
        reason: 'SCHEDULED',
        createdAt: start,
      },
    });
    await prisma.documentSnapshot.create({
      data: {
        documentId,
        yjsState: state,
        createdById: memberId,
        reason: 'SCHEDULED',
        createdAt: end,
      },
    });

    const result = await activity.list(documentId, ownerId);
    const sessions = result.entries.filter((entry) => entry.type === 'editingSession');

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      actorId: memberId,
      startedAt: start.toISOString(),
      endedAt: end.toISOString(),
    });

    // The two SCHEDULED snapshots still each appear as their own restorable
    // entry: folding into a session must not hide them.
    expect(result.entries.filter((entry) => entry.type === 'snapshot')).toHaveLength(2);
  });

  it('splits a session when the gap between snapshots is too large, or the actor differs', async () => {
    const documentId = await createPage('Zwei Sitzungen');
    const state = Buffer.from(new Uint8Array([0, 1, 2]));
    const now = Date.now();

    await prisma.documentSnapshot.create({
      data: {
        documentId,
        yjsState: state,
        createdById: memberId,
        reason: 'SCHEDULED',
        createdAt: new Date(now - 3 * 60 * 60 * 1000),
      },
    });
    // More than the 30-minute session gap later, same actor: a new session.
    await prisma.documentSnapshot.create({
      data: {
        documentId,
        yjsState: state,
        createdById: memberId,
        reason: 'SCHEDULED',
        createdAt: new Date(now - 2 * 60 * 60 * 1000),
      },
    });
    // A different actor, close in time: also a new session.
    await prisma.documentSnapshot.create({
      data: {
        documentId,
        yjsState: state,
        createdById: ownerId,
        reason: 'SCHEDULED',
        createdAt: new Date(now - 2 * 60 * 60 * 1000 + 60 * 1000),
      },
    });

    const result = await activity.list(documentId, ownerId);
    const sessions = result.entries.filter((entry) => entry.type === 'editingSession');
    expect(sessions).toHaveLength(3);
  });

  it('denies a caller who cannot read the document', async () => {
    const documentId = await createPage('Geheim');
    await expect(activity.list(documentId, outsiderId)).rejects.toBeInstanceOf(AuthorizationError);
  });
});

describe('restoring a snapshot: permissions (issue #20)', () => {
  it('an ADMIN may restore a snapshot', async () => {
    const documentId = await createPage('Wiederherstellbar (Admin)');
    const write = await content.write({
      documentId,
      userId: ownerId,
      request: { markdown: 'v2', mode: 'replace' },
      correlationId,
      source: 'api',
      growth: 'guarded',
    });

    await expect(
      snapshots.restore({ snapshotId: write.snapshotId, userId: adminId, correlationId }),
    ).resolves.toMatchObject({ documentId, restoredFrom: write.snapshotId });
  });

  it('an OWNER may restore a snapshot', async () => {
    const documentId = await createPage('Wiederherstellbar (Owner)');
    const write = await content.write({
      documentId,
      userId: ownerId,
      request: { markdown: 'v2', mode: 'replace' },
      correlationId,
      source: 'api',
      growth: 'guarded',
    });

    await expect(
      snapshots.restore({ snapshotId: write.snapshotId, userId: ownerId, correlationId }),
    ).resolves.toMatchObject({ documentId, restoredFrom: write.snapshotId });
  });

  it('rejects a restore from a plain MEMBER: editing a page is not enough, restoring needs ADMIN or OWNER', async () => {
    const documentId = await createPage('Nur Mitglied');
    const write = await content.write({
      documentId,
      userId: ownerId,
      request: { markdown: 'v2', mode: 'replace' },
      correlationId,
      source: 'api',
      growth: 'guarded',
    });

    await expect(
      snapshots.restore({ snapshotId: write.snapshotId, userId: memberId, correlationId }),
    ).rejects.toBeInstanceOf(AuthorizationError);
    // The content must actually be unchanged, not just the promise rejected.
    const current = await prisma.documentContent.findUniqueOrThrow({ where: { documentId } });
    expect(current.markdown).toBe('v2');
  });

  it('rejects a restore from someone outside the workspace', async () => {
    const documentId = await createPage('Geschützt');
    const write = await content.write({
      documentId,
      userId: ownerId,
      request: { markdown: 'v2', mode: 'replace' },
      correlationId,
      source: 'api',
      growth: 'guarded',
    });

    await expect(
      snapshots.restore({ snapshotId: write.snapshotId, userId: outsiderId, correlationId }),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });
});
