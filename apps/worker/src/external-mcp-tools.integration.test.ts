import { randomBytes } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { encryptCredential } from '@exocortex/auth';
import { loadDotEnv, type WorkerEnv } from '@exocortex/config';
import { externalMcpSecretPurpose, type Settings, settingsSchema } from '@exocortex/contracts';
import { createPrismaClient, type PrismaClient } from '@exocortex/database';
import { createLogger, type Logger } from '@exocortex/logger';

import { createExternalToolLoader } from './external-mcp-tools';

/**
 * Which external tools a run is offered, and whether a call still goes out,
 * against the real database (issue #196, stage 3, ADR-086).
 *
 * The server address is this host on purpose: an approved call has to reach
 * the address guard and come back as its code, and no request may leave the
 * test for anywhere else.
 */
loadDotEnv();

const logger: Logger = createLogger({ name: 'external-mcp-tools-test', level: 'silent' });
const encryptionKey = randomBytes(32);
const env = { CREDENTIAL_ENCRYPTION_KEY: encryptionKey.toString('base64') } as unknown as WorkerEnv;

let prisma: PrismaClient;
let settings: Settings;
let ownerId: string;
let guestId: string;
let strangerId: string;
let workspaceId: string;
let otherWorkspaceId: string;

const OPTIONS = { timeoutMs: 2_000, maxTextChars: 1_000, correlationId: 'corr-test' };

function loader() {
  return createExternalToolLoader({
    prisma,
    env,
    logger,
    settings: () => Promise.resolve(settings),
  });
}

async function connect(input: {
  workspaceId: string;
  key: string;
  access: 'BLOCKED' | 'READ' | 'WRITE';
  enabled?: boolean;
}): Promise<{ serverId: string; toolId: string }> {
  const secret = 'hmcp_test_secret_0001';
  const server = await prisma.externalMcpServer.create({
    data: {
      workspaceId: input.workspaceId,
      key: input.key,
      name: `Server ${input.key}`,
      url: 'https://127.0.0.1/mcp',
      enabled: input.enabled ?? true,
      authKind: 'BEARER',
      ...(() => {
        const record = encryptCredential({
          key: encryptionKey,
          purpose: externalMcpSecretPurpose(input.workspaceId, input.key),
          plaintext: secret,
        });
        return {
          secretCiphertext: record.ciphertext,
          secretIv: record.iv,
          secretAuthTag: record.authTag,
          secretKeyVersion: record.keyVersion,
          secretHint: '0001',
        };
      })(),
    },
  });
  const approved = input.access !== 'BLOCKED';
  const tool = await prisma.externalMcpTool.create({
    data: {
      serverId: server.id,
      name: 'get_weight',
      description: 'Liefert Gewichtsmessungen.',
      inputSchema: { type: 'object' },
      hints: {},
      fingerprint: 'fp-1',
      access: input.access,
      ...(approved
        ? { approvedFingerprint: 'fp-1', approvedById: ownerId, approvedAt: new Date() }
        : {}),
    },
  });
  return { serverId: server.id, toolId: tool.id };
}

beforeAll(async () => {
  prisma = createPrismaClient({ databaseUrl: process.env.DATABASE_URL });
  const suffix = Date.now().toString(36);
  const users = await Promise.all(
    ['owner', 'guest', 'stranger'].map((role) =>
      prisma.user.create({
        data: { email: `xmcpw-${role}-${suffix}@exocortex.test`, name: role, emailVerified: true },
      }),
    ),
  );
  [ownerId, guestId, strangerId] = users.map((user) => user.id) as [string, string, string];
  const workspace = await prisma.workspace.create({
    data: {
      name: `External tools ${suffix}`,
      slug: `external-tools-${suffix}`,
      members: {
        create: [
          { userId: ownerId, role: 'OWNER' },
          { userId: guestId, role: 'GUEST' },
        ],
      },
    },
  });
  workspaceId = workspace.id;
  const other = await prisma.workspace.create({
    data: {
      name: `External tools other ${suffix}`,
      slug: `external-tools-other-${suffix}`,
      members: { create: [{ userId: strangerId, role: 'OWNER' }] },
    },
  });
  otherWorkspaceId = other.id;
});

beforeEach(async () => {
  settings = settingsSchema.parse({ 'ai.externalMcpEnabled': true });
  await prisma.externalMcpServer.deleteMany({
    where: { workspaceId: { in: [workspaceId, otherWorkspaceId] } },
  });
});

afterAll(async () => {
  await prisma.workspace.deleteMany({ where: { id: { in: [workspaceId, otherWorkspaceId] } } });
  await prisma.user.deleteMany({ where: { id: { in: [ownerId, guestId, strangerId] } } });
  await prisma.$disconnect();
});

describe('what a run is offered', () => {
  it('offers an approved tool of its own workspace, namespaced', async () => {
    await connect({ workspaceId, key: 'health', access: 'READ' });
    const source = await loader()({ workspaceId, userId: ownerId });
    expect(source?.tools.map((tool) => tool.functionName)).toEqual(['mcp_health__get_weight']);
  });

  it('keeps two servers with the same tool apart', async () => {
    await connect({ workspaceId, key: 'health', access: 'READ' });
    await connect({ workspaceId, key: 'flauschi', access: 'WRITE' });
    const source = await loader()({ workspaceId, userId: ownerId });
    expect(source?.tools.map((tool) => [tool.functionName, tool.access])).toEqual(
      expect.arrayContaining([
        ['mcp_health__get_weight', 'read'],
        ['mcp_flauschi__get_weight', 'write'],
      ]),
    );
  });

  it('offers nothing blocked, nothing on a server that is off, nothing while switched off', async () => {
    await connect({ workspaceId, key: 'blocked', access: 'BLOCKED' });
    await connect({ workspaceId, key: 'off', access: 'READ', enabled: false });
    expect(await loader()({ workspaceId, userId: ownerId })).toBeNull();

    await connect({ workspaceId, key: 'health', access: 'READ' });
    settings = settingsSchema.parse({ 'ai.externalMcpEnabled': false });
    expect(await loader()({ workspaceId, userId: ownerId })).toBeNull();
  });

  it("never offers another workspace's tools, nor to a guest or a stranger", async () => {
    await connect({ workspaceId: otherWorkspaceId, key: 'foreign', access: 'WRITE' });
    await connect({ workspaceId, key: 'health', access: 'READ' });
    const own = await loader()({ workspaceId, userId: ownerId });
    expect(own?.tools.map((tool) => tool.serverKey)).toEqual(['health']);
    expect(await loader()({ workspaceId, userId: guestId })).toBeNull();
    expect(await loader()({ workspaceId, userId: strangerId })).toBeNull();
  });
});

describe('a call during the run', () => {
  it('goes out through the address guard and comes back as its code', async () => {
    await connect({ workspaceId, key: 'health', access: 'READ' });
    const source = (await loader()({ workspaceId, userId: ownerId }))!;
    const outcome = await source.call(source.tools[0]!, {}, OPTIONS);
    expect(outcome).toEqual({ kind: 'failed', code: 'address_refused' });
  });

  it('stops when the tool is blocked after the run started', async () => {
    const { toolId } = await connect({ workspaceId, key: 'health', access: 'READ' });
    const source = (await loader()({ workspaceId, userId: ownerId }))!;
    await prisma.externalMcpTool.update({ where: { id: toolId }, data: { access: 'BLOCKED' } });
    expect(await source.call(source.tools[0]!, {}, OPTIONS)).toEqual({
      kind: 'revoked',
      code: 'tool_revoked',
    });
  });

  it('stops when a check saw the tool change', async () => {
    const { toolId } = await connect({ workspaceId, key: 'health', access: 'READ' });
    const source = (await loader()({ workspaceId, userId: ownerId }))!;
    await prisma.externalMcpTool.update({
      where: { id: toolId },
      data: { fingerprint: 'fp-2', access: 'BLOCKED', description: 'Löscht alles.' },
    });
    expect(await source.call(source.tools[0]!, {}, OPTIONS)).toEqual({
      kind: 'revoked',
      code: 'tool_revoked',
    });
  });

  it('stops when the server is switched off or deleted', async () => {
    const { serverId } = await connect({ workspaceId, key: 'health', access: 'READ' });
    const source = (await loader()({ workspaceId, userId: ownerId }))!;
    await prisma.externalMcpServer.update({ where: { id: serverId }, data: { enabled: false } });
    expect(await source.call(source.tools[0]!, {}, OPTIONS)).toEqual({
      kind: 'revoked',
      code: 'server_disabled',
    });
    await prisma.externalMcpServer.delete({ where: { id: serverId } });
    expect(await source.call(source.tools[0]!, {}, OPTIONS)).toEqual({
      kind: 'revoked',
      code: 'server_disabled',
    });
  });

  it('stops when the deployment switch goes off', async () => {
    await connect({ workspaceId, key: 'health', access: 'READ' });
    const source = (await loader()({ workspaceId, userId: ownerId }))!;
    settings = settingsSchema.parse({ 'ai.externalMcpEnabled': false });
    expect(await source.call(source.tools[0]!, {}, OPTIONS)).toEqual({
      kind: 'revoked',
      code: 'external_mcp_disabled',
    });
  });

  it('cannot read a secret stored under another key', async () => {
    const { serverId } = await connect({ workspaceId, key: 'health', access: 'READ' });
    const source = (await loader()({ workspaceId, userId: ownerId }))!;
    const foreign = encryptCredential({
      key: randomBytes(32),
      purpose: externalMcpSecretPurpose(workspaceId, 'health'),
      plaintext: 'x'.repeat(20),
    });
    await prisma.externalMcpServer.update({
      where: { id: serverId },
      data: {
        secretCiphertext: foreign.ciphertext,
        secretIv: foreign.iv,
        secretAuthTag: foreign.authTag,
      },
    });
    expect(await source.call(source.tools[0]!, {}, OPTIONS)).toEqual({
      kind: 'failed',
      code: 'credential_unreadable',
    });
  });
});
