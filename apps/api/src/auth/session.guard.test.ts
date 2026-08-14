import { type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { generateApiToken } from '@exocortex/auth';
import { type ApiEnv, loadApiEnv, loadDotEnv } from '@exocortex/config';
import { createPrismaClient, type PrismaClient } from '@exocortex/database';
import { createLogger, type Logger } from '@exocortex/logger';

import { type AuthService } from './auth.service';
import { SessionGuard } from './session.guard';

/**
 * Unit-level test against the real database: the guard's session-cookie path
 * is exercised by the e2e suite, this covers the new bearer-token branches
 * (`ApiToken` lookup, revocation, expiry, unknown prefix).
 */
loadDotEnv();

const logger: Logger = createLogger({ name: 'api-test', level: 'silent' });
const env: ApiEnv = loadApiEnv({
  NODE_ENV: 'test',
  APP_URL: 'http://localhost:3210',
  DATABASE_URL: process.env.DATABASE_URL ?? 'postgresql://exocortex:exocortex@127.0.0.1:5433/exocortex',
  REDIS_URL: process.env.REDIS_URL ?? 'redis://127.0.0.1:6380',
  BETTER_AUTH_SECRET: 'a'.repeat(32),
  BETTER_AUTH_URL: 'http://localhost:3210',
  COLLABORATION_TICKET_SECRET: 'b'.repeat(32),
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

/** A stub: the session-cookie path always misses, forcing the bearer-token path. */
const noSessionAuthService = { verifySession: async () => null } as unknown as AuthService;

let prisma: PrismaClient;
let guard: SessionGuard;
let userId: string;

/** Stand-ins for `Reflector.getAllAndOverride`'s metadata lookup targets. */
function noopHandler(): void {
  // Intentionally empty: only its identity is used as a metadata-reflection key.
}
class NoopController {}

function contextFor(authorization: string): ExecutionContext {
  const request = { headers: { authorization } };
  return {
    getHandler: () => noopHandler,
    getClass: () => NoopController,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

beforeAll(async () => {
  prisma = createPrismaClient({ databaseUrl: process.env.DATABASE_URL });
  guard = new SessionGuard(noSessionAuthService, new Reflector(), prisma, env, logger);

  const suffix = Date.now().toString(36);
  const user = await prisma.user.create({
    data: { email: `token-guard-${suffix}@exocortex.test`, name: 'Token User', emailVerified: true },
  });
  userId = user.id;
});

afterAll(async () => {
  await prisma.user.delete({ where: { id: userId } });
  await prisma.$disconnect();
});

describe('SessionGuard bearer token authentication', () => {
  it('authenticates a valid API token', async () => {
    const generated = generateApiToken();
    await prisma.apiToken.create({
      data: {
        userId,
        name: 'Valid token',
        tokenHash: generated.tokenHash,
        prefix: generated.prefix,
      },
    });

    const context = contextFor(`Bearer ${generated.secret}`);
    const result = await guard.canActivate(context);
    expect(result).toBe(true);

    const request = context.switchToHttp().getRequest() as { exocortexSession?: { userId: string } };
    expect(request.exocortexSession?.userId).toBe(userId);
  });

  it('rejects a revoked token', async () => {
    const generated = generateApiToken();
    await prisma.apiToken.create({
      data: {
        userId,
        name: 'Revoked token',
        tokenHash: generated.tokenHash,
        prefix: generated.prefix,
        revokedAt: new Date(),
      },
    });

    await expect(guard.canActivate(contextFor(`Bearer ${generated.secret}`))).rejects.toMatchObject({
      code: 'api_token_invalid',
    });
  });

  it('rejects an expired token', async () => {
    const generated = generateApiToken();
    await prisma.apiToken.create({
      data: {
        userId,
        name: 'Expired token',
        tokenHash: generated.tokenHash,
        prefix: generated.prefix,
        expiresAt: new Date(Date.now() - 60_000),
      },
    });

    await expect(guard.canActivate(contextFor(`Bearer ${generated.secret}`))).rejects.toMatchObject({
      code: 'api_token_expired',
    });
  });

  it('rejects an unrecognized bearer token format', async () => {
    await expect(guard.canActivate(contextFor('Bearer not-a-known-prefix'))).rejects.toMatchObject({
      code: 'api_token_invalid',
    });
  });
});
