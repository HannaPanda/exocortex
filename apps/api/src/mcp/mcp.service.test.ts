import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { generateApiToken, verifyServiceToken } from '@exocortex/auth';
import { type ApiEnv, loadApiEnv, loadDotEnv } from '@exocortex/config';
import { createPrismaClient, type PrismaClient } from '@exocortex/database';
import { createLogger, type Logger } from '@exocortex/logger';

import { OutboxService } from '../common/outbox.service';
import { SettingsService } from '../platform/settings.service';

import { McpService } from './mcp.service';

/**
 * Runs against the real database, like the guard tests, because what is worth
 * proving is the credential handling: which bearer tokens open `/api/mcp`, and
 * what each of them is allowed to carry into the loopback call afterwards. A
 * mocked Prisma would only prove that the mock was written to match the code.
 */
loadDotEnv();

const logger: Logger = createLogger({ name: 'mcp-test', level: 'silent' });
const env: ApiEnv = loadApiEnv({
  NODE_ENV: 'test',
  APP_URL: 'http://localhost:3210',
  DATABASE_URL:
    process.env.DATABASE_URL ?? 'postgresql://exocortex:exocortex@127.0.0.1:5433/exocortex',
  REDIS_URL: process.env.REDIS_URL ?? 'redis://127.0.0.1:6380',
  BETTER_AUTH_SECRET: 'a'.repeat(32),
  BETTER_AUTH_URL: 'http://localhost:3210',
  COLLABORATION_TICKET_SECRET: 'b'.repeat(32),
  SERVICE_TOKEN_SECRET: 'c'.repeat(32),
  S3_ENDPOINT: 'http://127.0.0.1:9110',
  S3_BUCKET: 'exocortex',
  S3_ACCESS_KEY_ID: 'key',
  S3_SECRET_ACCESS_KEY: 'secret',
  SMTP_HOST: '127.0.0.1',
  SMTP_PORT: '1026',
  SMTP_FROM: 'eXocortex <no-reply@exocortex.app>',
  PUBLIC_API_URL: 'http://localhost:3211',
  PUBLIC_COLLABORATION_URL: 'ws://localhost:3212',
});

let prisma: PrismaClient;
let service: McpService;
let userId: string;
let clientId: string;

const HOUR = 60 * 60 * 1000;

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

async function apiToken(
  scopes: string[],
  overrides: { revoked?: boolean; expired?: boolean } = {},
) {
  const generated = generateApiToken();
  await prisma.apiToken.create({
    data: {
      userId,
      name: `MCP ${scopes.join('+') || 'none'}`,
      tokenHash: generated.tokenHash,
      prefix: generated.prefix,
      scopes,
      revokedAt: overrides.revoked === true ? new Date() : null,
      expiresAt: overrides.expired === true ? new Date(Date.now() - HOUR) : null,
    },
  });
  return generated.secret;
}

async function oauthToken(
  overrides: { expiresAt?: Date; disabledClient?: boolean; withoutUser?: boolean } = {},
): Promise<string> {
  const suffix = Math.random().toString(36).slice(2, 10);
  const accessToken = `at_${suffix}`;
  let targetClientId = clientId;

  if (overrides.disabledClient === true) {
    targetClientId = `client-disabled-${suffix}`;
    await prisma.oauthApplication.create({
      data: {
        name: 'Abgeschalteter Connector',
        clientId: targetClientId,
        redirectUrls: 'https://example.invalid/callback',
        type: 'public',
        disabled: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
  }

  await prisma.oauthAccessToken.create({
    data: {
      accessToken,
      refreshToken: `rt_${suffix}`,
      accessTokenExpiresAt: overrides.expiresAt ?? new Date(Date.now() + HOUR),
      refreshTokenExpiresAt: new Date(Date.now() + 30 * 24 * HOUR),
      clientId: targetClientId,
      userId: overrides.withoutUser === true ? null : userId,
      scopes: 'openid profile offline_access',
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  });
  return accessToken;
}

beforeAll(async () => {
  prisma = createPrismaClient({ databaseUrl: process.env.DATABASE_URL });
  service = new McpService(
    prisma,
    env,
    logger,
    new SettingsService(prisma, logger, new OutboxService(prisma, logger)),
  );

  const suffix = Date.now().toString(36);
  const user = await prisma.user.create({
    data: { email: `mcp-${suffix}@exocortex.test`, name: 'MCP User', emailVerified: true },
  });
  userId = user.id;

  clientId = `client-chatgpt-${suffix}`;
  await prisma.oauthApplication.create({
    data: {
      name: 'ChatGPT',
      clientId,
      redirectUrls: 'https://chatgpt.com/connector_platform_oauth_redirect',
      type: 'public',
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  });
});

afterAll(async () => {
  await prisma.oauthApplication.deleteMany({ where: { clientId: { startsWith: 'client-' } } });
  await prisma.user.delete({ where: { id: userId } });
  await prisma.$disconnect();
});

describe('McpService.authenticate', () => {
  it('refuses a request without a bearer token', async () => {
    await expect(service.authenticate({})).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('refuses a cookie, however valid it is', async () => {
    // Not a detail: a cookie rides along on any request a page can provoke, so
    // accepting one would make every mutating tool reachable by CSRF.
    await expect(
      service.authenticate({ cookie: 'exocortex.session_token=whatever' }),
    ).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('accepts a read-scoped API token and passes that same token to the tools', async () => {
    const secret = await apiToken(['read']);
    const caller = await service.authenticate(bearer(secret));

    expect(caller.kind).toBe('api_token');
    expect(caller.session.userId).toBe(userId);
    // Passing the token through unchanged is what keeps `TokenScopeGuard`
    // deciding: a read token's write attempts fail on the loopback call.
    expect(caller.loopbackToken).toBe(secret);
  });

  it('refuses a token that carries no scope at all', async () => {
    const secret = await apiToken([]);
    await expect(service.authenticate(bearer(secret))).rejects.toMatchObject({
      code: 'api_token_insufficient_scope',
    });
  });

  it('refuses a revoked and an expired API token', async () => {
    const revoked = await apiToken(['read'], { revoked: true });
    const expired = await apiToken(['read'], { expired: true });

    await expect(service.authenticate(bearer(revoked))).rejects.toMatchObject({
      code: 'api_token_invalid',
    });
    await expect(service.authenticate(bearer(expired))).rejects.toMatchObject({
      code: 'api_token_expired',
    });
  });

  it('accepts an OAuth access token and mints a loopback credential for it', async () => {
    const token = await oauthToken();
    const caller = await service.authenticate(bearer(token));

    expect(caller.kind).toBe('oauth');
    expect(caller.credentialId).toBe(clientId);
    expect(caller.session.userId).toBe(userId);

    // The minted token authenticates the tools' calls back into the API, and
    // its purpose is what stops it being replayed at the collaboration server.
    const verified = verifyServiceToken({
      secret: 'c'.repeat(32),
      token: caller.loopbackToken,
      expectedPurpose: 'mcp-tools',
    });
    expect(verified).toMatchObject({ valid: true, claims: { userId, purpose: 'mcp-tools' } });
  });

  it('refuses an expired OAuth token', async () => {
    const token = await oauthToken({ expiresAt: new Date(Date.now() - HOUR) });
    await expect(service.authenticate(bearer(token))).rejects.toMatchObject({
      code: 'api_token_expired',
    });
  });

  it('refuses a token belonging to a client that was switched off', async () => {
    // Disabling the client is how a connector is revoked without hunting down
    // every token it already holds, so the check has to bite on use.
    const token = await oauthToken({ disabledClient: true });
    await expect(service.authenticate(bearer(token))).rejects.toMatchObject({
      code: 'api_token_invalid',
    });
  });

  it('refuses a token that authorizes nobody', async () => {
    const token = await oauthToken({ withoutUser: true });
    await expect(service.authenticate(bearer(token))).rejects.toMatchObject({
      code: 'api_token_invalid',
    });
  });

  it('refuses an unrecognised bearer value', async () => {
    await expect(service.authenticate(bearer('not-a-token'))).rejects.toMatchObject({
      code: 'api_token_invalid',
    });
  });
});

describe('McpService.createHandler', () => {
  it('serves the full catalogue on the default surface and two tools on research', async () => {
    const secret = await apiToken(['write']);
    const caller = await service.authenticate(bearer(secret));

    const full = await (
      await service.createHandler(caller, 'mcp')
    )({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    });
    const research = await (
      await service.createHandler(caller, 'research')
    )({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    });

    const fullNames = (full as { result: { tools: { name: string }[] } }).result.tools.map(
      (tool) => tool.name,
    );
    const researchNames = (research as { result: { tools: { name: string }[] } }).result.tools.map(
      (tool) => tool.name,
    );

    expect(fullNames.length).toBeGreaterThan(20);
    expect(fullNames).toContain('exo_page_write');
    expect(researchNames.sort()).toEqual(['fetch', 'search']);
    // The research connector must not be able to reach a writing tool by name.
    expect(researchNames).not.toContain('exo_page_write');
  });
});

describe('McpService.describeClient', () => {
  it('returns what the client claimed about itself when it registered', async () => {
    const described = await service.describeClient(clientId);
    expect(described).toMatchObject({
      clientId,
      name: 'ChatGPT',
      disabled: false,
      redirectUrls: ['https://chatgpt.com/connector_platform_oauth_redirect'],
    });
  });

  it('reports an unknown client rather than inventing one', async () => {
    await expect(service.describeClient('client-does-not-exist')).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});
