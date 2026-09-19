import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadDotEnv } from '@exocortex/config';
import { createPrismaClient, type PrismaClient } from '@exocortex/database';

import { ConnectionsService } from './connections.service';

/**
 * Runs against the real database, like the MCP credential tests, because the
 * behaviour worth proving is what a disconnect actually removes: rows in three
 * tables, scoped to one account. A mocked Prisma would only prove the mock.
 */
loadDotEnv();

const HOUR = 60 * 60 * 1000;

let prisma: PrismaClient;
let service: ConnectionsService;
let userId: string;
let otherUserId: string;
let suffix: string;

function clientIdFor(label: string): string {
  return `conn-test-${label}-${suffix}`;
}

async function application(label: string, name: string): Promise<string> {
  const clientId = clientIdFor(label);
  await prisma.oauthClient.create({
    data: {
      name,
      clientId,
      redirectUris: ['https://chatgpt.com/connector_platform_oauth_redirect'],
      tokenEndpointAuthMethod: 'none',
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  });
  return clientId;
}

async function consent(clientId: string, forUserId: string, createdAt = new Date()): Promise<void> {
  await prisma.oauthConsent.create({
    data: {
      clientId,
      userId: forUserId,
      scopes: ['openid', 'profile', 'offline_access'],
      createdAt,
      updatedAt: createdAt,
    },
  });
}

/**
 * A refresh grant, which is what a live connection looks like now: the access
 * token is a JWT the server keeps no copy of.
 */
async function grant(
  clientId: string,
  forUserId: string,
  overrides: { expiresAt?: Date; rotatedAt?: Date } = {},
): Promise<void> {
  const unique = Math.random().toString(36).slice(2, 12);
  await prisma.oauthRefreshToken.create({
    data: {
      token: `rt_${unique}`,
      clientId,
      userId: forUserId,
      scopes: ['openid', 'profile', 'offline_access'],
      expiresAt: overrides.expiresAt ?? new Date(Date.now() + 30 * 24 * HOUR),
      createdAt: new Date(),
      ...(overrides.rotatedAt === undefined ? {} : { rotatedAt: overrides.rotatedAt }),
    },
  });
}

beforeAll(async () => {
  prisma = createPrismaClient({ databaseUrl: process.env.DATABASE_URL });
  service = new ConnectionsService(prisma);

  suffix = Date.now().toString(36);
  const [user, other] = await Promise.all([
    prisma.user.create({
      data: { email: `conn-${suffix}@exocortex.test`, name: 'Verbindungen', emailVerified: true },
    }),
    prisma.user.create({
      data: {
        email: `conn-other-${suffix}@exocortex.test`,
        name: 'Zweiter Mensch',
        emailVerified: true,
      },
    }),
  ]);
  userId = user.id;
  otherUserId = other.id;
});

afterAll(async () => {
  await prisma.oauthClient.deleteMany({ where: { clientId: { startsWith: 'conn-test-' } } });
  await prisma.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
  await prisma.$disconnect();
});

describe('ConnectionsService.list', () => {
  it('reports a connected client with its consent date and live grant', async () => {
    const clientId = await application('listed', 'ChatGPT');
    const connectedAt = new Date(Date.now() - 5 * HOUR);
    await consent(clientId, userId, connectedAt);
    const lastAuthorizedAt = new Date(Date.now() - HOUR);
    await grant(clientId, userId, { rotatedAt: lastAuthorizedAt });

    const { applications } = await service.list(userId);
    const entry = applications.find((application) => application.clientId === clientId);

    expect(entry).toMatchObject({
      name: 'ChatGPT',
      redirectUrls: ['https://chatgpt.com/connector_platform_oauth_redirect'],
      connectedAt: connectedAt.toISOString(),
      lastAuthorizedAt: lastAuthorizedAt.toISOString(),
      activeGrantCount: 1,
      disabled: false,
    });
  });

  it('counts only grants that have not expired', async () => {
    const clientId = await application('expired', 'Alter Connector');
    await consent(clientId, userId);
    await grant(clientId, userId, { expiresAt: new Date(Date.now() - HOUR) });

    const { applications } = await service.list(userId);
    const entry = applications.find((application) => application.clientId === clientId);

    expect(entry?.activeGrantCount).toBe(0);
    // Still listed: a client whose grant merely expired is one a person said
    // yes to, so hiding it would hide a decision that is still on the record.
    expect(entry).toBeDefined();
  });

  it('lists a client that still holds a grant but has no consent row', async () => {
    const clientId = await application('tokenonly', 'Ohne Zustimmung');
    await grant(clientId, userId);

    const { applications } = await service.list(userId);
    expect(applications.map((entry) => entry.clientId)).toContain(clientId);
  });

  it('never shows another account its neighbour connections', async () => {
    const clientId = await application('foreign', 'Fremder Connector');
    await consent(clientId, otherUserId);
    await grant(clientId, otherUserId);

    const { applications } = await service.list(userId);
    expect(applications.map((entry) => entry.clientId)).not.toContain(clientId);
  });
});

describe('ConnectionsService.disconnect', () => {
  it('removes grants and consent and switches the client off', async () => {
    const clientId = await application('cut', 'ChatGPT');
    await consent(clientId, userId);
    await grant(clientId, userId);

    await expect(service.disconnect(userId, clientId)).resolves.toEqual({
      disconnected: true,
      clientDisabled: true,
    });

    expect(await prisma.oauthRefreshToken.count({ where: { clientId } })).toBe(0);
    expect(await prisma.oauthConsent.count({ where: { clientId } })).toBe(0);
    const row = await prisma.oauthClient.findUnique({ where: { clientId } });
    expect(row?.disabled).toBe(true);
    expect((await service.list(userId)).applications.map((entry) => entry.clientId)).not.toContain(
      clientId,
    );
  });

  it('leaves the client running while somebody else still uses it', async () => {
    const clientId = await application('shared', 'Geteilter Connector');
    await consent(clientId, userId);
    await grant(clientId, userId);
    await consent(clientId, otherUserId);
    await grant(clientId, otherUserId);

    await expect(service.disconnect(userId, clientId)).resolves.toEqual({
      disconnected: true,
      clientDisabled: false,
    });

    const row = await prisma.oauthClient.findUnique({ where: { clientId } });
    expect(row?.disabled ?? false).toBe(false);
    expect(await prisma.oauthRefreshToken.count({ where: { clientId, userId: otherUserId } })).toBe(
      1,
    );
    expect(await prisma.oauthConsent.count({ where: { clientId, userId: otherUserId } })).toBe(1);
  });

  it('succeeds a second time instead of erroring', async () => {
    const clientId = await application('twice', 'Doppelt geklickt');
    await consent(clientId, userId);

    await service.disconnect(userId, clientId);
    await expect(service.disconnect(userId, clientId)).resolves.toMatchObject({
      disconnected: true,
    });
  });

  it('refuses a client that does not exist', async () => {
    await expect(service.disconnect(userId, 'conn-test-nothing')).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});
