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
    textPageStarts: number[];
    screening: 'CLEAN' | 'FLAGGED' | 'FAILED' | null;
    fetchedFromUrl: boolean;
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
      textPageStarts: data.textPageStarts ?? [],
      textTruncated: data.textTruncated ?? false,
      screening: data.screening ?? null,
      fetchedFromUrl: data.fetchedFromUrl ?? false,
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
    // Only a file put into a database cell reaches it (issue #245).
    {} as unknown as ConstructorParameters<typeof AttachmentsService>[8],
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

describe('reading a long text by its pages (issue #133, ADR-101)', () => {
  const pages = Array.from(
    { length: 6 },
    (_, index) => `Seite ${index + 1}\n\n${'w '.repeat(1_500)}\n`,
  );
  const text = pages.join('');
  const starts = pages.map((_, index) => pages.slice(0, index).join('').length);

  it('answers without a query as it always has', async () => {
    const attachmentId = await createPdfAttachment({ extractedText: text, textPageStarts: starts });
    const read = await service.getText(attachmentId, memberId, 'test-correlation');
    expect(read).toMatchObject({ view: 'content', text, machineText: text, pages: 6, range: null });
  });

  it('answers over the budget with the pages, and reads one of them', async () => {
    const attachmentId = await createPdfAttachment({ extractedText: text, textPageStarts: starts });
    const map = await service.getText(attachmentId, memberId, 'test-correlation', {
      maxChars: 5_000,
    });
    expect(map.view).toBe('map');
    expect(map.text).toBe('');
    expect(map.machineText).toBeNull();
    expect(map.map?.entries.map((entry) => entry.title)).toEqual(
      pages.map((_, i) => `Seite ${i + 1}`),
    );

    const page = await service.getText(attachmentId, memberId, 'test-correlation', {
      maxChars: 5_000,
      fromPage: 4,
    });
    expect(page).toMatchObject({ view: 'content', text: pages[3] });
    expect(page.range).toMatchObject({ fromPage: 4, toPage: 4 });
  });

  it('names the page a phrase stands on', async () => {
    const attachmentId = await createPdfAttachment({ extractedText: text, textPageStarts: starts });
    const found = await service.getText(attachmentId, memberId, 'test-correlation', {
      maxChars: 5_000,
      find: 'seite 5',
    });
    expect(found).toMatchObject({ view: 'matches', text: '', matchCount: 1 });
    expect(found.matches?.[0]?.page).toBe(5);
  });

  it('reads a correction without pages and refuses to pretend it has them', async () => {
    const attachmentId = await createPdfAttachment({
      extractedText: text,
      textPageStarts: starts,
      correctedText: text,
      textCorrectedAt: new Date(),
      textCorrectedById: memberId,
    });
    const read = await service.getText(attachmentId, memberId, 'test-correlation', {});
    expect(read.pages).toBeNull();
    await expect(
      service.getText(attachmentId, memberId, 'test-correlation', { maxChars: 5_000, fromPage: 2 }),
    ).rejects.toMatchObject({ code: 'attachment_text_range_invalid' });
  });
});

describe('whose own the text is (ADR-096)', () => {
  it('trusts a clean screening for the uploader alone', async () => {
    const attachmentId = await createPdfAttachment({ screening: 'CLEAN' });
    expect((await service.getText(attachmentId, memberId, 'test-correlation')).trust).toEqual({
      trusted: true,
      reason: 'own_screened',
    });
    expect((await service.getText(attachmentId, guestId, 'test-correlation')).trust.reason).toBe(
      'not_own',
    );
  });

  it('keeps an unscreened, a flagged and a fetched file foreign for its uploader', async () => {
    const reasonOf = async (data: Parameters<typeof createPdfAttachment>[0]) =>
      (await service.getTextInfo(await createPdfAttachment(data), memberId)).trust.reason;
    expect(await reasonOf({})).toBe('unscreened');
    expect(await reasonOf({ screening: 'FLAGGED' })).toBe('flagged');
    expect(await reasonOf({ screening: 'FAILED' })).toBe('screen_failed');
    expect(await reasonOf({ screening: 'CLEAN', fetchedFromUrl: true })).toBe('fetched');
  });

  it('forgets the screening when the text is corrected, and asks again', async () => {
    const attachmentId = await createPdfAttachment({ screening: 'CLEAN' });
    const corrected = await service.correctText(
      attachmentId,
      memberId,
      'eine neue Fassung',
      'test-correlation',
    );
    expect(corrected.trust.reason).toBe('unscreened');
    const row = await prisma.attachment.findUniqueOrThrow({ where: { id: attachmentId } });
    expect(row.screening).toBeNull();
    const jobs = await queues
      .getQueue(QUEUE_NAMES.attachmentText)
      .getJobs(['waiting', 'delayed', 'active', 'completed', 'failed']);
    expect(
      jobs.some((job) => job.data.attachmentId === attachmentId && job.data.reason === 'screen'),
    ).toBe(true);
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

/**
 * Importing a file from an address (issues #117, #212): who may make this
 * deployment fetch something, and what the fetched bytes have to be.
 *
 * The addresses below point at loopback on purpose. Were the access check not
 * the first thing that happens, the call would reach the address check and
 * fail with `web_address_refused` instead; an `AuthorizationError` therefore
 * proves nothing was fetched. Storage is stubbed out, and nothing here gets far
 * enough to need it.
 */
describe('importing a file from an address', () => {
  const request = {
    url: 'http://127.0.0.1:9/foto.png',
    documentId: null,
    filename: null,
    propertyId: null,
  };

  it('refuses a guest before anything is fetched', async () => {
    await expect(
      service.uploadFromUrl({ workspaceId, userId: guestId, request, correlationId: 'test' }),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

  it('refuses somebody outside the workspace before anything is fetched', async () => {
    const stranger = await prisma.user.create({
      data: {
        email: `attach-stranger-${Date.now().toString(36)}@exocortex.test`,
        name: 'Stranger',
        emailVerified: true,
      },
    });
    try {
      const error = await service
        .uploadFromUrl({ workspaceId, userId: stranger.id, request, correlationId: 'test' })
        .then(
          () => null,
          (caught: unknown) => caught,
        );
      expect(error).not.toBeNull();
      expect((error as { code?: string }).code).not.toBe('web_address_refused');
    } finally {
      await prisma.user.delete({ where: { id: stranger.id } });
    }
  });

  it('lets a member ask, and then refuses the private address itself', async () => {
    const before = await prisma.attachment.count({ where: { workspaceId } });
    await expect(
      service.uploadFromUrl({ workspaceId, userId: memberId, request, correlationId: 'test' }),
    ).rejects.toMatchObject({ code: 'web_address_refused' });
    expect(await prisma.attachment.count({ where: { workspaceId } })).toBe(before);
  });

  it('believes the bytes and not the type a server declared', async () => {
    // What a server answering `content-type: image/png` with a web page hands
    // `upload`: the declared type is the fetched one, the body is not a PNG.
    await expect(
      service.upload({
        workspaceId,
        userId: memberId,
        documentId: null,
        filename: 'foto.png',
        declaredMimeType: 'image/png',
        body: Buffer.from('<!doctype html><script>alert(1)</script>'),
        correlationId: 'test',
        fetchedFromUrl: true,
      }),
    ).rejects.toMatchObject({ code: 'unsupported_media_type' });
  });
});
