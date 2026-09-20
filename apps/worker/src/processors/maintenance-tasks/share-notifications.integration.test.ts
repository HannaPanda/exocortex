import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadDotEnv } from '@exocortex/config';
import {
  createPrismaClient,
  generateOrderKey,
  type Prisma,
  type PrismaClient,
} from '@exocortex/database';
import { type QueueRegistry } from '@exocortex/queue';

import { scheduleShareNotifications } from './share-notifications';

/**
 * Who is written to when a grant changes, and what the mail may carry
 * (issue #103).
 *
 * Two halves are worth a test each. The recipient half is where the privacy
 * promise lives: the address comes from the account rather than from the
 * sharing request, a switched-off account is not written to, and a link has
 * nobody to write to at all. The content half is where the other one lives: a
 * withdrawal must not hand over a link into a page the reader can no longer
 * open.
 */
loadDotEnv();

let prisma: PrismaClient;
let workspaceId: string;
let documentId: string;
/** The workspace owner; does the sharing. */
let ownerId: string;
/** Holds the grant. Not a member of anything. */
let granteeId: string;
let granteeEmail: string;

const userIds: string[] = [];

async function makeUser(name: string): Promise<{ id: string; email: string }> {
  const email = `share-${name}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}@exocortex.test`;
  const user = await prisma.user.create({ data: { email, name, emailVerified: true } });
  userIds.push(user.id);
  return { id: user.id, email };
}

beforeAll(async () => {
  prisma = createPrismaClient({ databaseUrl: process.env.DATABASE_URL });
  const suffix = Date.now().toString(36);

  const owner = await makeUser('Johanna');
  ownerId = owner.id;
  const grantee = await makeUser('Gast');
  granteeId = grantee.id;
  granteeEmail = grantee.email;

  const workspace = await prisma.workspace.create({
    data: {
      name: `Freigaben ${suffix}`,
      slug: `freigaben-${suffix}`,
      members: { create: [{ userId: ownerId, role: 'OWNER' }] },
    },
  });
  workspaceId = workspace.id;

  const document = await prisma.document.create({
    data: {
      workspaceId,
      title: 'Reisekasse',
      orderKey: generateOrderKey(null, null),
      createdById: ownerId,
      updatedById: ownerId,
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
  await prisma.documentShare.deleteMany({ where: { workspaceId } });
  await prisma.user.update({ where: { id: granteeId }, data: { disabledAt: null } });
});

async function share(
  overrides: Partial<Prisma.DocumentShareUncheckedCreateInput> = {},
): Promise<string> {
  const data: Prisma.DocumentShareUncheckedCreateInput = {
    workspaceId,
    documentId,
    kind: 'USER',
    permission: 'READ',
    scope: 'PAGE_ONLY',
    granteeId,
    createdById: ownerId,
    ...overrides,
  };
  const row = await prisma.documentShare.create({ data });
  return row.id;
}

interface EnqueuedMail {
  recipient: string;
  mail: Record<string, unknown>;
}

/** Runs the dispatcher hook and returns the mail jobs it enqueued. */
async function enqueued(input: {
  shareId: string;
  change: 'granted' | 'changed' | 'revoked';
  actorId?: string;
  eventId?: string;
}): Promise<{ jobs: EnqueuedMail[]; jobIds: (string | undefined)[] }> {
  const enqueue = vi.fn(async () => undefined);
  await scheduleShareNotifications(
    { prisma, queues: { enqueue } as unknown as QueueRegistry, appUrl: 'https://exocortex.test/' },
    {
      eventId: input.eventId ?? 'evt1',
      workspaceId,
      type: 'document.share.changed',
      payload: {
        shareId: input.shareId,
        documentId,
        granteeId,
        actorId: input.actorId ?? ownerId,
        change: input.change,
      },
      correlationId: 'c1',
    },
  );
  const calls = enqueue.mock.calls as unknown as [
    string,
    EnqueuedMail,
    { jobId?: string } | undefined,
  ][];
  return {
    jobs: calls.map((call) => call[1]),
    jobIds: calls.map((call) => call[2]?.jobId),
  };
}

describe('scheduleShareNotifications', () => {
  it('writes to the address on the account, with what the grant allows', async () => {
    const { jobs, jobIds } = await enqueued({
      shareId: await share({ permission: 'WRITE', scope: 'SUBTREE' }),
      change: 'granted',
    });

    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.recipient).toBe(granteeEmail);
    expect(jobs[0]?.mail).toMatchObject({
      template: 'SHARE_GRANTED',
      sharedByName: 'Johanna',
      documentTitle: 'Reisekasse',
      permission: 'WRITE',
      scope: 'SUBTREE',
      url: `https://exocortex.test/geteilt/${documentId}`,
      expiresAt: null,
    });
    // Derived from the outbox row, so a redelivered event asks BullMQ to add
    // the job it already has rather than a second one.
    expect(jobIds).toEqual(['share-mail-evt1']);
  });

  it('sends the change mail with the state that holds afterwards', async () => {
    const expiresAt = new Date('2026-12-24T10:00:00.000Z');
    const { jobs } = await enqueued({
      shareId: await share({ permission: 'WRITE', expiresAt }),
      change: 'changed',
    });

    expect(jobs[0]?.mail).toMatchObject({
      template: 'SHARE_CHANGED',
      changedByName: 'Johanna',
      permission: 'WRITE',
      expiresAt: expiresAt.toISOString(),
    });
  });

  it('gives a withdrawal the list of remaining shares and no page link', async () => {
    const { jobs } = await enqueued({
      shareId: await share({ revokedAt: new Date() }),
      change: 'revoked',
    });

    expect(jobs[0]?.mail).toMatchObject({
      template: 'SHARE_REVOKED',
      revokedByName: 'Johanna',
      documentTitle: 'Reisekasse',
      url: 'https://exocortex.test/geteilt',
    });
    expect(jobs[0]?.mail).not.toHaveProperty('permission');
  });

  it('writes nothing about a public link', async () => {
    const id = await share({
      kind: 'PUBLIC_LINK',
      granteeId: null,
      tokenHash: `hash-${Date.now()}`,
      tokenPrefix: 'abcd1234',
    });
    expect((await enqueued({ shareId: id, change: 'granted' })).jobs).toEqual([]);
  });

  it('does not write to a switched-off account', async () => {
    const id = await share();
    await prisma.user.update({ where: { id: granteeId }, data: { disabledAt: new Date() } });
    expect((await enqueued({ shareId: id, change: 'granted' })).jobs).toEqual([]);
  });

  it('says nothing when the grant is gone before the sweep reaches it', async () => {
    const id = await share();
    await prisma.documentShare.delete({ where: { id } });
    expect((await enqueued({ shareId: id, change: 'granted' })).jobs).toEqual([]);
  });

  it('does not announce access that was withdrawn in the meantime', async () => {
    const id = await share({ revokedAt: new Date() });
    expect((await enqueued({ shareId: id, change: 'granted' })).jobs).toEqual([]);
  });

  it('names a deleted actor as somebody rather than as nobody', async () => {
    const stranger = await makeUser('Fremde');
    const id = await share({ createdById: stranger.id });
    await prisma.documentShare.update({ where: { id }, data: { createdById: ownerId } });
    await prisma.user.delete({ where: { id: stranger.id } });

    const { jobs } = await enqueued({ shareId: id, change: 'granted', actorId: stranger.id });
    expect(jobs[0]?.mail).toMatchObject({ sharedByName: 'Jemand' });
  });

  it('ignores an event that is not about a share', async () => {
    const enqueue = vi.fn(async () => undefined);
    await scheduleShareNotifications(
      { prisma, queues: { enqueue } as unknown as QueueRegistry, appUrl: 'https://exocortex.test' },
      {
        eventId: 'evt2',
        workspaceId,
        type: 'document.updated',
        payload: { documentId },
        correlationId: 'c1',
      },
    );
    expect(enqueue).not.toHaveBeenCalled();
  });
});
