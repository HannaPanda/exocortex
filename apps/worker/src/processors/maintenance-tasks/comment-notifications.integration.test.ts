import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadDotEnv } from '@exocortex/config';
import { createPrismaClient, generateOrderKey, type PrismaClient } from '@exocortex/database';
import { type QueueRegistry } from '@exocortex/queue';

import { scheduleCommentNotifications } from './comment-notifications';

/**
 * Who hears about a comment (issue #30, ADR-048).
 *
 * The whole feature stands on this question, and getting it wrong is bad in
 * both directions: too wide and every comment in a workspace buzzes everybody's
 * phone until they switch the feature off, too narrow and the person whose page
 * it is never learns about it. The access half matters just as much -- a thread
 * outlives the grant that created it, so the people who once wrote here are
 * exactly the list that may contain somebody who no longer belongs.
 */
loadDotEnv();

let prisma: PrismaClient;
let workspaceId: string;
let documentId: string;
/** The page's author; a member. */
let authorId: string;
/** Another member, who replies. */
let memberId: string;
/** Not a member. Gets access only when a share says so. */
let outsiderId: string;

const userIds: string[] = [];

async function makeUser(name: string): Promise<string> {
  const user = await prisma.user.create({
    data: {
      email: `push-${name}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}@exocortex.test`,
      name,
      emailVerified: true,
    },
  });
  userIds.push(user.id);
  return user.id;
}

beforeAll(async () => {
  prisma = createPrismaClient({ databaseUrl: process.env.DATABASE_URL });
  const suffix = Date.now().toString(36);

  authorId = await makeUser('Autorin');
  memberId = await makeUser('Mitglied');
  outsiderId = await makeUser('Gast');

  const workspace = await prisma.workspace.create({
    data: {
      name: `Push ${suffix}`,
      slug: `push-${suffix}`,
      members: {
        create: [
          { userId: authorId, role: 'OWNER' },
          { userId: memberId, role: 'MEMBER' },
        ],
      },
    },
  });
  workspaceId = workspace.id;

  const document = await prisma.document.create({
    data: {
      workspaceId,
      title: 'Kommentierte Seite',
      orderKey: generateOrderKey(null, null),
      createdById: authorId,
      updatedById: authorId,
    },
  });
  documentId = document.id;
});

afterAll(async () => {
  await prisma.workspace.deleteMany({ where: { id: workspaceId } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.comment.deleteMany({ where: { workspaceId } });
  await prisma.documentShare.deleteMany({ where: { workspaceId } });
});

async function comment(createdById: string, parentId: string | null = null): Promise<string> {
  const created = await prisma.comment.create({
    data: { workspaceId, documentId, parentId, body: 'Ein Kommentar', createdById },
  });
  return created.id;
}

/** Runs the dispatcher hook and returns the user ids it enqueued a push for. */
async function notified(commentId: string): Promise<string[]> {
  const enqueue = vi.fn(async () => undefined);
  const queues = { enqueue } as unknown as QueueRegistry;

  await scheduleCommentNotifications(
    { prisma, queues, appUrl: 'https://exocortex.test' },
    {
      workspaceId,
      type: 'comment.created',
      payload: { documentId, commentId },
      correlationId: 'c1',
    },
  );

  return enqueue.mock.calls
    .map((call) => (call as unknown as [string, { userId: string }])[1].userId)
    .sort();
}

describe('scheduleCommentNotifications', () => {
  it('tells the page author about a comment somebody else wrote', async () => {
    expect(await notified(await comment(memberId))).toEqual([authorId]);
  });

  it('never notifies the person who wrote the comment', async () => {
    expect(await notified(await comment(authorId))).toEqual([]);
  });

  it('notifies everybody already in the thread, not just the page author', async () => {
    const root = await comment(memberId);
    const outsiderReply = await prisma.workspaceMember.create({
      data: { workspaceId, userId: outsiderId, role: 'MEMBER' },
    });
    await comment(outsiderId, root);

    // A third comment in the thread, from the author: the other two hear it.
    expect(await notified(await comment(authorId, root))).toEqual([memberId, outsiderId].sort());

    await prisma.workspaceMember.delete({ where: { id: outsiderReply.id } });
  });

  it('leaves out somebody who wrote here but is no longer a member', async () => {
    const root = await comment(memberId);
    // Written while they still belonged; the membership is gone now.
    await prisma.comment.create({
      data: { workspaceId, documentId, parentId: root, body: 'Alt', createdById: outsiderId },
    });

    expect(await notified(await comment(authorId, root))).toEqual([memberId]);
  });

  it('includes a former member who still holds a grant on the page', async () => {
    const root = await comment(memberId);
    await prisma.comment.create({
      data: { workspaceId, documentId, parentId: root, body: 'Alt', createdById: outsiderId },
    });
    await prisma.documentShare.create({
      data: {
        workspaceId,
        documentId,
        kind: 'USER',
        permission: 'READ',
        scope: 'PAGE_ONLY',
        granteeId: outsiderId,
        createdById: authorId,
      },
    });

    expect(await notified(await comment(authorId, root))).toEqual([memberId, outsiderId].sort());
  });

  it('ignores a grant that has expired', async () => {
    const root = await comment(memberId);
    await prisma.comment.create({
      data: { workspaceId, documentId, parentId: root, body: 'Alt', createdById: outsiderId },
    });
    await prisma.documentShare.create({
      data: {
        workspaceId,
        documentId,
        kind: 'USER',
        permission: 'READ',
        scope: 'PAGE_ONLY',
        granteeId: outsiderId,
        createdById: authorId,
        expiresAt: new Date(Date.now() - 60_000),
      },
    });

    expect(await notified(await comment(authorId, root))).toEqual([memberId]);
  });

  it('does nothing for an event that is not a new comment', async () => {
    const enqueue = vi.fn(async () => undefined);
    await scheduleCommentNotifications(
      { prisma, queues: { enqueue } as unknown as QueueRegistry, appUrl: 'https://exocortex.test' },
      {
        workspaceId,
        type: 'comment.updated',
        payload: { documentId, commentId: await comment(memberId) },
        correlationId: 'c1',
      },
    );
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('does nothing when the comment was deleted before the dispatcher got to it', async () => {
    const id = await comment(memberId);
    await prisma.comment.delete({ where: { id } });
    expect(await notified(id)).toEqual([]);
  });

  it('links back to the page and groups every comment on it under one tag', async () => {
    const enqueue = vi.fn(async () => undefined);
    await scheduleCommentNotifications(
      {
        prisma,
        queues: { enqueue } as unknown as QueueRegistry,
        appUrl: 'https://exocortex.test/',
      },
      {
        workspaceId,
        type: 'comment.created',
        payload: { documentId, commentId: await comment(memberId) },
        correlationId: 'c1',
      },
    );

    const [, payload] = enqueue.mock.calls[0] as unknown as [
      string,
      { kind: string; notification: { url: string; tag: string; title: string } },
    ];
    expect(payload.kind).toBe('COMMENT');
    expect(payload.notification.url).toBe(
      `https://exocortex.test/arbeitsbereich/${workspaceId}/seite/${documentId}`,
    );
    expect(payload.notification.tag).toBe(`comment:${documentId}`);
    expect(payload.notification.title).toBe('Mitglied hat kommentiert');
  });
});
