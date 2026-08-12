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
  await prisma.oauthApplication.create({
    data: {
      name,
      clientId,
      redirectUrls: 'https://chatgpt.com/connector_platform_oauth_redirect',
      type: 'public',
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
      scopes: 'openid profile offline_access',
      consentGiven: true,
      createdAt,
      updatedAt: createdAt,
    },
  });
}

async function accessToken(
  clientId: string,
  forUserId: string,
  overrides: { expiresAt?: Date; updatedAt?: Date } = {},
): Promise<void> {
  const unique = Math.random().toString(36).slice(2, 12);
  await prisma.oauthAccessToken.create({
    data: {
      accessToken: `at_${unique}`,
      refreshToken: `rt_${unique}`,
      accessTokenExpiresAt: overrides.expiresAt ?? new Date(Date.now() + HOUR),
      refreshTokenExpiresAt: new Date(Date.now() + 30 * 24 * HOUR),
      clientId,
      userId: forUserId,
      scopes: 'openid profile offline_access',
      createdAt: new Date(),
      updatedAt: overrides.updatedAt ?? new Date(),
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
  await prisma.oauthApplication.deleteMany({ where: { clientId: { startsWith: 'conn-test-' } } });
  await prisma.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
  await prisma.$disconnect();
});

describe('ConnectionsService.list', () => {
  it('reports a connected client with its consent date and live token', async () => {
    const clientId = await application('listed', 'ChatGPT');
    const connectedAt = new Date(Date.now() - 5 * HOUR);
    await consent(clientId, userId, connectedAt);
    const lastAuthorizedAt = new Date(Date.now() - HOUR);
    await accessToken(clientId, userId, { updatedAt: lastAuthorizedAt });

    const { applications } = await service.list(userId);
    const entry = applications.find((application) => application.clientId === clientId);

    expect(entry).toMatchObject({
      name: 'ChatGPT',
      redirectUrls: ['https://chatgpt.com/connector_platform_oauth_redirect'],
      connectedAt: connectedAt.toISOString(),
      lastAuthorizedAt: lastAuthorizedAt.toISOString(),
      activeTokenCount: 1,
      disabled: false,
    });
  });

  it('counts only tokens that have not expired', async () => {
    const clientId = await application('expired', 'Alter Connector');
    await consent(clientId, userId);
    await accessToken(clientId, userId, { expiresAt: new Date(Date.now() - HOUR) });

    const { applications } = await service.list(userId);
    const entry = applications.find((application) => application.clientId === clientId);

    expect(entry?.activeTokenCount).toBe(0);
    // Still listed: a client whose token merely expired can refresh itself, so
    // hiding it would hide a connection that is very much still standing.
    expect(entry).toBeDefined();
  });

  it('lists a client that still holds a token but has no consent row', async () => {
    const clientId = await application('tokenonly', 'Ohne Zustimmung');
    await accessToken(clientId, userId);

    const { applications } = await service.list(userId);
    expect(applications.map((entry) => entry.clientId)).toContain(clientId);
  });

  it('never shows another account its neighbour connections', async () => {
    const clientId = await application('foreign', 'Fremder Connector');
    await consent(clientId, otherUserId);
    await accessToken(clientId, otherUserId);

    const { applications } = await service.list(userId);
    expect(applications.map((entry) => entry.clientId)).not.toContain(clientId);
  });
});

describe('ConnectionsService.disconnect', () => {
  it('removes tokens and consent and switches the client off', async () => {
    const clientId = await application('cut', 'ChatGPT');
    await consent(clientId, userId);
    await accessToken(clientId, userId);

    await expect(service.disconnect(userId, clientId)).resolves.toEqual({
      disconnected: true,
      clientDisabled: true,
    });

    expect(await prisma.oauthAccessToken.count({ where: { clientId } })).toBe(0);
    expect(await prisma.oauthConsent.count({ where: { clientId } })).toBe(0);
    const row = await prisma.oauthApplication.findUnique({ where: { clientId } });
    expect(row?.disabled).toBe(true);
    expect((await service.list(userId)).applications.map((entry) => entry.clientId)).not.toContain(
      clientId,
    );
  });

  it('leaves the client running while somebody else still uses it', async () => {
    const clientId = await application('shared', 'Geteilter Connector');
    await consent(clientId, userId);
    await accessToken(clientId, userId);
    await consent(clientId, otherUserId);
    await accessToken(clientId, otherUserId);

    await expect(service.disconnect(userId, clientId)).resolves.toEqual({
      disconnected: true,
      clientDisabled: false,
    });

    const row = await prisma.oauthApplication.findUnique({ where: { clientId } });
    expect(row?.disabled ?? false).toBe(false);
    expect(await prisma.oauthAccessToken.count({ where: { clientId, userId: otherUserId } })).toBe(
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
