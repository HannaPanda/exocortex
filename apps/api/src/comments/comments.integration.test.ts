import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AuthorizationError, WorkspaceAccessService } from '@exocortex/auth';
import { loadDotEnv } from '@exocortex/config';
import { createPrismaClient, generateOrderKey, type PrismaClient } from '@exocortex/database';
import { createLogger, type Logger } from '@exocortex/logger';

import { AppError } from '../common/app-error';
import { OutboxService } from '../common/outbox.service';
import { type RealtimeService } from '../realtime/realtime.service';

import { CommentsService } from './comments.service';

/**
 * Comment domain tests against the real database.
 *
 * Like the document tests next door, the service is built by hand rather than
 * through the Nest container: what is under test is authorization, threading
 * and the anchor's independence from the document, none of which involve HTTP.
 */
loadDotEnv();

const logger: Logger = createLogger({ name: 'api-test', level: 'silent' });
const correlationId = 'test-correlation';

let prisma: PrismaClient;
let service: CommentsService;
let workspaceId: string;
let foreignWorkspaceId: string;
let documentId: string;
let archivedDocumentId: string;
let foreignDocumentId: string;
let ownerId: string;
let memberId: string;
let adminId: string;
let guestId: string;
let outsiderId: string;

const emitted: { type: string; payload: unknown }[] = [];
const realtime = {
  emit: async (type: string, _workspaceId: string, _correlation: string, payload: unknown) => {
    emitted.push({ type, payload });
  },
} as unknown as RealtimeService;

beforeAll(async () => {
  prisma = createPrismaClient({ databaseUrl: process.env.DATABASE_URL });
  const access = new WorkspaceAccessService(prisma);
  service = new CommentsService(
    prisma,
    logger,
    access,
    new OutboxService(prisma, logger),
    realtime,
  );

  const suffix = Date.now().toString(36);
  const users = await Promise.all(
    (['owner', 'member', 'admin', 'guest', 'out'] as const).map((role) =>
      prisma.user.create({
        data: {
          email: `comment-${role}-${suffix}@exocortex.test`,
          name: `Comment ${role}`,
          emailVerified: true,
        },
      }),
    ),
  );
  [ownerId, memberId, adminId, guestId, outsiderId] = users.map((user) => user.id) as [
    string,
    string,
    string,
    string,
    string,
  ];

  const workspace = await prisma.workspace.create({
    data: {
      name: `Comments ${suffix}`,
      slug: `comments-${suffix}`,
      members: {
        create: [
          { userId: ownerId, role: 'OWNER' },
          { userId: memberId, role: 'MEMBER' },
          { userId: adminId, role: 'ADMIN' },
          { userId: guestId, role: 'GUEST' },
        ],
      },
    },
  });
  workspaceId = workspace.id;

  const foreign = await prisma.workspace.create({
    data: {
      name: `Foreign ${suffix}`,
      slug: `comments-foreign-${suffix}`,
      members: { create: { userId: outsiderId, role: 'OWNER' } },
    },
  });
  foreignWorkspaceId = foreign.id;

  const page = await prisma.document.create({
    data: {
      workspaceId,
      title: 'Kommentierte Seite',
      orderKey: generateOrderKey(null, null),
      createdById: ownerId,
      updatedById: ownerId,
    },
  });
  documentId = page.id;

  const archived = await prisma.document.create({
    data: {
      workspaceId,
      title: 'Archivierte Seite',
      orderKey: generateOrderKey(null, null),
      createdById: ownerId,
      updatedById: ownerId,
      archivedAt: new Date(),
    },
  });
  archivedDocumentId = archived.id;

  const foreignPage = await prisma.document.create({
    data: {
      workspaceId: foreign.id,
      title: 'Fremde Seite',
      orderKey: generateOrderKey(null, null),
      createdById: outsiderId,
      updatedById: outsiderId,
    },
  });
  foreignDocumentId = foreignPage.id;
});

afterAll(async () => {
  await prisma.workspace.deleteMany({ where: { id: { in: [workspaceId, foreignWorkspaceId] } } });
  await prisma.user.deleteMany({
    where: { id: { in: [ownerId, memberId, adminId, guestId, outsiderId] } },
  });
  await prisma.$disconnect();
});

beforeEach(async () => {
  emitted.length = 0;
  await prisma.comment.deleteMany({ where: { workspaceId } });
});

async function comment(input: {
  userId?: string;
  documentId?: string;
  body?: string;
  blockId?: string | null;
  anchorText?: string | null;
  parentId?: string | null;
}) {
  return service.create({
    documentId: input.documentId ?? documentId,
    userId: input.userId ?? memberId,
    request: {
      body: input.body ?? 'Eine Anmerkung',
      blockId: input.blockId ?? null,
      anchorText: input.anchorText ?? null,
      parentId: input.parentId ?? null,
    },
    correlationId,
  });
}

describe('creating comments', () => {
  it('writes a page-wide comment and emits comment.created', async () => {
    const created = await comment({ body: 'Notiz an mich selbst' });

    expect(created.blockId).toBeNull();
    expect(created.parentId).toBeNull();
    expect(created.orphaned).toBe(false);
    expect(created.createdBy.id).toBe(memberId);
    expect(emitted.map((event) => event.type)).toContain('comment.created');
  });

  it('anchors a comment to a block and keeps the quoted text', async () => {
    const created = await comment({
      blockId: 'abcdefgh1234',
      anchorText: 'Der kommentierte Absatz',
    });

    expect(created.blockId).toBe('abcdefgh1234');
    expect(created.anchorText).toBe('Der kommentierte Absatz');
  });

  it('writes an outbox row inside the same transaction', async () => {
    const created = await comment({});
    const rows = await prisma.outboxEvent.findMany({
      where: { workspaceId, type: 'comment.created' },
    });
    expect(rows.some((row) => JSON.stringify(row.payload).includes(created.id))).toBe(true);
  });

  it('refuses a guest, allows a member', async () => {
    await expect(comment({ userId: guestId })).rejects.toBeInstanceOf(AuthorizationError);
    await expect(comment({ userId: memberId })).resolves.toBeDefined();
  });

  it('refuses a comment on an archived page', async () => {
    await expect(comment({ documentId: archivedDocumentId })).rejects.toMatchObject({
      code: 'document_archived',
    });
  });

  it('hides a page of another workspace behind the same error as a missing one', async () => {
    await expect(comment({ documentId: foreignDocumentId })).rejects.toMatchObject({
      code: 'document_access_denied',
    });
  });
});

describe('threads and replies', () => {
  it('groups replies under their root, oldest first', async () => {
    const root = await comment({ body: 'Stimmt der Absatz?', blockId: 'blockaaaa111' });
    const first = await comment({ body: 'Nein', parentId: root.id, userId: ownerId });
    const second = await comment({ body: 'Doch', parentId: root.id, userId: adminId });

    const listed = await service.list({ documentId, userId: guestId, includeResolved: true });
    expect(listed.threads).toHaveLength(1);
    expect(listed.threads[0]?.root.id).toBe(root.id);
    expect(listed.threads[0]?.replies.map((reply) => reply.id)).toEqual([first.id, second.id]);
  });

  it('gives a reply the thread’s anchor, never one of its own', async () => {
    const root = await comment({ blockId: 'blockbbbb222', anchorText: 'Zitat' });
    const reply = await comment({ parentId: root.id, blockId: 'blockcccc333' });

    expect(reply.blockId).toBe('blockbbbb222');
    expect(reply.anchorText).toBe('Zitat');
  });

  it('refuses a reply to a reply', async () => {
    const root = await comment({});
    const reply = await comment({ parentId: root.id });

    await expect(comment({ parentId: reply.id })).rejects.toMatchObject({ code: 'conflict' });
  });

  it('refuses a reply to a comment on another page', async () => {
    const other = await prisma.document.create({
      data: {
        workspaceId,
        title: 'Zweite Seite',
        orderKey: generateOrderKey(null, null),
        createdById: ownerId,
        updatedById: ownerId,
      },
    });
    const root = await comment({ documentId: other.id });

    await expect(comment({ documentId, parentId: root.id })).rejects.toBeInstanceOf(AppError);
    await prisma.document.delete({ where: { id: other.id } });
  });
});

describe('editing and deleting', () => {
  it('lets the author rewrite their own comment and marks it edited', async () => {
    const created = await comment({ userId: memberId });
    const updated = await service.update({
      commentId: created.id,
      userId: memberId,
      request: { body: 'Anders formuliert' },
      correlationId,
    });

    expect(updated.body).toBe('Anders formuliert');
    expect(updated.editedAt).not.toBeNull();
    expect(emitted.map((event) => event.type)).toContain('comment.updated');
  });

  it('refuses to let anyone rewrite a foreign comment, owner included', async () => {
    const created = await comment({ userId: memberId });
    for (const userId of [ownerId, adminId]) {
      await expect(
        service.update({
          commentId: created.id,
          userId,
          request: { body: 'Fremdes Wort' },
          correlationId,
        }),
      ).rejects.toMatchObject({ code: 'forbidden' });
    }
  });

  it('lets the author delete, refuses another member, allows an admin', async () => {
    const own = await comment({ userId: memberId });
    await expect(
      service.remove({ commentId: own.id, userId: ownerId, correlationId }),
    ).resolves.toMatchObject({ deleted: true });

    const second = await comment({ userId: memberId });
    const thirdParty = await prisma.user.create({
      data: {
        email: `third-${Date.now().toString(36)}@exocortex.test`,
        name: 'Dritte',
        emailVerified: true,
      },
    });
    await prisma.workspaceMember.create({
      data: { workspaceId, userId: thirdParty.id, role: 'MEMBER' },
    });
    await expect(
      service.remove({ commentId: second.id, userId: thirdParty.id, correlationId }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      service.remove({ commentId: second.id, userId: adminId, correlationId }),
    ).resolves.toMatchObject({ deleted: true });

    await prisma.workspaceMember.deleteMany({ where: { userId: thirdParty.id } });
    await prisma.user.delete({ where: { id: thirdParty.id } });
  });

  it('takes the replies with the root and says how many', async () => {
    const root = await comment({ userId: memberId });
    await comment({ parentId: root.id, userId: ownerId });
    await comment({ parentId: root.id, userId: adminId });

    const result = await service.remove({ commentId: root.id, userId: memberId, correlationId });
    expect(result.removedReplies).toBe(2);
    expect(await prisma.comment.count({ where: { documentId } })).toBe(0);
    expect(emitted.map((event) => event.type)).toContain('comment.deleted');
  });
});

describe('resolving', () => {
  it('resolves and reopens a thread, recording who resolved it', async () => {
    const root = await comment({ userId: memberId });

    const resolved = await service.setResolved({
      commentId: root.id,
      userId: ownerId,
      resolved: true,
      correlationId,
    });
    expect(resolved.resolvedAt).not.toBeNull();
    expect(resolved.resolvedBy?.id).toBe(ownerId);
    expect(emitted.map((event) => event.type)).toContain('comment.resolved');

    const reopened = await service.setResolved({
      commentId: root.id,
      userId: memberId,
      resolved: false,
      correlationId,
    });
    expect(reopened.resolvedAt).toBeNull();
    expect(reopened.resolvedBy).toBeNull();
  });

  it('refuses a guest and refuses resolving a reply on its own', async () => {
    const root = await comment({});
    const reply = await comment({ parentId: root.id });

    await expect(
      service.setResolved({ commentId: root.id, userId: guestId, resolved: true, correlationId }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      service.setResolved({ commentId: reply.id, userId: ownerId, resolved: true, correlationId }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('sorts open threads before resolved ones and can hide the resolved', async () => {
    const first = await comment({ body: 'Zuerst' });
    const second = await comment({ body: 'Danach' });
    await service.setResolved({
      commentId: first.id,
      userId: ownerId,
      resolved: true,
      correlationId,
    });

    const all = await service.list({ documentId, userId: memberId, includeResolved: true });
    expect(all.threads.map((thread) => thread.root.id)).toEqual([second.id, first.id]);
    expect(all.openCount).toBe(1);
    expect(all.resolvedCount).toBe(1);

    const open = await service.list({ documentId, userId: memberId, includeResolved: false });
    expect(open.threads.map((thread) => thread.root.id)).toEqual([second.id]);
    // The counts still report what is being hidden.
    expect(open.resolvedCount).toBe(1);
  });
});

describe('reading', () => {
  it('lets a guest read but hides the page from an outsider entirely', async () => {
    await comment({});
    await expect(
      service.list({ documentId, userId: guestId, includeResolved: true }),
    ).resolves.toMatchObject({ openCount: 1 });
    await expect(
      service.list({ documentId, userId: outsiderId, includeResolved: true }),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

  it('reports an orphaned thread as orphaned', async () => {
    const created = await comment({ blockId: 'gonegonegone' });
    await prisma.comment.update({
      where: { id: created.id },
      data: { orphanedAt: new Date() },
    });

    const listed = await service.list({ documentId, userId: memberId, includeResolved: true });
    expect(listed.threads[0]?.root.orphaned).toBe(true);
    // The remark itself is untouched: orphaning is a label, not a deletion.
    expect(listed.threads[0]?.root.body).toBe('Eine Anmerkung');
  });
});
