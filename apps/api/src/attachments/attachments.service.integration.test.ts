import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AuthorizationError, WorkspaceAccessService } from '@exocortex/auth';
import { loadDotEnv } from '@exocortex/config';
import { QUEUE_NAMES } from '@exocortex/contracts';
import { createPrismaClient, type PrismaClient } from '@exocortex/database';
import { createLogger, type Logger } from '@exocortex/logger';
import { QueueRegistry, testQueuePrefix } from '@exocortex/queue';

import { OutboxService } from '../common/outbox.service';

import { AttachmentsService } from './attachments.service';

/**
 * The text-reading and text-writing half of `AttachmentsService` (issue #2),
 * against the real database and Redis. Upload and download are covered by
 * `e2e/tests/attachments.spec.ts`; the storage-facing half of the service is
 * never exercised here, so it is stubbed out entirely.
 */
loadDotEnv();

const logger: Logger = createLogger({ name: 'api-test', level: 'silent' });

let prisma: PrismaClient;
let queues: QueueRegistry;
let service: AttachmentsService;
let workspaceId: string;
let memberId: string;
let guestId: string;

async function createPdfAttachment(
  data: Partial<{
    textStatus: 'NOT_APPLICABLE' | 'PENDING' | 'READY' | 'FAILED';
    extractedText: string | null;
    correctedText: string | null;
    textCorrectedAt: Date | null;
    textCorrectedById: string | null;
    textTruncated: boolean;
  }> = {},
): Promise<string> {
  const attachment = await prisma.attachment.create({
    data: {
      workspaceId,
      filename: 'bericht.pdf',
      mimeType: 'application/pdf',
      byteSize: 1024,
      storageKey: `test/attachments-service-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
      createdById: memberId,
      textStatus: data.textStatus ?? 'READY',
      extractedText: data.extractedText ?? 'was die Maschine gelesen hat',
      textExtractedAt: new Date(),
      correctedText: data.correctedText ?? null,
      textCorrectedAt: data.textCorrectedAt ?? null,
      textCorrectedById: data.textCorrectedById ?? null,
      textTruncated: data.textTruncated ?? false,
    },
  });
  return attachment.id;
}

beforeAll(async () => {
  prisma = createPrismaClient({ databaseUrl: process.env.DATABASE_URL });
  queues = new QueueRegistry({
    redisUrl: process.env.REDIS_URL ?? 'redis://127.0.0.1:6380',
    logger,
    prefix: testQueuePrefix('api-attachments'),
  });
  const access = new WorkspaceAccessService(prisma);
  const outbox = new OutboxService(prisma, logger);
  service = new AttachmentsService(
    prisma,
    // Storage and settings are never touched by the text read/write paths
    // under test here; only upload/download reach them.
    {} as unknown as ConstructorParameters<typeof AttachmentsService>[1],
    {} as unknown as ConstructorParameters<typeof AttachmentsService>[2],
    logger,
    queues,
    access,
    outbox,
    {} as unknown as ConstructorParameters<typeof AttachmentsService>[7],
  );

  const suffix = Date.now().toString(36);
  const [member, guest] = await Promise.all([
    prisma.user.create({
      data: {
        email: `attach-member-${suffix}@exocortex.test`,
        name: 'Member',
        emailVerified: true,
      },
    }),
    prisma.user.create({
      data: { email: `attach-guest-${suffix}@exocortex.test`, name: 'Guest', emailVerified: true },
    }),
  ]);
  memberId = member.id;
  guestId = guest.id;

  const workspace = await prisma.workspace.create({
    data: {
      name: `Attachments ${suffix}`,
      slug: `attachments-${suffix}`,
      members: {
        create: [
          { userId: memberId, role: 'MEMBER' },
          { userId: guestId, role: 'GUEST' },
        ],
      },
    },
  });
  workspaceId = workspace.id;
});

afterAll(async () => {
  await prisma.workspace.delete({ where: { id: workspaceId } });
  await prisma.user.deleteMany({ where: { id: { in: [memberId, guestId] } } });
  await queues.obliterateAll();
  await queues.close();
  await prisma.$disconnect();
});

describe('reading extracted text', () => {
  it('reports the machine text when nobody has corrected it', async () => {
    const attachmentId = await createPdfAttachment();
    const info = await service.getTextInfo(attachmentId, memberId);
    expect(info.status).toBe('ready');
    expect(info.correction).toBeNull();
    expect(info.truncated).toBe(false);

    const full = await service.getText(attachmentId, memberId, 'test-correlation');
    expect(full.text).toBe('was die Maschine gelesen hat');
    expect(full.machineText).toBe('was die Maschine gelesen hat');
  });

  it('surfaces the truncation flag', async () => {
    const attachmentId = await createPdfAttachment({ textTruncated: true });
    const info = await service.getTextInfo(attachmentId, memberId);
    expect(info.truncated).toBe(true);
  });
});

describe('correcting extracted text', () => {
  it('lets a member correct the text, and the correction wins over the machine result', async () => {
    const attachmentId = await createPdfAttachment();

    const corrected = await service.correctText(
      attachmentId,
      memberId,
      'die von Hand korrigierte Fassung',
      'test-correlation',
    );
    expect(corrected.text).toBe('die von Hand korrigierte Fassung');
    expect(corrected.machineText).toBe('was die Maschine gelesen hat');
    expect(corrected.correction?.editedById).toBe(memberId);

    // The same fact, read back fresh: the correction, not the machine result,
    // is what `exo_attachment_read_text` and the UI both see as "the text".
    const reread = await service.getText(attachmentId, memberId, 'test-correlation');
    expect(reread.text).toBe('die von Hand korrigierte Fassung');
    expect(reread.correction).not.toBeNull();
  });

  it('clears a correction with text: null, reverting to the machine result', async () => {
    const attachmentId = await createPdfAttachment({
      correctedText: 'eine alte Korrektur',
      textCorrectedAt: new Date(),
      textCorrectedById: memberId,
    });

    const cleared = await service.correctText(attachmentId, memberId, null, 'test-correlation');
    expect(cleared.text).toBe('was die Maschine gelesen hat');
    expect(cleared.correction).toBeNull();
  });

  it('denies a guest the right to correct text', async () => {
    const attachmentId = await createPdfAttachment();
    await expect(
      service.correctText(attachmentId, guestId, 'versucht', 'test-correlation'),
    ).rejects.toThrow(AuthorizationError);
  });

  it('refuses to correct text on an attachment no engine can read', async () => {
    const attachment = await prisma.attachment.create({
      data: {
        workspaceId,
        filename: 'bild.png',
        mimeType: 'image/png',
        byteSize: 10,
        storageKey: `test/attachments-service-png-${Date.now().toString(36)}`,
        createdById: memberId,
      },
    });

    await expect(
      service.correctText(attachment.id, memberId, 'text', 'test-correlation'),
    ).rejects.toMatchObject({
      code: 'attachment_text_unavailable',
    });
  });
});

describe('forcing a re-extraction', () => {
  it('re-enqueues a ready attachment with reason "forced", bypassing the normal idempotency guard', async () => {
    const attachmentId = await createPdfAttachment();

    // The idempotent route leaves a ready attachment alone.
    const idempotent = await service.getText(attachmentId, memberId, 'test-correlation');
    expect(idempotent.status).toBe('ready');

    const forced = await service.forceReextract(attachmentId, memberId, 'test-correlation-force');
    expect(forced.status).toBe('pending');
    // The correction/machine text stay visible while the new attempt runs.
    expect(forced.text).toBe('was die Maschine gelesen hat');

    const queue = queues.getQueue(QUEUE_NAMES.attachmentText);
    const jobs = await queue.getJobs(['waiting', 'delayed', 'active', 'completed', 'failed']);
    const job = jobs.find((candidate) => candidate.data.attachmentId === attachmentId);
    expect(job?.data.reason).toBe('forced');
  });

  it('denies a guest the right to force a re-extraction', async () => {
    const attachmentId = await createPdfAttachment();
    await expect(service.forceReextract(attachmentId, guestId, 'test-correlation')).rejects.toThrow(
      AuthorizationError,
    );
  });

  it('reports attachment_text_unavailable for a non-PDF attachment', async () => {
    const attachment = await prisma.attachment.create({
      data: {
        workspaceId,
        filename: 'archiv.zip',
        mimeType: 'application/zip',
        byteSize: 10,
        storageKey: `test/attachments-service-zip-${Date.now().toString(36)}`,
        createdById: memberId,
      },
    });

    await expect(
      service.forceReextract(attachment.id, memberId, 'test-correlation'),
    ).rejects.toMatchObject({ code: 'attachment_text_unavailable' });
  });
});
