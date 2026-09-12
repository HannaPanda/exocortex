import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AuthorizationError, WorkspaceAccessService } from '@exocortex/auth';
import { loadDotEnv } from '@exocortex/config';
import { createPrismaClient, type PrismaClient } from '@exocortex/database';
import { createLogger, type Logger } from '@exocortex/logger';

import { OutboxService } from '../common/outbox.service';
import { SettingsService } from '../platform/settings.service';
import { type RealtimeService } from '../realtime/realtime.service';

import { WorkspacesService } from './workspaces.service';

/**
 * Workspace domain tests against the real database.
 *
 * Constructed directly, the same way `documents.integration.test.ts` does:
 * these are hierarchy/authorization rules, not HTTP concerns.
 */
loadDotEnv();

const logger: Logger = createLogger({ name: 'api-test', level: 'silent' });

let prisma: PrismaClient;
let service: WorkspacesService;
let ownerId: string;
let adminId: string;
let memberId: string;
let workspaceId: string;
let settings: SettingsService;
let otherWorkspaceId: string;

const emitted: { type: string; workspaceId: string }[] = [];
const realtime = {
  emit: async (type: string, workspace: string) => {
    emitted.push({ type, workspaceId: workspace });
  },
} as unknown as RealtimeService;

const correlationId = 'test-correlation';

beforeAll(async () => {
  prisma = createPrismaClient({ databaseUrl: process.env.DATABASE_URL });
  const access = new WorkspaceAccessService(prisma);
  const outbox = new OutboxService(prisma, logger);
  settings = new SettingsService(prisma, logger, outbox);
  service = new WorkspacesService(prisma, access, outbox, realtime, settings);

  const suffix = Date.now().toString(36);
  const [owner, admin, member] = await Promise.all([
    prisma.user.create({
      data: { email: `ws-owner-${suffix}@exocortex.test`, name: 'Owner', emailVerified: true },
    }),
    prisma.user.create({
      data: { email: `ws-admin-${suffix}@exocortex.test`, name: 'Admin', emailVerified: true },
    }),
    prisma.user.create({
      data: { email: `ws-member-${suffix}@exocortex.test`, name: 'Member', emailVerified: true },
    }),
  ]);
  ownerId = owner.id;
  adminId = admin.id;
  memberId = member.id;

  const workspace = await prisma.workspace.create({
    data: {
      name: `Settings ${suffix}`,
      slug: `settings-${suffix}`,
      members: {
        create: [
          { userId: ownerId, role: 'OWNER' },
          { userId: adminId, role: 'ADMIN' },
          { userId: memberId, role: 'MEMBER' },
        ],
      },
    },
  });
  workspaceId = workspace.id;

  const other = await prisma.workspace.create({
    data: {
      name: `Settings-Other ${suffix}`,
      slug: `settings-other-${suffix}`,
      members: { create: { userId: ownerId, role: 'OWNER' } },
    },
  });
  otherWorkspaceId = other.id;
});

afterAll(async () => {
  await prisma.workspace.deleteMany({ where: { id: { in: [workspaceId, otherWorkspaceId] } } });
  await prisma.user.deleteMany({ where: { id: { in: [ownerId, adminId, memberId] } } });
  await prisma.$disconnect();
});

describe('renaming a workspace', () => {
  it('lets an OWNER change the name without touching the slug', async () => {
    const before = await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } });

    const updated = await service.update({
      workspaceId,
      actorUserId: ownerId,
      request: { name: 'Neuer Name' },
      correlationId,
    });

    expect(updated.name).toBe('Neuer Name');
    expect(updated.slug).toBe(before.slug);
  });

  it('lets an ADMIN change the slug independently of the name', async () => {
    const before = await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } });

    const updated = await service.update({
      workspaceId,
      actorUserId: adminId,
      request: { slug: 'ein-neuer-slug' },
      correlationId,
    });

    expect(updated.slug).toBe('ein-neuer-slug');
    expect(updated.name).toBe(before.name);
  });

  it('refuses a MEMBER', async () => {
    await expect(
      service.update({
        workspaceId,
        actorUserId: memberId,
        request: { name: 'Sollte nicht klappen' },
        correlationId,
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

  it('reports a taken slug as a speaking conflict, not a 500', async () => {
    const otherWorkspace = await prisma.workspace.findUniqueOrThrow({
      where: { id: otherWorkspaceId },
    });

    await expect(
      service.update({
        workspaceId,
        actorUserId: ownerId,
        request: { slug: otherWorkspace.slug },
        correlationId,
      }),
    ).rejects.toMatchObject({ code: 'workspace_slug_taken' });
  });

  it('allows keeping the same slug (a no-op on that field)', async () => {
    const before = await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } });

    await expect(
      service.update({
        workspaceId,
        actorUserId: ownerId,
        request: { slug: before.slug, name: before.name },
        correlationId,
      }),
    ).resolves.toMatchObject({ slug: before.slug });
  });

  it('writes an audit entry and emits workspace.updated', async () => {
    emitted.length = 0;
    await service.update({
      workspaceId,
      actorUserId: ownerId,
      request: { name: 'Auditiert' },
      correlationId,
    });

    const audit = await prisma.auditLog.findFirst({
      where: { workspaceId, action: 'workspace.renamed' },
      orderBy: { createdAt: 'desc' },
    });
    expect(audit).not.toBeNull();
    expect(audit?.actorId).toBe(ownerId);
    expect(emitted.some((event) => event.type === 'workspace.updated')).toBe(true);
  });
});

describe('workspace settings (issue #52, ADR-023)', () => {
  it('inherits everything while the workspace has set nothing', async () => {
    const response = await service.getSettings(workspaceId, memberId);

    expect(response.overriddenKeys).toEqual([]);
    expect(response.settings).toEqual(response.deploymentSettings);
    expect(response.editableKeys).toContain('ai.systemPrompt');
    expect(response.editableKeys).not.toContain('mcp.enabled');
  });

  it('lets an ADMIN override a key and reports it as set', async () => {
    const saved = await service.updateSettings({
      workspaceId,
      actorUserId: adminId,
      request: { 'ai.systemPrompt': 'Antworte knapp.' },
    });

    expect(saved.settings['ai.systemPrompt']).toBe('Antworte knapp.');
    expect(saved.overriddenKeys).toEqual(['ai.systemPrompt']);
    // The neighbouring workspace is untouched: an override belongs to one area.
    const other = await service.getSettings(otherWorkspaceId, ownerId);
    expect(other.settings['ai.systemPrompt']).toBe(other.deploymentSettings['ai.systemPrompt']);
  });

  it('refuses an override for a MEMBER', async () => {
    await expect(
      service.updateSettings({
        workspaceId,
        actorUserId: memberId,
        request: { 'ai.systemPrompt': 'darf nicht' },
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

  it('refuses a value above the deployment ceiling', async () => {
    const deployment = (await service.getSettings(workspaceId, ownerId)).deploymentSettings;
    await expect(
      service.updateSettings({
        workspaceId,
        actorUserId: ownerId,
        request: { 'ai.budgetMicroUsdPerRun': deployment['ai.budgetMicroUsdPerRun'] + 1 },
      }),
    ).rejects.toMatchObject({ code: 'setting_above_deployment_ceiling' });
  });

  it('accepts a value below the ceiling and takes it back on reset', async () => {
    const deployment = (await service.getSettings(workspaceId, ownerId)).deploymentSettings;
    const lower = Math.floor(deployment['ai.budgetMicroUsdPerRun'] / 2);

    const saved = await service.updateSettings({
      workspaceId,
      actorUserId: ownerId,
      request: { 'ai.budgetMicroUsdPerRun': lower },
    });
    expect(saved.settings['ai.budgetMicroUsdPerRun']).toBe(lower);

    const reset = await service.updateSettings({
      workspaceId,
      actorUserId: ownerId,
      request: { reset: ['ai.budgetMicroUsdPerRun'] },
    });
    expect(reset.settings['ai.budgetMicroUsdPerRun']).toBe(deployment['ai.budgetMicroUsdPerRun']);
    expect(reset.overriddenKeys).not.toContain('ai.budgetMicroUsdPerRun');
  });

  it('refuses a deployment-scoped key that was built by hand', async () => {
    await expect(
      service.updateSettings({
        workspaceId,
        actorUserId: ownerId,
        // Cast, because the request schema would already have stripped this.
        request: { 'mcp.enabled': false } as never,
      }),
    ).rejects.toMatchObject({ code: 'setting_not_overridable' });
  });

  it('marks a workspace as the memory area through the ordinary update path', async () => {
    const updated = await service.update({
      workspaceId: otherWorkspaceId,
      actorUserId: ownerId,
      request: { isMemory: true },
      correlationId,
    });
    expect(updated.isMemory).toBe(true);

    await service.update({
      workspaceId: otherWorkspaceId,
      actorUserId: ownerId,
      request: { isMemory: false },
      correlationId,
    });
  });
});
