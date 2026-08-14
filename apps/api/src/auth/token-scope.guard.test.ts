import { type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { generateApiToken } from '@exocortex/auth';
import { type ApiEnv, loadApiEnv, loadDotEnv } from '@exocortex/config';
import { createPrismaClient, type PrismaClient } from '@exocortex/database';
import { createLogger, type Logger } from '@exocortex/logger';

import { type AuthService } from './auth.service';
import { SessionGuard } from './session.guard';
import { TokenScopeGuard } from './token-scope.guard';

/**
 * The two guards are tested together against the real database, because the
 * thing worth proving spans both: `SessionGuard` reads the scopes off the row
 * and `TokenScopeGuard` decides on them. Testing either alone would let the
 * wiring between them break silently, which is exactly the failure that would
 * hand a read-only token the admin API.
 */
loadDotEnv();

const logger: Logger = createLogger({ name: 'api-test', level: 'silent' });
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

const noSessionAuthService = { verifySession: async () => null } as unknown as AuthService;

let prisma: PrismaClient;
let sessionGuard: SessionGuard;
let userId: string;

const scopeGuard = new TokenScopeGuard();

function noopHandler(): void {
  // Intentionally empty: only its identity is used as a metadata-reflection key.
}
class NoopController {}

interface TestRequest {
  headers: { authorization: string };
  method: string;
  url: string;
}

function contextFor(authorization: string, method: string, url: string): ExecutionContext {
  const request: TestRequest = { headers: { authorization }, method, url };
  return {
    getHandler: () => noopHandler,
    getClass: () => NoopController,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

/** Runs the real chain: authenticate, then decide on the scope. */
async function callWith(secret: string, method: string, url: string): Promise<boolean> {
  const context = contextFor(`Bearer ${secret}`, method, url);
  await sessionGuard.canActivate(context);
  return scopeGuard.canActivate(context);
}

async function tokenWithScopes(scopes: string[]): Promise<string> {
  const generated = generateApiToken();
  await prisma.apiToken.create({
    data: {
      userId,
      name: `Scoped ${scopes.join('+') || 'none'}`,
      tokenHash: generated.tokenHash,
      prefix: generated.prefix,
      scopes,
    },
  });
  return generated.secret;
}

beforeAll(async () => {
  prisma = createPrismaClient({ databaseUrl: process.env.DATABASE_URL });
  sessionGuard = new SessionGuard(noSessionAuthService, new Reflector(), prisma, env, logger);

  const suffix = Date.now().toString(36);
  const user = await prisma.user.create({
    data: {
      email: `scope-guard-${suffix}@exocortex.test`,
      name: 'Scope User',
      emailVerified: true,
    },
  });
  userId = user.id;
});

afterAll(async () => {
  await prisma.user.delete({ where: { id: userId } });
  await prisma.$disconnect();
});

describe('TokenScopeGuard', () => {
  it('lets a read token read', async () => {
    const secret = await tokenWithScopes(['read']);
    await expect(callWith(secret, 'GET', '/api/workspaces')).resolves.toBe(true);
  });

  it('refuses to let a read token write', async () => {
    const secret = await tokenWithScopes(['read']);
    await expect(callWith(secret, 'POST', '/api/workspaces')).rejects.toMatchObject({
      code: 'api_token_insufficient_scope',
    });
  });

  it('refuses to let a read token near the admin API, reading it included', async () => {
    const secret = await tokenWithScopes(['read']);
    await expect(callWith(secret, 'GET', '/api/admin/overview')).rejects.toMatchObject({
      code: 'api_token_insufficient_scope',
    });
  });

  it('lets a write token write but keeps it out of the admin API', async () => {
    const secret = await tokenWithScopes(['write']);
    await expect(callWith(secret, 'POST', '/api/documents')).resolves.toBe(true);
    await expect(callWith(secret, 'PATCH', '/api/admin/settings')).rejects.toMatchObject({
      code: 'api_token_insufficient_scope',
    });
  });

  it('stops a write token from minting itself a wider one', async () => {
    const secret = await tokenWithScopes(['write']);
    await expect(callWith(secret, 'POST', '/api/me/api-tokens')).rejects.toMatchObject({
      code: 'api_token_insufficient_scope',
    });
  });

  it('lets an admin token through everywhere', async () => {
    const secret = await tokenWithScopes(['admin']);
    await expect(callWith(secret, 'GET', '/api/workspaces')).resolves.toBe(true);
    await expect(callWith(secret, 'POST', '/api/documents')).resolves.toBe(true);
    await expect(callWith(secret, 'GET', '/api/admin/overview')).resolves.toBe(true);
  });

  it('grants nothing to a token from before scopes existed', async () => {
    const secret = await tokenWithScopes([]);
    await expect(callWith(secret, 'GET', '/api/workspaces')).rejects.toMatchObject({
      code: 'api_token_insufficient_scope',
    });
  });

  it('ignores the query string when deciding', async () => {
    const secret = await tokenWithScopes(['read']);
    await expect(callWith(secret, 'GET', '/api/search?q=admin')).resolves.toBe(true);
  });

  it('leaves a cookie session alone', () => {
    const context = contextFor('', 'POST', '/api/admin/settings');
    const request = context.switchToHttp().getRequest<{ exocortexCredential?: string }>();
    request.exocortexCredential = 'session';
    expect(scopeGuard.canActivate(context)).toBe(true);
  });

  it("leaves the worker's service token alone", () => {
    const context = contextFor('', 'POST', '/api/documents');
    const request = context.switchToHttp().getRequest<{ exocortexCredential?: string }>();
    request.exocortexCredential = 'service_token';
    expect(scopeGuard.canActivate(context)).toBe(true);
  });
});
