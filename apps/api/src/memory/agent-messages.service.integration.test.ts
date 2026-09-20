import { loadDotEnv } from '@exocortex/config';
import { resolveSettings, type Settings } from '@exocortex/contracts';
import { createPrismaClient, type PrismaClient } from '@exocortex/database';
import { createLogger, type Logger } from '@exocortex/logger';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { type SettingsService } from '../platform/settings.service';

import { AgentMessagesService, unreadMessagesForRecall } from './agent-messages.service';

/**
 * The mailbox against the real database (issue #51, ADR-047).
 *
 * Everything worth testing here is about rows and who may see them: that a
 * name resolves to a member of the shared memory area and to nobody else, that
 * reading leaves the read state alone, that an expired message stops being
 * delivered, and that marking somebody else's message read marks nothing.
 */
loadDotEnv();

const logger: Logger = createLogger({ name: 'api-test', level: 'silent' });
const correlationId = 'test-agent-messages';

let prisma: PrismaClient;
let service: AgentMessagesService;
let settingsService: SettingsService;
let settings: Settings;

let memoryWorkspaceId: string;
let outsiderWorkspaceId: string;
let claudeId: string;
let hermesId: string;
let strangerId: string;

beforeAll(async () => {
  prisma = createPrismaClient({ databaseUrl: process.env.DATABASE_URL });

  const suffix = Date.now().toString(36);
  const claude = await prisma.user.create({
    data: {
      email: `mail-claude-${suffix}@exocortex.test`,
      name: 'Claude Code',
      emailVerified: true,
    },
  });
  const hermes = await prisma.user.create({
    data: { email: `mail-hermes-${suffix}@exocortex.test`, name: 'Hermes', emailVerified: true },
  });
  const stranger = await prisma.user.create({
    data: { email: `mail-stranger-${suffix}@exocortex.test`, name: 'Codex', emailVerified: true },
  });
  claudeId = claude.id;
  hermesId = hermes.id;
  strangerId = stranger.id;

  const memoryWorkspace = await prisma.workspace.create({
    data: {
      name: `Memory ${suffix}`,
      slug: `mail-memory-${suffix}`,
      isMemory: true,
      members: {
        create: [
          { userId: claudeId, role: 'MEMBER' },
          { userId: hermesId, role: 'MEMBER' },
        ],
      },
    },
  });
  memoryWorkspaceId = memoryWorkspace.id;

  // A second memory area the stranger lives in. It exists so "a name that is
  // an account somewhere else" is a real case rather than a hypothetical one.
  const outsiderWorkspace = await prisma.workspace.create({
    data: {
      name: `Other memory ${suffix}`,
      slug: `mail-other-${suffix}`,
      isMemory: true,
      members: { create: { userId: strangerId, role: 'MEMBER' } },
    },
  });
  outsiderWorkspaceId = outsiderWorkspace.id;

  // Bound to this test's own workspaces: a stub that answers for every id has
  // reached into real memory areas before (issue #94's sibling).
  settingsService = {
    get: async () => settings,
    getForWorkspace: async (workspaceId: string) => {
      if (workspaceId !== memoryWorkspaceId && workspaceId !== outsiderWorkspaceId) {
        throw new Error(`the mailbox test must not read settings of ${workspaceId}`);
      }
      return settings;
    },
  } as unknown as SettingsService;

  service = new AgentMessagesService(prisma, logger, settingsService);
});

beforeEach(async () => {
  settings = resolveSettings({ rows: [], env: {} }).settings;
  await prisma.agentMessage.deleteMany({ where: { workspaceId: memoryWorkspaceId } });
});

afterAll(async () => {
  await prisma.workspace.deleteMany({
    where: { id: { in: [memoryWorkspaceId, outsiderWorkspaceId] } },
  });
  await prisma.user.deleteMany({ where: { id: { in: [claudeId, hermesId, strangerId] } } });
  await prisma.$disconnect();
});

async function send(overrides: { to?: string; subject?: string; body?: string } = {}) {
  return service.send({
    userId: hermesId,
    correlationId,
    request: {
      to: overrides.to ?? 'Claude Code',
      subject: overrides.subject ?? 'Der Worker hängt',
      body: overrides.body ?? 'Die Queue läuft seit gestern Abend voll.',
      client: 'hermes',
    },
  });
}

describe('send', () => {
  it('resolves a display name to the member of the shared memory area', async () => {
    const response = await send();

    expect(response.message.to.userId).toBe(claudeId);
    expect(response.message.from.userId).toBe(hermesId);
    expect(response.message.read).toBe(false);
    expect(response.waiting).toBe(1);
  });

  it('resolves an email address too', async () => {
    const claude = await prisma.user.findUniqueOrThrow({ where: { id: claudeId } });
    const response = await send({ to: claude.email.toUpperCase() });

    expect(response.message.to.userId).toBe(claudeId);
  });

  it('refuses a name that belongs to an account outside this memory area', async () => {
    await expect(send({ to: 'Codex' })).rejects.toMatchObject({
      code: 'agent_message_recipient_unknown',
    });
  });

  it('lets an account write to itself, because one agent runs on several machines', async () => {
    const response = await service.send({
      userId: hermesId,
      correlationId,
      request: {
        to: 'Hermes',
        subject: 'Für die nächste Sitzung',
        body: 'Der Deploy auf fpb2 steht noch aus.',
        client: 'hermes',
      },
    });

    expect(response.message.to.userId).toBe(hermesId);
    expect(response.waiting).toBe(1);
  });

  it('refuses to point at a page outside the memory area', async () => {
    const elsewhere = await prisma.document.create({
      data: {
        workspace: { connect: { id: outsiderWorkspaceId } },
        createdBy: { connect: { id: strangerId } },
        updatedBy: { connect: { id: strangerId } },
        type: 'PAGE',
        title: 'Fremd',
        orderKey: 'a0',
      },
    });

    await expect(
      service.send({
        userId: hermesId,
        correlationId,
        request: {
          to: 'Claude Code',
          subject: 'Sieh dir das an',
          body: 'Die Seite erklärt es.',
          client: 'hermes',
          documentId: elsewhere.id,
        },
      }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('refuses to send while the mailbox is switched off', async () => {
    settings = { ...settings, 'memory.mailboxEnabled': false };

    await expect(send()).rejects.toMatchObject({ code: 'memory_unavailable' });
  });
});

describe('list', () => {
  it('shows the inbox without acknowledging anything', async () => {
    await send();

    const first = await service.list(claudeId, { box: 'inbox', status: 'unread', limit: 20 });
    const second = await service.list(claudeId, { box: 'inbox', status: 'unread', limit: 20 });

    expect(first.messages).toHaveLength(1);
    expect(second.messages).toHaveLength(1);
    expect(second.unread).toBe(1);
    expect(second.messages[0]?.read).toBe(false);
  });

  it('names who else shares this memory area, so a sender need not guess', async () => {
    const response = await service.list(claudeId, { box: 'inbox', status: 'unread', limit: 20 });

    expect(response.recipients.map((recipient) => recipient.name).sort()).toEqual([
      'Claude Code',
      'Hermes',
    ]);
  });

  it('answers the sent box from the other side', async () => {
    await send();

    const sent = await service.list(hermesId, { box: 'sent', status: 'all', limit: 20 });

    expect(sent.messages).toHaveLength(1);
    expect(sent.messages[0]?.to.name).toBe('Claude Code');
    // The sender's own inbox is untouched by what it sent.
    expect(sent.unread).toBe(0);
  });

  it('stops delivering a message that has expired', async () => {
    const { message } = await send();
    await prisma.agentMessage.update({
      where: { id: message.id },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });

    const inbox = await service.list(claudeId, { box: 'inbox', status: 'unread', limit: 20 });

    expect(inbox.messages).toHaveLength(0);
    expect(inbox.unread).toBe(0);
  });
});

describe('markRead', () => {
  it('acknowledges once and is a no-op the second time', async () => {
    const { message } = await send();

    const first = await service.markRead({ userId: claudeId, ids: [message.id] });
    const second = await service.markRead({ userId: claudeId, ids: [message.id] });

    expect(first).toEqual({ marked: 1, unread: 0 });
    expect(second).toEqual({ marked: 0, unread: 0 });
  });

  it('marks nothing when somebody names a message that is not theirs', async () => {
    const { message } = await send();

    const response = await service.markRead({ userId: hermesId, ids: [message.id] });

    expect(response.marked).toBe(0);
    const row = await prisma.agentMessage.findUniqueOrThrow({ where: { id: message.id } });
    expect(row.readAt).toBeNull();
  });
});

describe('unreadMessagesForRecall', () => {
  it('reads the waiting mail without acknowledging it', async () => {
    await send();

    const deps = { prisma, logger, settings: settingsService };
    const waiting = await unreadMessagesForRecall(deps, {
      userId: claudeId,
      workspaceId: memoryWorkspaceId,
      limit: 3,
    });
    const again = await unreadMessagesForRecall(deps, {
      userId: claudeId,
      workspaceId: memoryWorkspaceId,
      limit: 3,
    });

    expect(waiting).toHaveLength(1);
    expect(again).toHaveLength(1);
  });

  it('carries nothing once the limit is zero or the mailbox is off', async () => {
    await send();
    const deps = { prisma, logger, settings: settingsService };

    expect(
      await unreadMessagesForRecall(deps, {
        userId: claudeId,
        workspaceId: memoryWorkspaceId,
        limit: 0,
      }),
    ).toEqual([]);

    settings = { ...settings, 'memory.mailboxEnabled': false };
    expect(
      await unreadMessagesForRecall(deps, {
        userId: claudeId,
        workspaceId: memoryWorkspaceId,
        limit: 3,
      }),
    ).toEqual([]);
  });

  it('answers with nothing rather than throwing when there is no memory area', async () => {
    const waiting = await unreadMessagesForRecall(
      { prisma, logger, settings: settingsService },
      { userId: claudeId, workspaceId: null, limit: 3 },
    );

    expect(waiting).toEqual([]);
  });
});
