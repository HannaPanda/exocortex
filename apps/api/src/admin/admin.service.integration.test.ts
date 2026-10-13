import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadDotEnv } from '@exocortex/config';
import { adminUserListQuerySchema } from '@exocortex/contracts';
import { createPrismaClient, type PrismaClient } from '@exocortex/database';
import { createLogger, type Logger } from '@exocortex/logger';

import { type SettingsService } from '../platform/settings.service';
import { type RealtimeService } from '../realtime/realtime.service';

import { AdminService } from './admin.service';

/**
 * Switching accounts off, and deleting the ones that can be deleted (issue #3).
 *
 * The interesting property is not that a flag flips. It is that disabling takes
 * away every credential in the same transaction, because that is what makes the
 * guarantee hold without a per-request lookup: a disabled account is one that has
 * nothing left to act with.
 *
 * `SettingsService` is faked because nothing here touches settings; the two
 * methods under test never reach it. `RealtimeService` is recorded rather than
 * faked away: publishing the revocation is half of what disabling an account
 * has to do since issue #62, so the test reads what was published.
 */
loadDotEnv();

const logger: Logger = createLogger({ name: 'api-test', level: 'silent' });
const settings = {} as unknown as SettingsService;

const revocations: { userId: string; workspaceId: string | null; reason: string }[] = [];
const realtime = {
  revoke: async (input: { userId: string; workspaceId: string | null; reason: string }) => {
    revocations.push(input);
  },
} as unknown as RealtimeService;

let prisma: PrismaClient;
let service: AdminService;
let actorId: string;
let victimId: string;
let authorId: string;
let secondAdminId: string;
let workspaceId: string;

beforeAll(async () => {
  prisma = createPrismaClient({ databaseUrl: process.env.DATABASE_URL });
  service = new AdminService(prisma, logger, settings, realtime);

  const suffix = Date.now().toString(36);
  const [actor, victim, author, secondAdmin] = await Promise.all([
    prisma.user.create({
      data: {
        email: `adm-actor-${suffix}@exocortex.test`,
        name: 'Actor',
        emailVerified: true,
        role: 'ADMIN',
      },
    }),
    prisma.user.create({
      data: { email: `adm-victim-${suffix}@exocortex.test`, name: 'Victim', emailVerified: true },
    }),
    prisma.user.create({
      data: { email: `adm-author-${suffix}@exocortex.test`, name: 'Author', emailVerified: true },
    }),
    prisma.user.create({
      data: {
        email: `adm-second-${suffix}@exocortex.test`,
        name: 'Second admin',
        emailVerified: true,
        role: 'ADMIN',
      },
    }),
  ]);
  actorId = actor.id;
  victimId = victim.id;
  authorId = author.id;
  secondAdminId = secondAdmin.id;

  const workspace = await prisma.workspace.create({
    data: {
      name: `Admin ${suffix}`,
      slug: `admin-${suffix}`,
      members: {
        create: [
          { userId: authorId, role: 'OWNER' },
          { userId: victimId, role: 'MEMBER' },
        ],
      },
    },
  });
  workspaceId = workspace.id;

  // One page authored by `author`, which is what makes that account undeletable.
  await prisma.document.create({
    data: {
      workspaceId,
      title: 'Von Author angelegt',
      type: 'PAGE',
      orderKey: 'a0',
      createdById: authorId,
      updatedById: authorId,
    },
  });
});

afterAll(async () => {
  await prisma.workspace.deleteMany({ where: { id: workspaceId } });
  await prisma.user.deleteMany({
    where: { id: { in: [actorId, victimId, authorId, secondAdminId] } },
  });
  await prisma.$disconnect();
});

describe('disabling an account', () => {
  it('removes every credential it could still act with', async () => {
    await prisma.session.create({
      data: {
        userId: victimId,
        token: `test-session-${Date.now()}`,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    await prisma.apiToken.create({
      data: {
        userId: victimId,
        name: 'Test',
        tokenHash: `hash-${Date.now()}`,
        prefix: 'exo_test',
        scopes: ['read'],
      },
    });

    const updated = await service.setUserDisabled({
      userId: victimId,
      disabled: true,
      actorId,
    });

    expect(updated.disabledAt).not.toBeNull();
    expect(await prisma.session.count({ where: { userId: victimId } })).toBe(0);
    expect(await prisma.apiToken.count({ where: { userId: victimId, revokedAt: null } })).toBe(0);
  });

  it('tells the connection holders, because a websocket has no credential to lose', async () => {
    revocations.length = 0;

    await service.setUserDisabled({ userId: victimId, disabled: true, actorId });

    expect(revocations).toHaveLength(1);
    expect(revocations[0]).toMatchObject({
      userId: victimId,
      workspaceId: null,
      reason: 'account_disabled',
    });

    revocations.length = 0;
    await service.setUserDisabled({ userId: victimId, disabled: false, actorId });
    // Re-enabling publishes nothing: a regained right takes effect at the next
    // sign-in, never by reaching into a connection that outlived the switch-off.
    expect(revocations).toEqual([]);
  });

  it('re-enables without resurrecting the revoked tokens', async () => {
    const updated = await service.setUserDisabled({
      userId: victimId,
      disabled: false,
      actorId,
    });

    expect(updated.disabledAt).toBeNull();
    // Deliberate: a token revoked while the account was off stays revoked. It may
    // have been revoked *because* it leaked, and reactivating a person is not a
    // statement about their old credentials.
    expect(await prisma.apiToken.count({ where: { userId: victimId, revokedAt: null } })).toBe(0);
  });

  it('refuses to disable your own account', async () => {
    await expect(
      service.setUserDisabled({ userId: actorId, disabled: true, actorId }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('allows disabling an admin while another one is left', async () => {
    /**
     * The other half of that guard -- refusing to disable the *last* active admin
     * -- is not reachable from a test.
     *
     * `setUserDisabled` counts every active admin in the deployment, as it must,
     * and these tests run against the same database the deployment uses (like
     * every integration test here). Getting the count down to one would mean
     * switching off the real administrators, which is not a thing a test may do.
     * The branch is three lines and mirrors the identical, equally untested one
     * in `updateUserRole`; what is testable is that it does not fire early.
     */
    const updated = await service.setUserDisabled({
      userId: secondAdminId,
      disabled: true,
      actorId,
    });
    expect(updated.disabledAt).not.toBeNull();

    await service.setUserDisabled({ userId: secondAdminId, disabled: false, actorId });
  });
});

describe('deleting an account', () => {
  it('deletes one that authored nothing', async () => {
    const throwaway = await prisma.user.create({
      data: {
        email: `adm-throwaway-${Date.now().toString(36)}@exocortex.test`,
        name: 'Throwaway',
      },
    });

    await service.deleteUser({ userId: throwaway.id, actorId });

    expect(await prisma.user.count({ where: { id: throwaway.id } })).toBe(0);
  });

  it('refuses one that authored a page, and says so', async () => {
    await expect(service.deleteUser({ userId: authorId, actorId })).rejects.toMatchObject({
      code: 'user_has_content',
    });
    expect(await prisma.user.count({ where: { id: authorId } })).toBe(1);
  });

  it('reports authored content in the list, which is what hides the button', async () => {
    const { users } = await service.listUsers(adminUserListQuerySchema.parse({}));
    const author = users.find((user) => user.id === authorId);
    const victim = users.find((user) => user.id === victimId);

    expect(author?.hasAuthoredContent).toBe(true);
    expect(victim?.hasAuthoredContent).toBe(false);
  });
});

describe('listing accounts (issue #176)', () => {
  const tag = `lst${Date.now().toString(36)}`;
  const day = 24 * 60 * 60 * 1000;
  const ids: Record<'anna' | 'bert' | 'cora' | 'dora', string> = {
    anna: '',
    bert: '',
    cora: '',
    dora: '',
  };
  const list = (input: Record<string, unknown>) =>
    service.listUsers(adminUserListQuerySchema.parse({ q: tag, ...input }));

  beforeAll(async () => {
    for (const name of ['anna', 'bert', 'cora', 'dora'] as const) {
      const user = await prisma.user.create({
        data: {
          email: `${tag}-${name}@exocortex.test`,
          name: `${name} ${tag}`,
          role: name === 'dora' ? 'ADMIN' : 'USER',
          disabledAt: name === 'cora' ? new Date() : null,
        },
      });
      ids[name] = user.id;
    }
    // anna signed in yesterday, bert two months ago, cora and dora not at all.
    await prisma.session.createMany({
      data: [
        {
          userId: ids.anna,
          token: `${tag}-a`,
          createdAt: new Date(Date.now() - day),
          expiresAt: new Date(Date.now() + day),
        },
        {
          userId: ids.bert,
          token: `${tag}-b`,
          createdAt: new Date(Date.now() - 60 * day),
          expiresAt: new Date(Date.now() + day),
        },
      ],
    });
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: Object.values(ids) } } });
  });

  it('searches name and email case-insensitively and counts the matches', async () => {
    const result = await list({ q: `BERT ${tag.toUpperCase()}` });
    expect(result.users.map((user) => user.id)).toEqual([ids.bert]);
    expect(result.total).toBe(1);
    expect((await list({})).total).toBe(4);
  });

  it('filters by role, status and activity', async () => {
    expect((await list({ role: 'admin' })).users.map((user) => user.id)).toEqual([ids.dora]);
    expect((await list({ status: 'disabled' })).users.map((user) => user.id)).toEqual([ids.cora]);
    expect((await list({ status: 'active' })).total).toBe(3);
    expect((await list({ activity: 'recent' })).users.map((user) => user.id)).toEqual([ids.anna]);
    expect((await list({ activity: 'stale' })).users.map((user) => user.id)).toEqual([ids.bert]);
    expect((await list({ activity: 'none', sort: 'name' })).users.map((user) => user.id)).toEqual([
      ids.cora,
      ids.dora,
    ]);
  });

  it('pages a stable order, and the total stays the unpaged count', async () => {
    const first = await list({ sort: 'name', order: 'desc', limit: 3, offset: 0 });
    const second = await list({ sort: 'name', order: 'desc', limit: 3, offset: 3 });
    expect(first.users.map((user) => user.id)).toEqual([ids.dora, ids.cora, ids.bert]);
    expect(second.users.map((user) => user.id)).toEqual([ids.anna]);
    expect(second.total).toBe(4);
  });

  it('sorts by last activity with the accounts that have none last, both ways', async () => {
    const desc = (await list({ sort: 'lastSessionAt', order: 'desc' })).users.map((u) => u.id);
    const asc = (await list({ sort: 'lastSessionAt', order: 'asc' })).users.map((u) => u.id);
    expect(desc.slice(0, 2)).toEqual([ids.anna, ids.bert]);
    expect(asc.slice(0, 2)).toEqual([ids.bert, ids.anna]);
    expect(new Set(desc.slice(2))).toEqual(new Set([ids.cora, ids.dora]));

    const paged = await list({ sort: 'lastSessionAt', order: 'desc', limit: 1, offset: 1 });
    expect(paged.users.map((user) => user.id)).toEqual([ids.bert]);
    expect(paged.total).toBe(4);
  });
});
