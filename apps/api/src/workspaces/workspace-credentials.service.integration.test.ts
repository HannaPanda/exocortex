import { randomBytes } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AuthorizationError, decryptCredential, WorkspaceAccessService } from '@exocortex/auth';
import { type ApiEnv } from '@exocortex/config';
import { loadDotEnv } from '@exocortex/config';
import { createPrismaClient, type PrismaClient } from '@exocortex/database';
import { createLogger, type Logger } from '@exocortex/logger';

import { AppError } from '../common/app-error';
import { OutboxService } from '../common/outbox.service';

import { WorkspaceCredentialsService } from './workspace-credentials.service';

/**
 * A workspace's own provider key, against the real database (issue #52, AP7).
 *
 * The deployment key is a fixture rather than the one in `.env`: these tests
 * have to prove the ciphertext decrypts, which means holding the key they
 * encrypted with, and the live deployment's must not be needed to run tests.
 */
loadDotEnv();

const logger: Logger = createLogger({ name: 'api-test', level: 'silent' });
const deploymentKey = randomBytes(32);
const secret = 'sk-or-v1-0123456789abcdef';

function envWith(key: string | undefined): ApiEnv {
  return { CREDENTIAL_ENCRYPTION_KEY: key } as unknown as ApiEnv;
}

let prisma: PrismaClient;
let service: WorkspaceCredentialsService;
let withoutKey: WorkspaceCredentialsService;
let ownerId: string;
let adminId: string;
let workspaceId: string;

beforeAll(async () => {
  prisma = createPrismaClient({ databaseUrl: process.env.DATABASE_URL });
  const access = new WorkspaceAccessService(prisma);
  const outbox = new OutboxService(prisma, logger);
  service = new WorkspaceCredentialsService(
    prisma,
    envWith(deploymentKey.toString('base64')),
    access,
    outbox,
  );
  withoutKey = new WorkspaceCredentialsService(prisma, envWith(undefined), access, outbox);

  const suffix = Date.now().toString(36);
  const [owner, admin] = await Promise.all([
    prisma.user.create({
      data: { email: `cred-owner-${suffix}@exocortex.test`, name: 'Owner', emailVerified: true },
    }),
    prisma.user.create({
      data: { email: `cred-admin-${suffix}@exocortex.test`, name: 'Admin', emailVerified: true },
    }),
  ]);
  ownerId = owner.id;
  adminId = admin.id;

  const workspace = await prisma.workspace.create({
    data: {
      name: `Credentials ${suffix}`,
      slug: `credentials-${suffix}`,
      members: {
        create: [
          { userId: ownerId, role: 'OWNER' },
          { userId: adminId, role: 'ADMIN' },
        ],
      },
    },
  });
  workspaceId = workspace.id;
});

// Each test starts from "nothing stored": several of them assert on the one
// row this workspace may have, and a leftover from the previous one would make
// them pass for the wrong reason.
beforeEach(async () => {
  await prisma.workspaceCredential.deleteMany({ where: { workspaceId } });
});

afterAll(async () => {
  await prisma.workspace.deleteMany({ where: { id: workspaceId } });
  await prisma.user.deleteMany({ where: { id: { in: [ownerId, adminId] } } });
  await prisma.$disconnect();
});

describe('storing a workspace key', () => {
  it('stores it encrypted and answers with the hint alone', async () => {
    const response = await service.set({
      workspaceId,
      actorUserId: ownerId,
      purpose: 'AI_OPENROUTER',
      request: { secret },
    });

    const entry = response.credentials.find((one) => one.purpose === 'AI_OPENROUTER');
    expect(entry?.configured).toBe(true);
    expect(entry?.hint).toBe('cdef');
    expect(entry?.lastUsedAt).toBeNull();
    expect(JSON.stringify(response)).not.toContain(secret);

    const row = await prisma.workspaceCredential.findFirstOrThrow({ where: { workspaceId } });
    expect(row.ciphertext).not.toContain(secret);
    expect(decryptCredential({ key: deploymentKey, purpose: 'AI_OPENROUTER', record: row })).toBe(
      secret,
    );
  });

  it('replaces an existing key rather than adding a second one', async () => {
    await service.set({
      workspaceId,
      actorUserId: ownerId,
      purpose: 'AI_OPENROUTER',
      request: { secret },
    });
    await service.set({
      workspaceId,
      actorUserId: ownerId,
      purpose: 'AI_OPENROUTER',
      request: { secret: 'sk-or-v1-fedcba9876543210' },
    });

    const rows = await prisma.workspaceCredential.findMany({ where: { workspaceId } });
    expect(rows).toHaveLength(1);
    expect(
      decryptCredential({ key: deploymentKey, purpose: 'AI_OPENROUTER', record: rows[0]! }),
    ).toBe('sk-or-v1-fedcba9876543210');
  });

  it('forgets when the previous key was last used', async () => {
    await service.set({
      workspaceId,
      actorUserId: ownerId,
      purpose: 'AI_OPENROUTER',
      request: { secret },
    });
    await prisma.workspaceCredential.updateMany({
      where: { workspaceId },
      data: { lastUsedAt: new Date() },
    });

    const response = await service.set({
      workspaceId,
      actorUserId: ownerId,
      purpose: 'AI_OPENROUTER',
      request: { secret: 'sk-or-v1-fedcba9876543210' },
    });

    expect(response.credentials[0]?.lastUsedAt).toBeNull();
  });

  it('refuses an ADMIN: a paying relationship is the owner’s to enter', async () => {
    await expect(
      service.set({
        workspaceId,
        actorUserId: adminId,
        purpose: 'AI_OPENROUTER',
        request: { secret },
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

  it('says so when the deployment has no encryption key at all', async () => {
    await expect(
      withoutKey.set({
        workspaceId,
        actorUserId: ownerId,
        purpose: 'AI_OPENROUTER',
        request: { secret },
      }),
    ).rejects.toMatchObject({ code: 'credential_storage_unavailable' });
    expect(await prisma.workspaceCredential.count({ where: { workspaceId } })).toBe(0);
  });
});

describe('reading and removing', () => {
  it('lists every purpose, configured or not', async () => {
    const response = await service.list(workspaceId, ownerId);
    expect(response.credentials).toHaveLength(1);
    expect(response.credentials[0]).toMatchObject({
      purpose: 'AI_OPENROUTER',
      configured: false,
      hint: '',
    });
    expect(response.available).toBe(true);
  });

  it('reports an unconfigured deployment so the form can say why', async () => {
    expect((await withoutKey.list(workspaceId, ownerId)).available).toBe(false);
  });

  it('removes a stored key, and removing a missing one is not an error', async () => {
    await service.set({
      workspaceId,
      actorUserId: ownerId,
      purpose: 'AI_OPENROUTER',
      request: { secret },
    });

    const afterRemoval = await service.remove({
      workspaceId,
      actorUserId: ownerId,
      purpose: 'AI_OPENROUTER',
    });
    expect(afterRemoval.credentials[0]?.configured).toBe(false);
    expect(await prisma.workspaceCredential.count({ where: { workspaceId } })).toBe(0);

    await expect(
      service.remove({ workspaceId, actorUserId: ownerId, purpose: 'AI_OPENROUTER' }),
    ).resolves.toBeDefined();
  });

  it('refuses a reader who is not a member at all', async () => {
    await expect(service.list(workspaceId, 'user-that-is-not-a-member')).rejects.toBeInstanceOf(
      AuthorizationError,
    );
  });

  it('writes an audit entry that carries the hint and never the value', async () => {
    await service.set({
      workspaceId,
      actorUserId: ownerId,
      purpose: 'AI_OPENROUTER',
      request: { secret },
    });

    const entry = await prisma.auditLog.findFirstOrThrow({
      where: { workspaceId, action: 'workspace.credential.set' },
      orderBy: { createdAt: 'desc' },
    });
    expect(JSON.stringify(entry.metadata)).toContain('cdef');
    expect(JSON.stringify(entry.metadata)).not.toContain(secret);
  });
});

describe('AppError', () => {
  it('maps the unavailable code to 503, not to a validation error', () => {
    expect(new AppError('credential_storage_unavailable', 'x').status).toBe(503);
  });
});
