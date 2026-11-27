import { Readable } from 'node:stream';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { WorkspaceAccessService } from '@exocortex/auth';
import { type ApiEnv, loadDotEnv } from '@exocortex/config';
import { createPrismaClient, type PrismaClient } from '@exocortex/database';
import { createLogger, type Logger } from '@exocortex/logger';
import { QueueRegistry, testQueuePrefix } from '@exocortex/queue';
import { type ObjectStorage, type PutObjectInput, type StoredObject } from '@exocortex/storage';

import { AttachmentsService } from '../attachments/attachments.service';
import { OutboxService } from '../common/outbox.service';
import { SettingsService } from '../platform/settings.service';

import { AiModelResolverService } from './ai-model-resolver.service';
import { ChatAttachmentsService } from './chat-attachments.service';
import { ConversationArchiveService } from './conversation-archive.service';
import { ConversationSearchService } from './conversation-search';
import { ConversationsService } from './conversations.service';

/**
 * Files on chat messages (issue #223) against the real database and Redis,
 * with the object storage held in memory: upload, who may read one, binding
 * on send, the limit, and that deleting a chat leaves nothing in the bucket.
 */
loadDotEnv();

const logger: Logger = createLogger({ name: 'api-test', level: 'silent' });

/** A 1x1 PNG, enough for the magic-byte check and the preview. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n', 'utf8');

/** The bucket, as a map, so a test can see what is left in it. */
class MemoryStorage implements ObjectStorage {
  readonly objects = new Map<string, Buffer>();
  putObject(input: PutObjectInput): Promise<StoredObject> {
    const body = Buffer.from(input.body);
    this.objects.set(input.key, body);
    return Promise.resolve({
      key: input.key,
      byteSize: body.byteLength,
      etag: null,
      contentType: input.contentType,
    });
  }
  getObject(input: { key: string }): Promise<Readable> {
    const body = this.objects.get(input.key);
    if (body === undefined) throw new Error(`no object ${input.key}`);
    return Promise.resolve(Readable.from(body));
  }
  deleteObject(input: { key: string }): Promise<void> {
    this.objects.delete(input.key);
    return Promise.resolve();
  }
  createDownloadUrl(input: { key: string }): Promise<string> {
    return Promise.resolve(`memory://${input.key}`);
  }
  healthCheck(): Promise<boolean> {
    return Promise.resolve(true);
  }
}

let prisma: PrismaClient;
let queues: QueueRegistry;
let storage: MemoryStorage;
let access: WorkspaceAccessService;
let chatAttachments: ChatAttachmentsService;
let conversations: ConversationsService;
let archive: ConversationArchiveService;
let workspaceId: string;
let tightWorkspaceId: string;
let ownerId: string;
let memberId: string;

beforeAll(async () => {
  prisma = createPrismaClient({ databaseUrl: process.env.DATABASE_URL });
  queues = new QueueRegistry({
    redisUrl: process.env.REDIS_URL ?? 'redis://127.0.0.1:6380',
    logger,
    prefix: testQueuePrefix('api-chat-attachments'),
  });
  storage = new MemoryStorage();
  access = new WorkspaceAccessService(prisma);
  const outbox = new OutboxService(prisma, logger);
  const settings = new SettingsService(prisma, logger, outbox);
  const modelResolver = new AiModelResolverService(
    prisma,
    process.env.OPENROUTER_DEFAULT_MODEL ?? 'anthropic/claude-sonnet-4.5',
    settings,
  );
  const attachments = new AttachmentsService(
    prisma,
    storage,
    { MAX_UPLOAD_BYTES: 1024 * 1024 } as unknown as ApiEnv,
    logger,
    queues,
    access,
    outbox,
    settings,
  );
  chatAttachments = new ChatAttachmentsService(
    prisma,
    storage,
    logger,
    access,
    attachments,
    settings,
  );
  conversations = new ConversationsService(
    prisma,
    queues,
    logger,
    access,
    modelResolver,
    settings,
    chatAttachments,
  );
  archive = new ConversationArchiveService(
    prisma,
    logger,
    { APP_URL: 'https://exocortex.test' } as unknown as ApiEnv,
    access,
    modelResolver,
    new ConversationSearchService(prisma),
    // Saving a chat as a page is not under test here.
    {} as unknown as ConstructorParameters<typeof ConversationArchiveService>[6],
    {} as unknown as ConstructorParameters<typeof ConversationArchiveService>[7],
    chatAttachments,
  );

  const suffix = Date.now().toString(36);
  const [owner, member] = await Promise.all([
    prisma.user.create({
      data: {
        email: `chatfile-owner-${suffix}@exocortex.test`,
        name: 'Owner',
        emailVerified: true,
      },
    }),
    prisma.user.create({
      data: {
        email: `chatfile-member-${suffix}@exocortex.test`,
        name: 'Member',
        emailVerified: true,
      },
    }),
  ]);
  ownerId = owner.id;
  memberId = member.id;
  const members = {
    create: [
      { userId: ownerId, role: 'OWNER' as const },
      { userId: memberId, role: 'MEMBER' as const },
    ],
  };
  const [workspace, tight] = await Promise.all([
    prisma.workspace.create({
      data: { name: `Chat files ${suffix}`, slug: `chat-files-${suffix}`, members },
    }),
    prisma.workspace.create({
      data: { name: `Chat files tight ${suffix}`, slug: `chat-files-tight-${suffix}`, members },
    }),
  ]);
  workspaceId = workspace.id;
  tightWorkspaceId = tight.id;
  await prisma.workspaceSetting.create({
    data: { workspaceId: tightWorkspaceId, key: 'ai.visionMaxImagesPerRun', value: 1 },
  });
}, 60_000);

afterAll(async () => {
  await prisma.workspace.deleteMany({ where: { id: { in: [workspaceId, tightWorkspaceId] } } });
  await prisma.user.deleteMany({ where: { id: { in: [ownerId, memberId] } } });
  await queues.obliterateAll();
  await queues.close();
  await prisma.$disconnect();
});

async function createConversation(inWorkspace = workspaceId, userId = ownerId): Promise<string> {
  const { conversation } = await conversations.create({
    userId,
    request: { workspaceId: inWorkspace, documentId: null },
  });
  return conversation.id;
}

function upload(conversationId: string, body = PNG, userId = ownerId, filename = 'bild.png') {
  return chatAttachments.upload({
    conversationId,
    userId,
    filename,
    declaredMimeType: undefined,
    body,
    correlationId: 'test-chat-attachments',
  });
}

describe('uploading a chat file', () => {
  it('stores a picture on the conversation, on no page and no message yet', async () => {
    const conversationId = await createConversation();
    const { attachment } = await upload(conversationId);

    expect(attachment).toMatchObject({ mimeType: 'image/png', description: null });
    const row = await prisma.attachment.findUniqueOrThrow({ where: { id: attachment.id } });
    expect(row).toMatchObject({ conversationId, documentId: null, conversationMessageId: null });
    expect(storage.objects.has(row.storageKey)).toBe(true);
  });

  it('refuses a file that is not a picture', async () => {
    const conversationId = await createConversation();
    await expect(upload(conversationId, PDF, ownerId, 'brief.pdf')).rejects.toMatchObject({
      code: 'unsupported_media_type',
    });
  });

  it("refuses somebody else's conversation", async () => {
    const conversationId = await createConversation();
    await expect(upload(conversationId, PNG, memberId)).rejects.toMatchObject({
      code: 'forbidden',
    });
  });

  it('refuses more unsent pictures than one run describes', async () => {
    const conversationId = await createConversation(tightWorkspaceId);
    await upload(conversationId);
    await expect(upload(conversationId)).rejects.toMatchObject({
      code: 'ai_chat_attachments_limit',
      details: { limit: 1 },
    });
  });
});

describe('who may read a chat file', () => {
  it('is its owner alone, not another member of the workspace', async () => {
    const conversationId = await createConversation();
    const { attachment } = await upload(conversationId);

    expect(await access.findAttachmentContext(attachment.id, ownerId)).not.toBeNull();
    expect(await access.findAttachmentContext(attachment.id, memberId)).toBeNull();
  });
});

describe('sending a message with files', () => {
  it('binds them to the message and shows them on it after a reload', async () => {
    const conversationId = await createConversation();
    const { attachment } = await upload(conversationId);

    const response = await conversations.postMessage({
      conversationId,
      userId: ownerId,
      // A picture can be the whole question.
      request: { content: '', attachmentIds: [attachment.id] },
      correlationId: 'test-chat-attachments-send',
    });
    expect(response.userMessage?.attachments.map((file) => file.id)).toEqual([attachment.id]);

    const detail = await conversations.get(conversationId, ownerId);
    const user = detail.messages.find((message) => message.role === 'user');
    expect(user?.attachments).toHaveLength(1);
    expect(user?.attachments[0]).toMatchObject({ id: attachment.id, filename: 'bild.png' });
  });

  it('refuses a file that went with an earlier message, and writes nothing', async () => {
    const conversationId = await createConversation();
    const { attachment } = await upload(conversationId);
    await conversations.postMessage({
      conversationId,
      userId: ownerId,
      request: { content: 'Was ist das?', attachmentIds: [attachment.id] },
      correlationId: 'test-chat-attachments-first',
    });
    // The first run is still open; close it as a worker would.
    await prisma.aiRun.updateMany({ where: { conversationId }, data: { status: 'COMPLETED' } });
    const before = await prisma.aiConversationMessage.count({ where: { conversationId } });

    await expect(
      conversations.postMessage({
        conversationId,
        userId: ownerId,
        request: { content: 'Und das?', attachmentIds: [attachment.id] },
        correlationId: 'test-chat-attachments-again',
      }),
    ).rejects.toMatchObject({ code: 'ai_chat_attachment_invalid' });
    expect(await prisma.aiConversationMessage.count({ where: { conversationId } })).toBe(before);
  });

  it("refuses a file of another of the owner's conversations", async () => {
    const [first, second] = [await createConversation(), await createConversation()];
    const { attachment } = await upload(first);
    await expect(
      conversations.postMessage({
        conversationId: second,
        userId: ownerId,
        request: { content: 'Hier?', attachmentIds: [attachment.id] },
        correlationId: 'test-chat-attachments-cross',
      }),
    ).rejects.toMatchObject({ code: 'ai_chat_attachment_invalid' });
  });
});

describe('deleting a chat for good', () => {
  it('takes its files with it, rows and stored objects alike', async () => {
    const conversationId = await createConversation();
    const sent = await upload(conversationId);
    const unsent = await upload(conversationId);
    await conversations.postMessage({
      conversationId,
      userId: ownerId,
      request: { content: 'Schau mal', attachmentIds: [sent.attachment.id] },
      correlationId: 'test-chat-attachments-delete',
    });
    const rows = await prisma.attachment.findMany({
      where: { conversationId },
      select: { id: true, storageKey: true, previewKey: true },
    });
    const keys = rows.flatMap((row) => [row.storageKey, row.previewKey]).filter(Boolean);
    expect(keys.every((key) => storage.objects.has(key as string))).toBe(true);

    const result = await archive.deletePermanently(conversationId, ownerId);

    expect(result.attachmentsDeleted).toBe(2);
    expect(
      await prisma.attachment.count({
        where: { id: { in: [sent.attachment.id, unsent.attachment.id] } },
      }),
    ).toBe(0);
    expect(keys.some((key) => storage.objects.has(key as string))).toBe(false);
  });
});
