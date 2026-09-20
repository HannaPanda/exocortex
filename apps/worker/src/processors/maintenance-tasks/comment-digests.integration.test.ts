import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadDotEnv } from '@exocortex/config';
import { type MailMessage, type Settings, settingsSchema } from '@exocortex/contracts';
import { createPrismaClient, generateOrderKey, type PrismaClient } from '@exocortex/database';
import { createLogger } from '@exocortex/logger';
import { type QueueRegistry } from '@exocortex/queue';

import { sendCommentDigests } from './comment-digests';
import { scheduleCommentNotifications } from './comment-notifications';
import { type MaintenanceContext } from './context';

/**
 * Comment mail, collected rather than sent one letter at a time (issue #106,
 * ADR-053).
 *
 * The four things worth proving are the four ways this could hurt somebody:
 * a mail about a page they may no longer read, the same mail twice, a mail
 * lost because a send failed, and a mail at all for somebody who asked for
 * none. Everything else about the feature is wording.
 */
loadDotEnv();

const logger = createLogger({ name: 'digest-test', level: 'silent' });

let prisma: PrismaClient;
let workspaceId: string;
let documentId: string;
let otherDocumentId: string;
/** The page's author, who wants a daily digest. */
let authorId: string;
/** Another member, who comments. */
let memberId: string;
/** Not a member. Reaches the page only while a grant says so. */
let outsiderId: string;

const userIds: string[] = [];

async function makeUser(name: string): Promise<string> {
  const user = await prisma.user.create({
    data: {
      email: `digest-${name}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}@exocortex.test`,
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
      name: `Digest ${suffix}`,
      slug: `digest-${suffix}`,
      members: {
        create: [
          { userId: authorId, role: 'OWNER' },
          { userId: memberId, role: 'MEMBER' },
        ],
      },
    },
  });
  workspaceId = workspace.id;

  const page = async (title: string) =>
    (
      await prisma.document.create({
        data: {
          workspaceId,
          title,
          orderKey: generateOrderKey(null, null),
          createdById: authorId,
          updatedById: authorId,
        },
      })
    ).id;
  documentId = await page('Kommentierte Seite');
  otherDocumentId = await page('Zweite Seite');
});

afterAll(async () => {
  await prisma.workspace.deleteMany({ where: { id: workspaceId } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.commentDigestEntry.deleteMany({ where: { workspaceId } });
  await prisma.comment.deleteMany({ where: { workspaceId } });
  await prisma.documentShare.deleteMany({ where: { workspaceId } });
  await prisma.notificationPreference.deleteMany({ where: { userId: { in: userIds } } });
});

/** What the deployment is configured to do, with the defaults everywhere else. */
function settingsWith(overrides: Partial<Settings>): Settings {
  return { ...settingsSchema.parse({}), ...overrides };
}

/** A comment, dispatched through the same hook the outbox calls. */
async function commentAndDispatch(
  createdById: string,
  options: { documentId?: string; parentId?: string | null; body?: string } = {},
): Promise<string> {
  const target = options.documentId ?? documentId;
  const created = await prisma.comment.create({
    data: {
      workspaceId,
      documentId: target,
      parentId: options.parentId ?? null,
      body: options.body ?? 'Ein Kommentar',
      createdById,
    },
  });
  await scheduleCommentNotifications(
    {
      prisma,
      queues: { enqueue: async () => undefined } as unknown as QueueRegistry,
      appUrl: 'https://exocortex.test',
    },
    {
      workspaceId,
      type: 'comment.created',
      payload: { documentId: target, commentId: created.id },
      correlationId: 'c1',
    },
  );
  return created.id;
}

interface SentMail {
  recipient: string;
  mail: MailMessage;
  jobId: string | undefined;
}

/** Runs the sweep and returns the mails it handed to the queue. */
async function sweep(
  overrides: Partial<Settings> = {},
  options: { enqueueFails?: boolean } = {},
): Promise<SentMail[]> {
  const sent: SentMail[] = [];
  const enqueue = vi.fn(
    async (
      _queue: string,
      payload: { recipient: string; mail: MailMessage },
      jobOptions?: { jobId?: string },
    ) => {
      if (options.enqueueFails === true) throw new Error('Redis is having a moment');
      sent.push({ recipient: payload.recipient, mail: payload.mail, jobId: jobOptions?.jobId });
      return 'job';
    },
  );

  const context = {
    prisma,
    queues: { enqueue } as unknown as QueueRegistry,
    settings: async () => settingsWith(overrides),
    appUrl: 'https://exocortex.test',
    logger,
    payload: { correlationId: 'sweep', task: 'send-comment-digests' },
  } as unknown as MaintenanceContext;

  await sendCommentDigests(context);
  return sent;
}

async function wants(userId: string, mode: 'IMMEDIATE' | 'DAILY_DIGEST'): Promise<void> {
  await prisma.notificationPreference.create({
    data: { userId, kind: 'COMMENT', channel: 'EMAIL', mode },
  });
}

/** Everything the given person is still owed. */
async function owed(userId: string): Promise<number> {
  return prisma.commentDigestEntry.count({ where: { userId, sentAt: null } });
}

describe('collecting comment mail', () => {
  it('writes nothing at all while nobody has switched it on', async () => {
    await commentAndDispatch(memberId);
    expect(await prisma.commentDigestEntry.count({ where: { workspaceId } })).toBe(0);
  });

  it('never collects somebody their own comment', async () => {
    await wants(authorId, 'IMMEDIATE');
    await commentAndDispatch(authorId);
    expect(await owed(authorId)).toBe(0);
  });

  it('collects one entry per person and comment, however often the event is dispatched', async () => {
    await wants(authorId, 'IMMEDIATE');
    const commentId = await commentAndDispatch(memberId);
    // The outbox redelivered the same row: the unique index is what makes the
    // second dispatch a no-op rather than a second line in the mail.
    await scheduleCommentNotifications(
      {
        prisma,
        queues: { enqueue: async () => undefined } as unknown as QueueRegistry,
        appUrl: 'https://exocortex.test',
      },
      {
        workspaceId,
        type: 'comment.created',
        payload: { documentId, commentId },
        correlationId: 'c1',
      },
    );
    expect(await owed(authorId)).toBe(1);
  });

  it('forgets what it collected when the comment is deleted', async () => {
    await wants(authorId, 'IMMEDIATE');
    const commentId = await commentAndDispatch(memberId);
    await prisma.comment.delete({ where: { id: commentId } });
    expect(await owed(authorId)).toBe(0);
  });
});

describe('sending comment mail', () => {
  it('groups several comments on the same page into one mail', async () => {
    await wants(authorId, 'IMMEDIATE');
    await commentAndDispatch(memberId, { body: 'Erster' });
    await commentAndDispatch(memberId, { body: 'Zweiter' });
    await commentAndDispatch(memberId, { documentId: otherDocumentId, body: 'Woanders' });

    const sent = await sweep({ 'notifications.commentMailDebounceMinutes': 0 });
    expect(sent).toHaveLength(1);
    const mail = sent[0]?.mail;
    expect(mail?.template).toBe('COMMENT_DIGEST');
    if (mail?.template !== 'COMMENT_DIGEST') throw new Error('wrong template');
    expect(mail.commentCount).toBe(3);
    expect(mail.pages).toHaveLength(2);
    const page = mail.pages.find((entry) => entry.title === 'Kommentierte Seite');
    expect(page?.comments.map((comment) => comment.preview)).toEqual(['Erster', 'Zweiter']);
    expect(page?.url).toBe(
      `https://exocortex.test/arbeitsbereich/${workspaceId}/seite/${documentId}`,
    );
  });

  it('waits out the debounce window before sending immediately', async () => {
    await wants(authorId, 'IMMEDIATE');
    await commentAndDispatch(memberId);

    expect(await sweep({ 'notifications.commentMailDebounceMinutes': 5 })).toHaveLength(0);
    expect(await owed(authorId)).toBe(1);
    expect(await sweep({ 'notifications.commentMailDebounceMinutes': 0 })).toHaveLength(1);
  });

  it('holds a daily digest until the hour has passed, then sends it once', async () => {
    await wants(authorId, 'DAILY_DIGEST');
    await commentAndDispatch(memberId);

    // The slot the sweep compares against is the most recent time the clock
    // struck the digest hour, which is necessarily before now -- and this
    // entry was written after it. Nothing is due yet, whatever the debounce
    // window for immediate mail happens to be.
    const daily = {
      'notifications.digestHour': new Date().getUTCHours(),
      'notifications.digestTimeZone': 'UTC',
      'notifications.commentMailDebounceMinutes': 0,
    } as const;
    expect(await sweep(daily)).toHaveLength(0);
    expect(await owed(authorId)).toBe(1);

    // A day older, so the slot has come round since it was written.
    await prisma.commentDigestEntry.updateMany({
      where: { userId: authorId, sentAt: null },
      data: { createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000) },
    });

    expect(await sweep(daily)).toHaveLength(1);
    expect(await owed(authorId)).toBe(0);
    // And not again the next minute, nor the next day.
    expect(await sweep(daily)).toHaveLength(0);
  });

  it('sends a digest once and never again the next day', async () => {
    await wants(authorId, 'IMMEDIATE');
    await commentAndDispatch(memberId);

    expect(await sweep({ 'notifications.commentMailDebounceMinutes': 0 })).toHaveLength(1);
    expect(await sweep({ 'notifications.commentMailDebounceMinutes': 0 })).toHaveLength(0);
  });

  it('keeps everything owed when the enqueue fails, and sends it on the next run', async () => {
    await wants(authorId, 'IMMEDIATE');
    await commentAndDispatch(memberId);

    await expect(
      sweep({ 'notifications.commentMailDebounceMinutes': 0 }, { enqueueFails: true }),
    ).rejects.toThrow();
    expect(await owed(authorId)).toBe(1);

    const sent = await sweep({ 'notifications.commentMailDebounceMinutes': 0 });
    expect(sent).toHaveLength(1);
  });

  it('names the mail after the oldest owed entry, so a retry is the same job', async () => {
    await wants(authorId, 'IMMEDIATE');
    await commentAndDispatch(memberId);
    const entry = await prisma.commentDigestEntry.findFirstOrThrow({
      where: { userId: authorId },
    });

    const sent = await sweep({ 'notifications.commentMailDebounceMinutes': 0 });
    expect(sent[0]?.jobId).toBe(`comment-digest-${authorId}-${entry.createdAt.toISOString()}`);
  });

  it('leaves out a page the reader lost access to before the mail went out', async () => {
    await wants(outsiderId, 'IMMEDIATE');
    const share = await prisma.documentShare.create({
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
    // Collected while the grant held: the outsider is in the thread.
    const root = await commentAndDispatch(outsiderId);
    await commentAndDispatch(memberId, { parentId: root });
    expect(await owed(outsiderId)).toBe(1);

    // Withdrawn afterwards. The pointer is answered with silence rather than
    // with the title of a page they can no longer open.
    await prisma.documentShare.update({
      where: { id: share.id },
      data: { revokedAt: new Date() },
    });

    expect(await sweep({ 'notifications.commentMailDebounceMinutes': 0 })).toHaveLength(0);
    expect(await owed(outsiderId)).toBe(0);
  });

  it('throws away what it collected when somebody switches the mail off', async () => {
    await wants(authorId, 'IMMEDIATE');
    await commentAndDispatch(memberId);

    await prisma.notificationPreference.deleteMany({
      where: { userId: authorId, kind: 'COMMENT', channel: 'EMAIL' },
    });

    expect(await sweep({ 'notifications.commentMailDebounceMinutes': 0 })).toHaveLength(0);
    expect(await prisma.commentDigestEntry.count({ where: { userId: authorId } })).toBe(0);
  });

  it('writes nothing to a switched-off account', async () => {
    await wants(authorId, 'IMMEDIATE');
    await commentAndDispatch(memberId);
    await prisma.user.update({ where: { id: authorId }, data: { disabledAt: new Date() } });

    expect(await sweep({ 'notifications.commentMailDebounceMinutes': 0 })).toHaveLength(0);
    expect(await prisma.commentDigestEntry.count({ where: { userId: authorId } })).toBe(0);

    await prisma.user.update({ where: { id: authorId }, data: { disabledAt: null } });
  });
});
