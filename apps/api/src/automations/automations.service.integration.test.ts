import { randomBytes } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AuthorizationError, WorkspaceAccessService } from '@exocortex/auth';
import { type ApiEnv, loadDotEnv } from '@exocortex/config';
import { type Settings, settingsSchema } from '@exocortex/contracts';
import { createPrismaClient, type PrismaClient } from '@exocortex/database';

import { type SettingsService } from '../platform/settings.service';

import { AutomationsService } from './automations.service';

/**
 * Automation rules against the real database (issue #50, ADR-024).
 *
 * The settings stub is bound to this suite's own workspace id and throws for
 * any other. The integration tests here talk to the deployment's database, and
 * a stub that answered for every workspace once archived real memory notes;
 * binding it is how a test's configuration stays a test's configuration.
 */
loadDotEnv();

const deploymentKey = randomBytes(32);
const ALLOWED_HOSTS = 'hooks.example.org, 127.0.0.1';

let prisma: PrismaClient;
let service: AutomationsService;
let ownerId: string;
let adminId: string;
let workspaceId: string;
let otherWorkspaceId: string;
let pageId: string;
let otherPageId: string;
let workspaceSettings: Settings;

function settingsStubFor(id: () => string): SettingsService {
  return {
    async getForWorkspace(candidate: string): Promise<Settings> {
      if (candidate !== id()) {
        throw new Error(`Settings stub asked about a foreign workspace: ${candidate}`);
      }
      return workspaceSettings;
    },
  } as unknown as SettingsService;
}

beforeAll(async () => {
  prisma = createPrismaClient({ databaseUrl: process.env.DATABASE_URL });
  const access = new WorkspaceAccessService(prisma);
  const env = { CREDENTIAL_ENCRYPTION_KEY: deploymentKey.toString('base64') } as unknown as ApiEnv;
  service = new AutomationsService(
    prisma,
    env,
    access,
    settingsStubFor(() => workspaceId),
  );

  const suffix = Date.now().toString(36);
  const [owner, admin] = await Promise.all([
    prisma.user.create({
      data: { email: `auto-owner-${suffix}@exocortex.test`, name: 'Owner', emailVerified: true },
    }),
    prisma.user.create({
      data: { email: `auto-admin-${suffix}@exocortex.test`, name: 'Admin', emailVerified: true },
    }),
  ]);
  ownerId = owner.id;
  adminId = admin.id;

  const workspace = await prisma.workspace.create({
    data: {
      name: `Automations ${suffix}`,
      slug: `automations-${suffix}`,
      members: {
        create: [
          { userId: ownerId, role: 'OWNER' },
          { userId: adminId, role: 'ADMIN' },
        ],
      },
    },
  });
  workspaceId = workspace.id;

  const other = await prisma.workspace.create({
    data: {
      name: `Automations other ${suffix}`,
      slug: `automations-other-${suffix}`,
      members: { create: [{ userId: ownerId, role: 'OWNER' }] },
    },
  });
  otherWorkspaceId = other.id;

  const [page, otherPage] = await Promise.all([
    prisma.document.create({
      data: {
        workspaceId,
        title: 'Technik',
        type: 'PAGE',
        orderKey: 'a0',
        createdById: ownerId,
        updatedById: ownerId,
      },
    }),
    prisma.document.create({
      data: {
        workspaceId: otherWorkspaceId,
        title: 'Anderswo',
        type: 'PAGE',
        orderKey: 'a0',
        createdById: ownerId,
        updatedById: ownerId,
      },
    }),
  ]);
  pageId = page.id;
  otherPageId = otherPage.id;
});

beforeEach(async () => {
  await prisma.automationRule.deleteMany({ where: { workspaceId } });
  workspaceSettings = settingsSchema.parse({
    'automations.enabled': true,
    'automations.webhookAllowedHosts': ALLOWED_HOSTS,
  });
});

afterAll(async () => {
  await prisma.workspace.deleteMany({ where: { id: { in: [workspaceId, otherWorkspaceId] } } });
  await prisma.user.deleteMany({ where: { id: { in: [ownerId, adminId] } } });
  await prisma.$disconnect();
});

function webhookRule(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Hermes benachrichtigen',
    enabled: true,
    scope: 'WORKSPACE' as const,
    scopeDocumentId: null,
    triggers: ['DOCUMENT_CONTENT_CHANGED' as const],
    // The schedule half of the rule, spelled out because the service is handed
    // the parsed request and the parser has already filled these in. A rule
    // that reacts to changes names no clock (ADR-038).
    scheduleKind: null,
    scheduleAt: null,
    scheduleTime: null,
    scheduleWeekday: null,
    scheduleDayOfMonth: null,
    scheduleCron: null,
    scheduleTimeZone: null,
    debounceSeconds: 60,
    action: 'WEBHOOK' as const,
    webhookUrl: 'https://hooks.example.org/exocortex',
    prompt: null,
    modelSlug: null,
    output: 'COMMENT' as const,
    ...overrides,
  };
}

describe('creating a rule', () => {
  it('hands the signing secret over once and never stores it in the clear', async () => {
    const response = await service.create({
      workspaceId,
      userId: ownerId,
      request: webhookRule(),
    });

    expect(response.webhookSecret).toMatch(/^exoa_/);
    expect(response.rule.hasWebhookSecret).toBe(true);

    const row = await prisma.automationRule.findUniqueOrThrow({ where: { id: response.rule.id } });
    expect(row.secretCiphertext).not.toBeNull();
    expect(row.secretCiphertext).not.toContain(response.webhookSecret);

    // The only place the plaintext ever appears is the create response. Reading
    // the rules back must not produce it, under any field name.
    const readBack = await service.list(workspaceId, ownerId);
    expect(JSON.stringify(readBack)).not.toContain(response.webhookSecret ?? 'nothing');
    expect(readBack.rules[0]?.hasWebhookSecret).toBe(true);
  });

  it('refuses a webhook host that is not on the allowlist', async () => {
    await expect(
      service.create({
        workspaceId,
        userId: ownerId,
        request: webhookRule({ webhookUrl: 'https://evil.example.com/collect' }),
      }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    expect(await prisma.automationRule.count({ where: { workspaceId } })).toBe(0);
  });

  it('refuses an address inside this deployment, even once it is allowlisted', async () => {
    // Somebody putting `127.0.0.1` on the allowlist has said the name is fine.
    // The address still is not: a webhook aimed at this machine is a request
    // the deployment makes to itself on somebody else's behalf (issue #63).
    workspaceSettings = settingsSchema.parse({
      'automations.enabled': true,
      'automations.webhookAllowedHosts': '127.0.0.1,[::1],10.0.0.5',
    });
    for (const webhookUrl of ['http://127.0.0.1:3211/api', 'http://[::1]/x', 'http://10.0.0.5/x']) {
      await expect(
        service.create({ workspaceId, userId: ownerId, request: webhookRule({ webhookUrl }) }),
      ).rejects.toMatchObject({ code: 'validation_failed' });
    }
    expect(await prisma.automationRule.count({ where: { workspaceId } })).toBe(0);
  });

  it('accepts a subdomain of an allowed host', async () => {
    const response = await service.create({
      workspaceId,
      userId: ownerId,
      request: webhookRule({ webhookUrl: 'https://deep.hooks.example.org/in' }),
    });
    expect(response.rule.webhookUrl).toBe('https://deep.hooks.example.org/in');
  });

  it('refuses an ADMIN: a rule that keeps acting is the owner’s to start', async () => {
    await expect(
      service.create({ workspaceId, userId: adminId, request: webhookRule() }),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

  it('refuses a scope page from another workspace', async () => {
    await expect(
      service.create({
        workspaceId,
        userId: ownerId,
        request: webhookRule({ scope: 'SUBTREE', scopeDocumentId: otherPageId }),
      }),
    ).rejects.toMatchObject({ code: 'document_access_denied' });
  });

  it('refuses a rule whose action and fields disagree', async () => {
    await expect(
      service.create({
        workspaceId,
        userId: ownerId,
        request: webhookRule({ action: 'AI_RUN', webhookUrl: null, prompt: null }),
      }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('refuses a subtree rule with no page to watch', async () => {
    await expect(
      service.create({
        workspaceId,
        userId: ownerId,
        request: webhookRule({ scope: 'SUBTREE', scopeDocumentId: null }),
      }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('stores an AI rule without a secret', async () => {
    const response = await service.create({
      workspaceId,
      userId: ownerId,
      request: webhookRule({
        action: 'AI_RUN',
        webhookUrl: null,
        prompt: 'Prüfe, ob diese Seite veraltet ist.',
        scope: 'SUBTREE',
        scopeDocumentId: pageId,
      }),
    });
    expect(response.webhookSecret).toBeNull();
    expect(response.rule.hasWebhookSecret).toBe(false);
    expect(response.rule.scopeDocumentTitle).toBe('Technik');
  });
});

describe('changing a rule', () => {
  it('leaves every field the patch did not mention alone', async () => {
    const created = await service.create({
      workspaceId,
      userId: ownerId,
      request: webhookRule(),
    });

    const updated = await service.update({
      ruleId: created.rule.id,
      userId: ownerId,
      request: { enabled: false },
    });

    expect(updated.enabled).toBe(false);
    expect(updated.name).toBe('Hermes benachrichtigen');
    expect(updated.webhookUrl).toBe('https://hooks.example.org/exocortex');
    expect(updated.triggers).toEqual(['DOCUMENT_CONTENT_CHANGED']);
  });

  it('validates the merged rule, not the patch alone', async () => {
    const created = await service.create({
      workspaceId,
      userId: ownerId,
      request: webhookRule(),
    });

    // The patch on its own says nothing wrong. Merged onto a webhook rule it
    // describes a rule with a URL and no prompt calling itself an AI rule,
    // which is the error the caller needs to read.
    await expect(
      service.update({
        ruleId: created.rule.id,
        userId: ownerId,
        request: { action: 'AI_RUN' },
      }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('clears the automatic disabling when the rule is switched back on', async () => {
    const created = await service.create({
      workspaceId,
      userId: ownerId,
      request: webhookRule({ enabled: false }),
    });
    await prisma.automationRule.update({
      where: { id: created.rule.id },
      data: { consecutiveFailures: 5, disabledReason: 'webhook_failed', disabledAt: new Date() },
    });

    const updated = await service.update({
      ruleId: created.rule.id,
      userId: ownerId,
      request: { enabled: true },
    });

    expect(updated.consecutiveFailures).toBe(0);
    expect(updated.disabledReason).toBeNull();
    expect(updated.disabledAt).toBeNull();
  });

  it('stops firing a rule whose host fell off the allowlist, when it is next saved', async () => {
    const created = await service.create({
      workspaceId,
      userId: ownerId,
      request: webhookRule(),
    });

    workspaceSettings = settingsSchema.parse({
      'automations.enabled': true,
      'automations.webhookAllowedHosts': '',
    });

    await expect(
      service.update({
        ruleId: created.rule.id,
        userId: ownerId,
        request: { name: 'Anders benannt' },
      }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });
});

describe('listing', () => {
  it('says whether automations run here at all', async () => {
    await service.create({ workspaceId, userId: ownerId, request: webhookRule() });
    workspaceSettings = settingsSchema.parse({
      'automations.enabled': false,
      'automations.webhookAllowedHosts': ALLOWED_HOSTS,
    });

    const response = await service.list(workspaceId, ownerId);
    expect(response.rules).toHaveLength(1);
    expect(response.rules[0]?.enabled).toBe(true);
    // The rule is on and inert at the same time, which is exactly the state a
    // list of cheerfully enabled rules would otherwise hide.
    expect(response.enabledForWorkspace).toBe(false);
    expect(response.allowedWebhookHosts).toEqual(['hooks.example.org', '127.0.0.1']);
  });

  it('lets an ADMIN read what the automations have been doing', async () => {
    await service.create({ workspaceId, userId: ownerId, request: webhookRule() });
    const response = await service.list(workspaceId, adminId);
    expect(response.rules).toHaveLength(1);
    expect(await service.listRuns({ workspaceId, userId: adminId })).toEqual({ runs: [] });
  });
});
