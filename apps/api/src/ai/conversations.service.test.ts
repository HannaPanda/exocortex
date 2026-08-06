import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AuthorizationError, WorkspaceAccessService } from '@exocortex/auth';
import { loadDotEnv } from '@exocortex/config';
import { createPrismaClient, type PrismaClient } from '@exocortex/database';
import { createLogger, type Logger } from '@exocortex/logger';
import { QueueRegistry } from '@exocortex/queue';

import { AppError } from '../common/app-error';
import { OutboxService } from '../common/outbox.service';
import { SettingsService } from '../platform/settings.service';

import { AiModelResolverService } from './ai-model-resolver.service';
import { ConversationsService } from './conversations.service';

/**
 * Conversation domain tests against the real database and Redis.
 *
 * Services are constructed directly rather than through the Nest container
 * (same approach as `documents.integration.test.ts`), so the tests stay free
 * of HTTP and DI concerns.
 */
loadDotEnv();

const logger: Logger = createLogger({ name: 'api-test', level: 'silent' });

let prisma: PrismaClient;
let queues: QueueRegistry;
let service: ConversationsService;
let workspaceId: string;
/** A workspace `ownerId` is deliberately not a member of, for the access tests. */
let foreignWorkspaceId: string;
let ownerId: string;
let otherMemberId: string;
let outsiderId: string;
let noThinkingModelSlug: string;

beforeAll(async () => {
  prisma = createPrismaClient({ databaseUrl: process.env.DATABASE_URL });
  queues = new QueueRegistry({ redisUrl: process.env.REDIS_URL ?? 'redis://127.0.0.1:6380', logger });
  const access = new WorkspaceAccessService(prisma);
  const outbox = new OutboxService(prisma, logger);
  const settings = new SettingsService(prisma, logger, outbox);
  const envDefaultModel = process.env.OPENROUTER_DEFAULT_MODEL ?? 'anthropic/claude-sonnet-4.5';
  const modelResolver = new AiModelResolverService(prisma, envDefaultModel, settings);
  service = new ConversationsService(prisma, queues, logger, access, modelResolver, settings);

  const noThinkingModel = await prisma.aiModel.findFirst({
    where: { enabled: true, reasoningLevels: { equals: ['NONE'] } },
    select: { slug: true },
  });
  if (noThinkingModel === null) {
    throw new Error('Expected the seeded registry to contain a NONE-only model for this test');
  }
  noThinkingModelSlug = noThinkingModel.slug;

  const suffix = Date.now().toString(36);
  const [owner, otherMember, outsider] = await Promise.all([
    prisma.user.create({
      data: { email: `conv-owner-${suffix}@exocortex.test`, name: 'Owner', emailVerified: true },
    }),
    prisma.user.create({
      data: { email: `conv-other-${suffix}@exocortex.test`, name: 'Other', emailVerified: true },
    }),
    prisma.user.create({
      data: { email: `conv-outsider-${suffix}@exocortex.test`, name: 'Outsider', emailVerified: true },
    }),
  ]);
  ownerId = owner.id;
  otherMemberId = otherMember.id;
  outsiderId = outsider.id;

  const [workspace, foreignWorkspace] = await Promise.all([
    prisma.workspace.create({
      data: {
        name: `Conversations ${suffix}`,
        slug: `conversations-${suffix}`,
        members: {
          create: [
            { userId: ownerId, role: 'OWNER' },
            { userId: otherMemberId, role: 'MEMBER' },
          ],
        },
      },
    }),
    prisma.workspace.create({
      data: {
        name: `Conversations foreign ${suffix}`,
        slug: `conversations-foreign-${suffix}`,
        members: { create: [{ userId: outsiderId, role: 'OWNER' }] },
      },
    }),
  ]);
  workspaceId = workspace.id;
  foreignWorkspaceId = foreignWorkspace.id;
}, 60_000);

afterAll(async () => {
  await prisma.workspace.deleteMany({ where: { id: { in: [workspaceId, foreignWorkspaceId] } } });
  await prisma.user.deleteMany({ where: { id: { in: [ownerId, otherMemberId, outsiderId] } } });
  await queues.close();
  await prisma.$disconnect();
});

async function createConversation(userId: string = ownerId): Promise<string> {
  const { conversation } = await service.create({
    userId,
    request: { workspaceId, documentId: null },
  });
  return conversation.id;
}

let documentCounter = 0;

/** A page in the test workspace. Created directly: the document service is not what is under test here. */
async function createDocument(title: string): Promise<string> {
  documentCounter += 1;
  const document = await prisma.document.create({
    data: {
      workspaceId,
      title,
      type: 'PAGE',
      orderKey: `a${documentCounter.toString().padStart(4, '0')}`,
      createdById: ownerId,
      updatedById: ownerId,
    },
  });
  return document.id;
}

/** A page in a workspace the conversation owner is not a member of. */
async function createForeignDocument(): Promise<string> {
  documentCounter += 1;
  const document = await prisma.document.create({
    data: {
      workspaceId: foreignWorkspaceId,
      title: 'Fremde Seite',
      type: 'PAGE',
      orderKey: `b${documentCounter.toString().padStart(4, '0')}`,
      createdById: outsiderId,
      updatedById: outsiderId,
    },
  });
  return document.id;
}

describe('ConversationsService.create / get / list', () => {
  it('creates a conversation with the placeholder title', async () => {
    const { conversation } = await service.create({
      userId: ownerId,
      request: { workspaceId, documentId: null },
    });
    expect(conversation.title).toBe('Neue Unterhaltung');
    expect(conversation.workspaceId).toBe(workspaceId);
    expect(conversation.messageCount).toBe(0);
  });

  it('lists only the caller-created conversations, most recent first', async () => {
    const first = await createConversation();
    const second = await createConversation();
    const { conversations } = await service.list({ workspaceId, userId: ownerId, includeArchived: false });
    const ids = conversations.map((entry) => entry.id);
    expect(ids.indexOf(second)).toBeLessThan(ids.indexOf(first));
    expect(conversations.every((entry) => entry.createdById === ownerId)).toBe(true);
  });

  it('rejects a conversation-owning-conversation lookup by another workspace member', async () => {
    const conversationId = await createConversation(ownerId);
    await expect(service.get(conversationId, otherMemberId)).rejects.toBeInstanceOf(AppError);
    await expect(service.get(conversationId, otherMemberId)).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('rejects access for someone outside the workspace entirely', async () => {
    const conversationId = await createConversation(ownerId);
    await expect(service.get(conversationId, 'not-a-member-id')).rejects.toBeInstanceOf(AuthorizationError);
  });
});

describe('ConversationsService.postMessage', () => {
  it('persists the user message, creates a pending run and enqueues it', async () => {
    const conversationId = await createConversation();
    const response = await service.postMessage({
      conversationId,
      userId: ownerId,
      request: { content: 'Was ist Exocortex?' },
      correlationId: 'test-post-1',
    });

    expect(response.command).toBeNull();
    expect(response.userMessage?.role).toBe('user');
    expect(response.userMessage?.content).toBe('Was ist Exocortex?');
    // Asserted on the value `postMessage` returns synchronously at creation
    // time, not on a fresh re-read: the live worker on this shared host also
    // consumes this queue and may have already started or finished the run by
    // the time a second query would run.
    expect(response.run?.status).toBe('pending');
    expect(response.run?.conversationId).toBe(conversationId);

    const run = await prisma.aiRun.findUniqueOrThrow({ where: { id: response.run?.id } });
    expect(run.conversationId).toBe(conversationId);
    expect(run.model.length).toBeGreaterThan(0);
  });

  it('derives the conversation title from the first message', async () => {
    const conversationId = await createConversation();
    await service.postMessage({
      conversationId,
      userId: ownerId,
      request: { content: 'Wie funktioniert die Auftragsschlüssel-Sortierung im Dokumentbaum genau?' },
      correlationId: 'test-post-2',
    });
    const conversation = await prisma.aiConversation.findUniqueOrThrow({ where: { id: conversationId } });
    expect(conversation.title).toBe(
      'Wie funktioniert die Auftragsschlüssel-Sortierung im Dokumentbaum genau'.slice(0, 60),
    );
  });

  it('refuses a new message while a run is still pending or running', async () => {
    const conversationId = await createConversation();
    // Inserted directly rather than through `postMessage`: the live worker on
    // this shared host also consumes the `ai` queue and would otherwise race
    // to complete a real run before the lock could be observed.
    await prisma.aiRun.create({
      data: {
        workspaceId,
        createdById: ownerId,
        status: 'RUNNING',
        provider: 'test-lock-provider',
        model: 'test-lock-model',
        messages: [],
        conversationId,
      },
    });

    await expect(
      service.postMessage({
        conversationId,
        userId: ownerId,
        request: { content: 'Zweite Frage' },
        correlationId: 'test-lock-2',
      }),
    ).rejects.toMatchObject({ code: 'ai_conversation_locked' });
  });

  it('rejects postMessage from a user who does not own the conversation', async () => {
    const conversationId = await createConversation(ownerId);
    await expect(
      service.postMessage({
        conversationId,
        userId: otherMemberId,
        request: { content: 'Darf ich das lesen?' },
        correlationId: 'test-owner-1',
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  describe('page context', () => {
    it('binds the run to the page the caller is on and remembers it on the conversation', async () => {
      const conversationId = await createConversation();
      const documentId = await createDocument('Steuern 2026');

      const response = await service.postMessage({
        conversationId,
        userId: ownerId,
        request: { content: 'Fasse das mal zusammen', documentId },
        correlationId: 'test-context-1',
      });

      const run = await prisma.aiRun.findUniqueOrThrow({ where: { id: response.run?.id } });
      expect(run.documentId).toBe(documentId);
      const conversation = await prisma.aiConversation.findUniqueOrThrow({ where: { id: conversationId } });
      expect(conversation.documentId).toBe(documentId);
    });

    it('records a switch in the transcript, before the message that caused it', async () => {
      const conversationId = await createConversation();
      const first = await createDocument('Erste Seite');
      const second = await createDocument('Zweite Seite');

      await service.postMessage({
        conversationId,
        userId: ownerId,
        request: { content: 'Frage auf der ersten Seite', documentId: first },
        correlationId: 'test-context-2a',
      });
      await prisma.aiRun.updateMany({ where: { conversationId }, data: { status: 'COMPLETED', finishedAt: new Date() } });
      await service.postMessage({
        conversationId,
        userId: ownerId,
        request: { content: 'Frage auf der zweiten Seite', documentId: second },
        correlationId: 'test-context-2b',
      });

      const messages = await prisma.aiConversationMessage.findMany({
        where: { conversationId },
        orderBy: { createdAt: 'asc' },
      });
      const switchIndex = messages.findIndex((message) => message.content.startsWith('↳ Kontextwechsel'));
      expect(switchIndex).toBeGreaterThanOrEqual(0);
      expect(messages[switchIndex]?.role).toBe('SYSTEM');
      expect(messages[switchIndex]?.content).toContain('Zweite Seite');
      expect(messages[switchIndex + 1]?.content).toBe('Frage auf der zweiten Seite');
    });

    it('stays quiet when the page does not change', async () => {
      const conversationId = await createConversation();
      const documentId = await createDocument('Dieselbe Seite');

      await service.postMessage({
        conversationId,
        userId: ownerId,
        request: { content: 'Erste Frage', documentId },
        correlationId: 'test-context-3a',
      });
      await prisma.aiRun.updateMany({ where: { conversationId }, data: { status: 'COMPLETED', finishedAt: new Date() } });
      await service.postMessage({
        conversationId,
        userId: ownerId,
        request: { content: 'Zweite Frage', documentId },
        correlationId: 'test-context-3b',
      });

      const systemMessages = await prisma.aiConversationMessage.count({
        where: { conversationId, role: 'SYSTEM' },
      });
      expect(systemMessages).toBe(0);
    });

    it('says so when the user leaves the page, and does not silently keep the old one', async () => {
      const conversationId = await createConversation();
      const documentId = await createDocument('Verlassene Seite');

      await service.postMessage({
        conversationId,
        userId: ownerId,
        request: { content: 'Frage mit Seite', documentId },
        correlationId: 'test-context-4a',
      });
      await prisma.aiRun.updateMany({ where: { conversationId }, data: { status: 'COMPLETED', finishedAt: new Date() } });
      const response = await service.postMessage({
        conversationId,
        userId: ownerId,
        request: { content: 'Frage ohne Seite', documentId: null },
        correlationId: 'test-context-4b',
      });

      const run = await prisma.aiRun.findUniqueOrThrow({ where: { id: response.run?.id } });
      expect(run.documentId).toBeNull();
      const marker = await prisma.aiConversationMessage.findFirst({
        where: { conversationId, role: 'SYSTEM' },
      });
      expect(marker?.content).toContain('keine Seite mehr geöffnet');
    });

    it('inherits the conversation page when the client omits the field entirely', async () => {
      const documentId = await createDocument('Von Anfang an gebunden');
      const { conversation } = await service.create({
        userId: ownerId,
        request: { workspaceId, documentId },
      });

      const response = await service.postMessage({
        conversationId: conversation.id,
        userId: ownerId,
        request: { content: 'Frage ohne documentId im Request' },
        correlationId: 'test-context-5',
      });

      const run = await prisma.aiRun.findUniqueOrThrow({ where: { id: response.run?.id } });
      expect(run.documentId).toBe(documentId);
      const systemMessages = await prisma.aiConversationMessage.count({
        where: { conversationId: conversation.id, role: 'SYSTEM' },
      });
      expect(systemMessages).toBe(0);
    });

    it('refuses a documentId the caller cannot see, instead of putting its title in the prompt', async () => {
      const conversationId = await createConversation();
      const foreignDocumentId = await createForeignDocument();

      await expect(
        service.postMessage({
          conversationId,
          userId: ownerId,
          request: { content: 'Was steht da drin?', documentId: foreignDocumentId },
          correlationId: 'test-context-6',
        }),
      ).rejects.toMatchObject({ code: 'document_access_denied' });
    });
  });

  describe('/clear', () => {
    it('supersedes active messages and resets estimatedTokens without deleting rows', async () => {
      const conversationId = await createConversation();
      await service.postMessage({
        conversationId,
        userId: ownerId,
        request: { content: 'Eine Frage, die einen Lauf erzeugt' },
        correlationId: 'test-clear-1',
      });
      await prisma.aiRun.updateMany({
        where: { conversationId },
        data: { status: 'COMPLETED', finishedAt: new Date() },
      });

      const response = await service.postMessage({
        conversationId,
        userId: ownerId,
        request: { content: '/clear' },
        correlationId: 'test-clear-2',
      });

      expect(response.run).toBeNull();
      expect(response.command).toMatchObject({ command: 'clear', conversationChanged: false });

      const messages = await prisma.aiConversationMessage.findMany({ where: { conversationId } });
      expect(messages.length).toBeGreaterThan(0);
      expect(messages.every((message) => message.supersededAt !== null)).toBe(true);
      const conversation = await prisma.aiConversation.findUniqueOrThrow({ where: { id: conversationId } });
      expect(conversation.estimatedTokens).toBe(0);
    });
  });

  describe('/new', () => {
    it('creates a fresh conversation and reports conversationChanged', async () => {
      const conversationId = await createConversation();
      const response = await service.postMessage({
        conversationId,
        userId: ownerId,
        request: { content: '/new Mein zweiter Chat' },
        correlationId: 'test-new-1',
      });
      expect(response.command?.conversationChanged).toBe(true);
      expect(response.command?.conversationId).not.toBe(conversationId);

      const created = await prisma.aiConversation.findUniqueOrThrow({
        where: { id: response.command?.conversationId },
      });
      expect(created.title).toBe('Mein zweiter Chat');
    });
  });

  describe('/model', () => {
    it('switches the model and reports its display name', async () => {
      const conversationId = await createConversation();
      const response = await service.postMessage({
        conversationId,
        userId: ownerId,
        request: { content: `/model ${noThinkingModelSlug}` },
        correlationId: 'test-model-1',
      });
      expect(response.command?.command).toBe('model');
      expect(response.command?.message).toContain('Modell gewechselt zu');

      const conversation = await prisma.aiConversation.findUniqueOrThrow({
        where: { id: conversationId },
        include: { model: { select: { slug: true } } },
      });
      expect(conversation.model?.slug).toBe(noThinkingModelSlug);
    });

    it('rejects an unknown model slug', async () => {
      const conversationId = await createConversation();
      await expect(
        service.postMessage({
          conversationId,
          userId: ownerId,
          request: { content: '/model does-not-exist/nope' },
          correlationId: 'test-model-2',
        }),
      ).rejects.toMatchObject({ code: 'ai_model_unknown' });
    });
  });

  describe('/think', () => {
    it('clamps a reasoning level the current model does not support', async () => {
      const conversationId = await createConversation();
      await service.postMessage({
        conversationId,
        userId: ownerId,
        request: { content: `/model ${noThinkingModelSlug}` },
        correlationId: 'test-think-setup',
      });

      const response = await service.postMessage({
        conversationId,
        userId: ownerId,
        request: { content: '/think high' },
        correlationId: 'test-think-1',
      });
      expect(response.command?.message).toContain('unterstützt diese Stufe nicht');

      const conversation = await prisma.aiConversation.findUniqueOrThrow({ where: { id: conversationId } });
      expect(conversation.reasoningLevel).toBe('NONE');
    });
  });

  describe('/help and /tools and /rules', () => {
    it('renders a non-empty help list', async () => {
      const conversationId = await createConversation();
      const response = await service.postMessage({
        conversationId,
        userId: ownerId,
        request: { content: '/help' },
        correlationId: 'test-help-1',
      });
      expect(response.command?.message).toContain('/clear');
      expect(response.command?.message).toContain('/model');
    });

    it('renders the tool catalogue', async () => {
      const conversationId = await createConversation();
      const response = await service.postMessage({
        conversationId,
        userId: ownerId,
        request: { content: '/tools' },
        correlationId: 'test-tools-1',
      });
      expect(response.command?.message.length ?? 0).toBeGreaterThan(0);
    });

    it('reports no active rule pages for a fresh workspace', async () => {
      const conversationId = await createConversation();
      const response = await service.postMessage({
        conversationId,
        userId: ownerId,
        request: { content: '/rules' },
        correlationId: 'test-rules-1',
      });
      expect(response.command?.message).toContain('Keine aktiven KI-Regelseiten');
    });
  });

  describe('/compact', () => {
    it('returns the advisory message without enqueueing anything', async () => {
      const conversationId = await createConversation();
      const response = await service.postMessage({
        conversationId,
        userId: ownerId,
        request: { content: '/compact' },
        correlationId: 'test-compact-1',
      });
      expect(response.run).toBeNull();
      expect(response.command?.message).toContain('/clear');
    });
  });
});

describe('ConversationsService.archive', () => {
  it('soft-archives instead of deleting the row', async () => {
    const conversationId = await createConversation();
    const result = await service.archive(conversationId, ownerId);
    expect(result).toEqual({ archived: true });

    const conversation = await prisma.aiConversation.findUniqueOrThrow({ where: { id: conversationId } });
    expect(conversation.archivedAt).not.toBeNull();
  });
});
