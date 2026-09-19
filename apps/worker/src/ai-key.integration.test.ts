import { randomBytes } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { encryptCredential } from '@exocortex/auth';
import { loadDotEnv, type WorkerEnv } from '@exocortex/config';
import { createPrismaClient, type PrismaClient } from '@exocortex/database';
import { createLogger, type Logger } from '@exocortex/logger';

import { createAiKeyResolver } from './ai-key';

/**
 * Whose key pays for a run (issue #52, AP7), against the real database.
 *
 * The deployment's encryption key is a fixture: proving that the worker reads
 * back what the API stored means holding the key both halves used, and the
 * live deployment's must never be needed to run a test.
 */
loadDotEnv();

const logger: Logger = createLogger({ name: 'worker-test', level: 'silent' });
const encryptionKey = randomBytes(32);
const workspaceSecret = 'sk-or-v1-workspace-key-0001';

function envWith(overrides: Partial<WorkerEnv>): WorkerEnv {
  return {
    OPENROUTER_API_KEY: 'sk-or-v1-deployment-key',
    CREDENTIAL_ENCRYPTION_KEY: encryptionKey.toString('base64'),
    ...overrides,
  } as unknown as WorkerEnv;
}

let prisma: PrismaClient;
let workspaceId: string;

beforeAll(async () => {
  prisma = createPrismaClient({ databaseUrl: process.env.DATABASE_URL });
  const suffix = Date.now().toString(36);
  const workspace = await prisma.workspace.create({
    data: { name: `AiKey ${suffix}`, slug: `ai-key-${suffix}` },
  });
  workspaceId = workspace.id;
});

beforeEach(async () => {
  await prisma.workspaceCredential.deleteMany({ where: { workspaceId } });
});

afterAll(async () => {
  await prisma.workspace.deleteMany({ where: { id: workspaceId } });
  await prisma.$disconnect();
});

async function storeWorkspaceKey(secret = workspaceSecret, key = encryptionKey): Promise<void> {
  await prisma.workspaceCredential.create({
    data: {
      workspaceId,
      purpose: 'AI_OPENROUTER',
      ...encryptCredential({ key, purpose: 'AI_OPENROUTER', plaintext: secret }),
      hint: secret.slice(-4),
    },
  });
}

describe('resolving the key for a run', () => {
  it('uses the deployment key when the workspace has none', async () => {
    const resolve = createAiKeyResolver({ prisma, env: envWith({}), logger });
    expect(await resolve(workspaceId)).toEqual({
      apiKey: 'sk-or-v1-deployment-key',
      usedOwnKey: false,
    });
  });

  it('uses the workspace key when it has one', async () => {
    await storeWorkspaceKey();
    const resolve = createAiKeyResolver({ prisma, env: envWith({}), logger });
    expect(await resolve(workspaceId)).toEqual({ apiKey: workspaceSecret, usedOwnKey: true });
  });

  it('records when the workspace key was last used', async () => {
    await storeWorkspaceKey();
    const resolve = createAiKeyResolver({ prisma, env: envWith({}), logger });
    await resolve(workspaceId);

    // The update is fired without being awaited, so the assertion waits for the
    // row rather than for a promise the caller never held.
    await expect
      .poll(async () =>
        (
          await prisma.workspaceCredential.findFirstOrThrow({ where: { workspaceId } })
        ).lastUsedAt?.getTime(),
      )
      .toBeGreaterThan(0);
  });

  it('falls back to the deployment key when this deployment cannot decrypt at all', async () => {
    await storeWorkspaceKey();
    const resolve = createAiKeyResolver({
      prisma,
      env: envWith({ CREDENTIAL_ENCRYPTION_KEY: undefined }),
      logger,
    });
    expect(await resolve(workspaceId)).toEqual({
      apiKey: 'sk-or-v1-deployment-key',
      usedOwnKey: false,
    });
  });

  it('falls back rather than failing the run when a stored key cannot be decrypted', async () => {
    await storeWorkspaceKey(workspaceSecret, randomBytes(32));
    const resolve = createAiKeyResolver({ prisma, env: envWith({}), logger });
    expect(await resolve(workspaceId)).toEqual({
      apiKey: 'sk-or-v1-deployment-key',
      usedOwnKey: false,
    });
  });

  it('boots with an unusable encryption key instead of throwing', async () => {
    await storeWorkspaceKey();
    const resolve = createAiKeyResolver({
      prisma,
      env: envWith({ CREDENTIAL_ENCRYPTION_KEY: 'far-too-short' }),
      logger,
    });
    expect((await resolve(workspaceId)).usedOwnKey).toBe(false);
  });
});
