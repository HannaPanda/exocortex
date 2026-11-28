import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AuthorizationError, WorkspaceAccessService } from '@exocortex/auth';
import { type ApiEnv, loadDotEnv } from '@exocortex/config';
import { createPrismaClient, type PrismaClient } from '@exocortex/database';
import { createLogger, type Logger } from '@exocortex/logger';
import { QueueRegistry, testQueuePrefix } from '@exocortex/queue';
import { type ObjectStorage } from '@exocortex/storage';

import { AppError } from '../common/app-error';
import { OutboxService } from '../common/outbox.service';
import { DocumentMoveService } from '../documents/document-move.service';
import { DocumentTrashService } from '../documents/document-trash.service';
import { DocumentsService } from '../documents/documents.service';
import { type RealtimeService } from '../realtime/realtime.service';

import { AttachmentsService } from './attachments.service';
import { CellFilesService } from './cell-files.service';
import { UploadTicketsService } from './upload-tickets.service';

/**
 * Files on a page shared as "only this page" (issue #264, ADR-044 addendum
 * 2026-11-28), against the real database with only the object store stood in.
 *
 * A writing grant on the page alone carries files onto that page, takes any of
 * its files off again and sets its cover; it creates nothing below the page,
 * and it reaches no file of a page it was never given. A reading grant does
 * none of it.
 */
loadDotEnv();

const logger: Logger = createLogger({ name: 'api-test', level: 'silent' });
const correlationId = 'page-grant-files-test';

let prisma: PrismaClient;
let queues: QueueRegistry;
let attachments: AttachmentsService;
let documents: DocumentsService;
let tickets: UploadTicketsService;

let workspaceId: string;
let ownerId: string;
let writerId: string;
let readerId: string;
let sharedPageId: string;
let childPageId: string;
let otherPageId: string;

const storage = {
  putObject: async () => undefined,
  deleteObject: async () => undefined,
  getObject: async () => undefined,
  createDownloadUrl: async () => 'https://storage.test/object',
} as unknown as ObjectStorage;
const realtime = {
  emit: async () => undefined,
  revoke: async () => undefined,
} as unknown as RealtimeService;

beforeAll(async () => {
  prisma = createPrismaClient({ databaseUrl: process.env.DATABASE_URL });
  queues = new QueueRegistry({
    redisUrl: process.env.REDIS_URL ?? 'redis://127.0.0.1:6380',
    logger,
    prefix: testQueuePrefix('api-page-grant-files'),
  });
  const access = new WorkspaceAccessService(prisma);
  const outbox = new OutboxService(prisma, logger);
  const env = { MAX_UPLOAD_BYTES: 1024 * 1024, APP_URL: 'https://exocortex.test' } as ApiEnv;
  const cellFiles = new CellFilesService(prisma, access, outbox, realtime);
  attachments = new AttachmentsService(
    prisma,
    storage,
    env,
    logger,
    queues,
    access,
    outbox,
    // A plain-text file has no text engine, so no setting is consulted.
    { getKey: async () => false } as unknown as ConstructorParameters<typeof AttachmentsService>[7],
    cellFiles,
  );
  documents = new DocumentsService(
    prisma,
    queues,
    logger,
    storage,
    access,
    outbox,
    realtime,
    new DocumentTrashService(prisma, queues, logger, storage, access, outbox, realtime),
    new DocumentMoveService(prisma, queues, logger, access, outbox, realtime),
  );
  tickets = new UploadTicketsService(prisma, env, logger, access, attachments, cellFiles);

  const suffix = Date.now().toString(36);
  const [owner, writer, reader] = await Promise.all(
    ['owner', 'writer', 'reader'].map((name) =>
      prisma.user.create({
        data: { email: `grant-files-${name}-${suffix}@exocortex.test`, name, emailVerified: true },
      }),
    ),
  );
  ownerId = owner!.id;
  writerId = writer!.id;
  readerId = reader!.id;

  const workspace = await prisma.workspace.create({
    data: {
      name: `Grant files ${suffix}`,
      slug: `grant-files-${suffix}`,
      members: { create: { userId: ownerId, role: 'OWNER' } },
    },
  });
  workspaceId = workspace.id;

  sharedPageId = await createPage('Nur diese Seite');
  childPageId = await createPage('Darunter', sharedPageId);
  otherPageId = await createPage('Nicht geteilt');

  await prisma.documentShare.createMany({
    data: [
      { permission: 'WRITE' as const, granteeId: writerId },
      { permission: 'READ' as const, granteeId: readerId },
    ].map((grant) => ({
      ...grant,
      workspaceId,
      documentId: sharedPageId,
      kind: 'USER' as const,
      scope: 'PAGE_ONLY' as const,
      createdById: ownerId,
    })),
  });
});

afterAll(async () => {
  await prisma.documentShare.deleteMany({ where: { workspaceId } });
  await prisma.workspace.deleteMany({ where: { id: workspaceId } });
  await prisma.user.deleteMany({ where: { id: { in: [ownerId, writerId, readerId] } } });
  await queues.obliterateAll();
  await queues.close();
  await prisma.$disconnect();
});

async function createPage(title: string, parentId: string | null = null): Promise<string> {
  const page = await documents.create({
    workspaceId,
    userId: ownerId,
    request: { title, type: 'PAGE', parentId },
    correlationId,
  });
  return page.id;
}

function uploadAs(userId: string, documentId: string | null) {
  return attachments.upload({
    workspaceId,
    userId,
    documentId,
    filename: 'notiz.txt',
    declaredMimeType: 'text/plain',
    body: Buffer.from('Ein Absatz für die Seite', 'utf8'),
    correlationId,
  });
}

/** A file somebody else put there, written straight into the table. */
async function fileOf(documentId: string, mimeType = 'image/png'): Promise<string> {
  const row = await prisma.attachment.create({
    data: {
      workspaceId,
      documentId,
      filename: 'bild.png',
      mimeType,
      byteSize: 128,
      storageKey: `test/grant-files-${Math.random().toString(36).slice(2)}`,
      createdById: ownerId,
    },
  });
  return row.id;
}

describe('a writing grant on the page alone', () => {
  it('uploads a file onto the shared page', async () => {
    const uploaded = await uploadAs(writerId, sharedPageId);
    expect(uploaded.attachment.documentId).toBe(sharedPageId);
    expect(uploaded.attachment.createdById).toBe(writerId);
  });

  it('mints an upload ticket for the shared page', async () => {
    const minted = await tickets.mint({
      workspaceId,
      minter: {
        userId: writerId,
        credential: 'session',
        apiTokenId: undefined,
        credentialExpiresAt: new Date('2999-01-01'),
      },
      request: { documentId: sharedPageId, filename: null, propertyId: null },
    });
    expect(minted.ticket.documentId).toBe(sharedPageId);
    expect((await tickets.get(minted.ticket.id, writerId)).ticket.id).toBe(minted.ticket.id);
  });

  it('creates nothing below the page: no sub-page, no file on one', async () => {
    await expect(
      documents.create({
        workspaceId,
        userId: writerId,
        request: { title: 'Neue Unterseite', type: 'PAGE', parentId: sharedPageId },
        correlationId,
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);
    await expect(uploadAs(writerId, childPageId)).rejects.toBeInstanceOf(AuthorizationError);
  });

  it('reaches nothing outside the page: no other page, not the workspace', async () => {
    await expect(uploadAs(writerId, otherPageId)).rejects.toBeInstanceOf(AuthorizationError);
    await expect(uploadAs(writerId, null)).rejects.toBeInstanceOf(AuthorizationError);
  });

  it("takes any file of the page off it, the owner's included", async () => {
    const attachmentId = await fileOf(sharedPageId);
    await attachments.delete({ attachmentId, userId: writerId, correlationId });
    const row = await prisma.attachment.findUniqueOrThrow({ where: { id: attachmentId } });
    expect(row.deletedAt).not.toBeNull();
  });

  it('deletes no file of a page it was never given, and reads none', async () => {
    const attachmentId = await fileOf(otherPageId);
    await expect(
      attachments.delete({ attachmentId, userId: writerId, correlationId }),
    ).rejects.toMatchObject({ code: 'attachment_access_denied' });
    await expect(attachments.getTextInfo(attachmentId, writerId)).rejects.toMatchObject({
      code: 'attachment_access_denied',
    });
    const row = await prisma.attachment.findUniqueOrThrow({ where: { id: attachmentId } });
    expect(row.deletedAt).toBeNull();
  });

  it("sets the page's cover from one of its files and removes it again", async () => {
    const attachmentId = await fileOf(sharedPageId);
    const set = await documents.update({
      documentId: sharedPageId,
      userId: writerId,
      request: { coverAttachmentId: attachmentId, coverPosition: 40 },
      correlationId,
    });
    expect(set.coverAttachmentId).toBe(attachmentId);

    const removed = await documents.update({
      documentId: sharedPageId,
      userId: writerId,
      request: { coverAttachmentId: null },
      correlationId,
    });
    expect(removed.coverAttachmentId).toBeNull();
  });

  it('cannot hang a file of another page on its page as the cover', async () => {
    const foreignId = await fileOf(otherPageId);
    const refused = documents.update({
      documentId: sharedPageId,
      userId: writerId,
      request: { coverAttachmentId: foreignId },
      correlationId,
    });
    await expect(refused).rejects.toBeInstanceOf(AppError);
    await expect(refused).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('a reading grant on the page alone', () => {
  it('uploads nothing and deletes nothing', async () => {
    await expect(uploadAs(readerId, sharedPageId)).rejects.toBeInstanceOf(AuthorizationError);
    const attachmentId = await fileOf(sharedPageId);
    await expect(
      attachments.delete({ attachmentId, userId: readerId, correlationId }),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });
});
