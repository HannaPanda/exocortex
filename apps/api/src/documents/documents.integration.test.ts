import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AuthorizationError, WorkspaceAccessService } from '@exocortex/auth';
import { loadDotEnv } from '@exocortex/config';
import { QUEUE_NAMES, resolveSettings, type Settings } from '@exocortex/contracts';
import { createPrismaClient, type PrismaClient } from '@exocortex/database';
import { type ProseMirrorDocument, serializePlainText } from '@exocortex/editor';
import { createLogger, type Logger } from '@exocortex/logger';
import { QueueRegistry } from '@exocortex/queue';

import { type AttachmentsService } from '../attachments/attachments.service';
import { AppError } from '../common/app-error';
import { OutboxService } from '../common/outbox.service';
import { type SettingsService } from '../platform/settings.service';
import { type RealtimeService } from '../realtime/realtime.service';

import {
  type ApplyToLiveSessionResult,
  type CollaborationBridgeService,
} from './collaboration-bridge.service';
import { DocumentContentService } from './document-content.service';
import { DocumentCoverService } from './document-cover.service';
import { DocumentsService } from './documents.service';

/**
 * Document domain tests against the real database.
 *
 * The service is constructed directly rather than through the Nest container: the
 * rules under test are hierarchy and authorization rules, and this keeps the test
 * free of HTTP and DI concerns. The HTTP surface is covered by
 * `e2e/tests/security.spec.ts`.
 */
loadDotEnv();

const logger: Logger = createLogger({ name: 'api-test', level: 'silent' });

let prisma: PrismaClient;
let queues: QueueRegistry;
let service: DocumentsService;
let contentService: DocumentContentService;
let workspaceId: string;
let otherWorkspaceId: string;
let ownerId: string;
let guestId: string;
let outsiderId: string;

/** Realtime delivery is best-effort, so a recording stub is enough here. */
const emitted: { type: string; workspaceId: string }[] = [];
const realtime = {
  emit: async (type: string, workspace: string) => {
    emitted.push({ type, workspaceId: workspace });
  },
} as unknown as RealtimeService;

/**
 * The collaboration server runs in its own process, so what is asserted here is
 * the API's half of the bridge: what it hands over, and what it does with the
 * answer. The applying itself is covered by
 * `apps/collaboration/src/collaboration.integration.test.ts`.
 */
const liveApplications: { documentId: string; mode: string; plainText: string }[] = [];
let liveResult: ApplyToLiveSessionResult = {
  applied: false,
  clientsCount: 0,
  yjsUpdatedAt: null,
  reachable: true,
};
const collaboration = {
  applyToLiveSession: async (input: {
    documentId: string;
    mode: string;
    proseMirrorJson: ProseMirrorDocument;
  }) => {
    liveApplications.push({
      documentId: input.documentId,
      mode: input.mode,
      plainText: serializePlainText(input.proseMirrorJson),
    });
    return liveResult;
  },
} as unknown as CollaborationBridgeService;

const correlationId = 'test-correlation';

beforeAll(async () => {
  prisma = createPrismaClient({ databaseUrl: process.env.DATABASE_URL });
  queues = new QueueRegistry({
    redisUrl: process.env.REDIS_URL ?? 'redis://127.0.0.1:6380',
    logger,
  });
  const access = new WorkspaceAccessService(prisma);
  const outbox = new OutboxService(prisma, logger);
  service = new DocumentsService(prisma, queues, logger, access, outbox, realtime);
  contentService = new DocumentContentService(
    prisma,
    queues,
    logger,
    access,
    outbox,
    realtime,
    collaboration,
  );

  const suffix = Date.now().toString(36);
  const [owner, guest, outsider] = await Promise.all([
    prisma.user.create({
      data: { email: `owner-${suffix}@exocortex.test`, name: 'Owner', emailVerified: true },
    }),
    prisma.user.create({
      data: { email: `guest-${suffix}@exocortex.test`, name: 'Guest', emailVerified: true },
    }),
    prisma.user.create({
      data: { email: `out-${suffix}@exocortex.test`, name: 'Outsider', emailVerified: true },
    }),
  ]);
  ownerId = owner.id;
  guestId = guest.id;
  outsiderId = outsider.id;

  const workspace = await prisma.workspace.create({
    data: {
      name: `Docs ${suffix}`,
      slug: `docs-${suffix}`,
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
      name: `Other ${suffix}`,
      slug: `other-${suffix}`,
      members: { create: { userId: ownerId, role: 'OWNER' } },
    },
  });
  otherWorkspaceId = other.id;
});

afterAll(async () => {
  await prisma.workspace.deleteMany({ where: { id: { in: [workspaceId, otherWorkspaceId] } } });
  await prisma.user.deleteMany({ where: { id: { in: [ownerId, guestId, outsiderId] } } });
  await queues.close();
  await prisma.$disconnect();
});

async function createPage(title: string, parentId: string | null = null): Promise<string> {
  const document = await service.create({
    workspaceId,
    userId: ownerId,
    request: { title, type: 'PAGE', parentId },
    correlationId,
  });
  return document.id;
}

describe('document creation', () => {
  it('creates a page with content and emits an event', async () => {
    emitted.length = 0;
    const documentId = await createPage('Erste Seite');

    const content = await prisma.documentContent.findUnique({ where: { documentId } });
    // Every document owns canonical Yjs state from the start.
    expect(content).not.toBeNull();
    expect(content?.yjsState.byteLength).toBeGreaterThan(0);
    expect(emitted.some((event) => event.type === 'document.created')).toBe(true);
  });

  it('nests pages arbitrarily deep', async () => {
    const level1 = await createPage('Ebene 1');
    const level2 = await createPage('Ebene 2', level1);
    const level3 = await createPage('Ebene 3', level2);

    const detail = await service.getDetail(level3, ownerId);
    expect(detail.breadcrumb.map((entry) => entry.id)).toEqual([level1, level2]);
  });

  it('orders siblings without renumbering when inserting between them', async () => {
    const parent = await createPage('Sortierung');
    const first = await createPage('A', parent);
    const last = await createPage('B', parent);

    const before = await prisma.document.findMany({
      where: { parentId: parent },
      select: { id: true, orderKey: true },
      orderBy: { orderKey: 'asc' },
    });

    const middle = await service.create({
      workspaceId,
      userId: ownerId,
      request: { title: 'Mitte', type: 'PAGE', parentId: parent, afterSiblingId: first },
      correlationId,
    });

    const after = await prisma.document.findMany({
      where: { parentId: parent },
      select: { id: true, orderKey: true },
      orderBy: { orderKey: 'asc' },
    });

    expect(after.map((row) => row.id)).toEqual([first, middle.id, last]);
    // The existing rows keep their keys: no renumbering happened.
    for (const row of before) {
      const still = after.find((candidate) => candidate.id === row.id);
      expect(still?.orderKey).toBe(row.orderKey);
    }
  });

  it('rejects a parent from another workspace', async () => {
    const foreign = await service.create({
      workspaceId: otherWorkspaceId,
      userId: ownerId,
      request: { title: 'Fremd', type: 'PAGE', parentId: null },
      correlationId,
    });

    await expect(
      service.create({
        workspaceId,
        userId: ownerId,
        request: { title: 'Kind', type: 'PAGE', parentId: foreign.id },
        correlationId,
      }),
    ).rejects.toMatchObject({ code: 'document_cross_workspace' });
  });

  it('refuses creation for a guest', async () => {
    await expect(
      service.create({
        workspaceId,
        userId: guestId,
        request: { title: 'Von Gast', type: 'PAGE', parentId: null },
        correlationId,
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

  it('refuses creation for a non-member', async () => {
    await expect(
      service.create({
        workspaceId,
        userId: outsiderId,
        request: { title: 'Von Fremd', type: 'PAGE', parentId: null },
        correlationId,
      }),
    ).rejects.toMatchObject({ code: 'workspace_access_denied' });
  });
});

describe('page covers', () => {
  async function createAttachment(input: {
    workspace: string;
    mimeType: string;
    deleted?: boolean;
  }): Promise<string> {
    const attachment = await prisma.attachment.create({
      data: {
        workspaceId: input.workspace,
        filename: 'bild.png',
        mimeType: input.mimeType,
        byteSize: 3,
        storageKey: `test/${Math.random().toString(36).slice(2)}`,
        createdById: ownerId,
        ...(input.deleted === true ? { deletedAt: new Date() } : {}),
      },
    });
    return attachment.id;
  }

  it('sets an image of the same workspace and keeps the crop', async () => {
    const documentId = await createPage('Mit Titelbild');
    const attachmentId = await createAttachment({ workspace: workspaceId, mimeType: 'image/png' });

    const updated = await service.update({
      documentId,
      userId: ownerId,
      request: { coverAttachmentId: attachmentId, coverPosition: 12.5 },
      correlationId,
    });

    expect(updated.coverAttachmentId).toBe(attachmentId);
    expect(updated.coverPosition).toBe(12.5);
  });

  it('refuses an attachment from another workspace', async () => {
    const documentId = await createPage('Fremdes Bild');
    const attachmentId = await createAttachment({
      workspace: otherWorkspaceId,
      mimeType: 'image/png',
    });

    // Reported as "not found", not as "forbidden": the reference must not
    // confirm that another workspace's attachment exists.
    await expect(
      service.update({
        documentId,
        userId: ownerId,
        request: { coverAttachmentId: attachmentId },
        correlationId,
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('refuses a file that is not an image, and one that is already deleted', async () => {
    const documentId = await createPage('Kein Bild');
    const pdfId = await createAttachment({ workspace: workspaceId, mimeType: 'application/pdf' });
    const goneId = await createAttachment({
      workspace: workspaceId,
      mimeType: 'image/png',
      deleted: true,
    });

    await expect(
      service.update({
        documentId,
        userId: ownerId,
        request: { coverAttachmentId: pdfId },
        correlationId,
      }),
    ).rejects.toMatchObject({ code: 'validation_failed' });

    await expect(
      service.update({
        documentId,
        userId: ownerId,
        request: { coverAttachmentId: goneId },
        correlationId,
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('removes the cover without touching the crop', async () => {
    const documentId = await createPage('Bild wieder weg');
    const attachmentId = await createAttachment({ workspace: workspaceId, mimeType: 'image/webp' });
    await service.update({
      documentId,
      userId: ownerId,
      request: { coverAttachmentId: attachmentId, coverPosition: 80 },
      correlationId,
    });

    const updated = await service.update({
      documentId,
      userId: ownerId,
      request: { coverAttachmentId: null },
      correlationId,
    });

    expect(updated.coverAttachmentId).toBeNull();
    expect(updated.coverPosition).toBe(80);
  });
});

describe('generating a cover', () => {
  /**
   * Only `requestGeneration` is exercised here, and it touches neither
   * attachments nor the upload path — those belong to `uploadAndSet`, which the
   * browser suite covers end to end. The two collaborators it never calls are
   * therefore left empty rather than half-built.
   */
  function coverService(settings: Partial<Settings>): DocumentCoverService {
    const resolved = resolveSettings({ rows: [], env: {} }).settings;
    const settingsStub = {
      get: async (): Promise<Settings> => ({ ...resolved, ...settings }),
    } as unknown as SettingsService;

    return new DocumentCoverService(
      prisma,
      queues,
      new WorkspaceAccessService(prisma),
      {} as unknown as AttachmentsService,
      service,
      settingsStub,
    );
  }

  it('refuses when image generation is switched off', async () => {
    const documentId = await createPage('Kein KI-Bild');

    await expect(
      coverService({ 'ai.imageGenerationEnabled': false, 'ai.imageModelSlug': 'a/b' }).requestGeneration({
        documentId,
        userId: ownerId,
        prompt: 'Berge im Morgennebel',
        correlationId,
      }),
    ).rejects.toMatchObject({ code: 'ai_image_unavailable' });
  });

  it('refuses when no image model is configured, however the switch is set', async () => {
    const documentId = await createPage('Kein Bildmodell');

    await expect(
      coverService({ 'ai.imageGenerationEnabled': true, 'ai.imageModelSlug': null }).requestGeneration({
        documentId,
        userId: ownerId,
        prompt: 'Berge im Morgennebel',
        correlationId,
      }),
    ).rejects.toMatchObject({ code: 'ai_image_unavailable' });
  });

  it('refuses a caller who may not edit the page', async () => {
    const documentId = await createPage('Gast will malen lassen');

    await expect(
      coverService({ 'ai.imageGenerationEnabled': true, 'ai.imageModelSlug': 'a/b' }).requestGeneration({
        documentId,
        userId: guestId,
        prompt: 'Berge im Morgennebel',
        correlationId,
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

  it('queues the work and answers before the picture exists', async () => {
    const documentId = await createPage('Bild wird gemalt');

    const result = await coverService({
      'ai.imageGenerationEnabled': true,
      'ai.imageModelSlug': 'a/b',
    }).requestGeneration({
      documentId,
      userId: ownerId,
      prompt: 'Berge im Morgennebel',
      correlationId,
    });

    expect(result).toEqual({ status: 'pending', documentId });

    const queue = queues.getQueue(QUEUE_NAMES.documentCover);
    const jobs = await queue.getJobs(['waiting', 'delayed', 'active', 'completed', 'failed']);
    const job = jobs.find((entry) => entry.data.documentId === documentId);
    expect(job?.data.prompt).toBe('Berge im Morgennebel');
    expect(job?.data.userId).toBe(ownerId);
    // One attempt on purpose: a retry would be a second paid image.
    expect(job?.opts.attempts).toBe(1);
    await job?.remove();
  });
});

describe('document tree', () => {
  it('is not readable for a non-member', async () => {
    await expect(service.getTree(workspaceId, outsiderId)).rejects.toMatchObject({
      code: 'workspace_access_denied',
    });
  });

  it('is readable for a guest', async () => {
    const tree = await service.getTree(workspaceId, guestId);
    expect(Array.isArray(tree.nodes)).toBe(true);
  });

  it('reports read-only access for guests', async () => {
    const documentId = await createPage('Gast liest');
    const detail = await service.getDetail(documentId, guestId);
    expect(detail.access).toBe('read');
  });
});

describe('moving documents', () => {
  it('rejects moving a document into itself', async () => {
    const documentId = await createPage('Selbstbezug');
    await expect(
      service.move({ documentId, userId: ownerId, request: { parentId: documentId }, correlationId }),
    ).rejects.toMatchObject({ code: 'document_move_cycle' });
  });

  it('rejects moving a document into its own descendant', async () => {
    const parent = await createPage('Zyklus-Eltern');
    const child = await createPage('Zyklus-Kind', parent);
    const grandchild = await createPage('Zyklus-Enkel', child);

    await expect(
      service.move({
        documentId: parent,
        userId: ownerId,
        request: { parentId: grandchild },
        correlationId,
      }),
    ).rejects.toMatchObject({ code: 'document_move_cycle' });
  });

  it('moves to the workspace root and writes an audit entry', async () => {
    const parent = await createPage('Verschieben-Eltern');
    const child = await createPage('Verschieben-Kind', parent);

    const moved = await service.move({
      documentId: child,
      userId: ownerId,
      request: { parentId: null },
      correlationId,
    });
    expect(moved.parentId).toBeNull();

    const audit = await prisma.auditLog.findFirst({
      where: { workspaceId, action: 'document.moved', targetId: child },
    });
    expect(audit).not.toBeNull();
    // Audit metadata must never contain document content.
    expect(JSON.stringify(audit?.metadata)).not.toContain('Verschieben-Kind');
  });
});

describe('archiving and restoring', () => {
  it('archives the whole subtree', async () => {
    const parent = await createPage('Archiv-Eltern');
    const child = await createPage('Archiv-Kind', parent);
    const grandchild = await createPage('Archiv-Enkel', child);

    await service.archive({ documentId: parent, userId: ownerId, correlationId });

    const rows = await prisma.document.findMany({
      where: { id: { in: [parent, child, grandchild] } },
      select: { id: true, archivedAt: true },
    });
    expect(rows.every((row) => row.archivedAt !== null)).toBe(true);
  });

  it('refuses to edit an archived document', async () => {
    const documentId = await createPage('Archiviert');
    await service.archive({ documentId, userId: ownerId, correlationId });

    await expect(
      service.update({
        documentId,
        userId: ownerId,
        request: { title: 'Neuer Titel' },
        correlationId,
      }),
    ).rejects.toMatchObject({ code: 'document_archived' });
  });

  it('detaches a restored page from an archived parent', async () => {
    const parent = await createPage('Bleibt archiviert');
    const child = await createPage('Wird wiederhergestellt', parent);
    await service.archive({ documentId: parent, userId: ownerId, correlationId });

    const restored = await service.restore({ documentId: child, userId: ownerId, correlationId });
    expect(restored.archivedAt).toBeNull();
    // It must not hang under a still-archived parent.
    expect(restored.parentId).toBeNull();
  });

  it('refuses to restore a document that is not archived', async () => {
    const documentId = await createPage('Nicht archiviert');
    await expect(
      service.restore({ documentId, userId: ownerId, correlationId }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('writes an audit entry for archive and restore', async () => {
    const documentId = await createPage('Auditiert');
    await service.archive({ documentId, userId: ownerId, correlationId });
    await service.restore({ documentId, userId: ownerId, correlationId });

    const actions = await prisma.auditLog.findMany({
      where: { targetId: documentId },
      select: { action: true },
    });
    expect(actions.map((entry) => entry.action).sort()).toEqual([
      'document.archived',
      'document.restored',
    ]);
  });

  it('writes an outbox row for every state change', async () => {
    const documentId = await createPage('Outbox');
    await service.archive({ documentId, userId: ownerId, correlationId });

    const events = await prisma.outboxEvent.findMany({
      where: { workspaceId, correlationId },
      select: { type: true },
    });
    expect(events.map((event) => event.type)).toContain('document.archived');
  });
});

describe('error contract', () => {
  it('maps a missing document to a document-scoped error', async () => {
    await expect(service.getDetail('missing-document-id', ownerId)).rejects.toMatchObject({
      code: 'document_access_denied',
    });
  });

  it('reports a conflict when restoring twice', async () => {
    const documentId = await createPage('Konflikt');
    await service.archive({ documentId, userId: ownerId, correlationId });
    await service.restore({ documentId, userId: ownerId, correlationId });

    const error = await service
      .restore({ documentId, userId: ownerId, correlationId })
      .then(() => null)
      .catch((caught: unknown) => caught);
    expect(error instanceof AppError || error instanceof AuthorizationError).toBe(true);
    expect(error).toMatchObject({ code: 'conflict' });
  });
});

describe('writing document content', () => {
  it('replaces the content, changes the yjsState and creates a snapshot', async () => {
    const documentId = await createPage('Inhalt ersetzen');
    const before = await prisma.documentContent.findUniqueOrThrow({ where: { documentId } });

    const result = await contentService.write({
      documentId,
      userId: ownerId,
      request: { markdown: '# Neuer Inhalt\n\nEin Absatz.', mode: 'replace' },
      correlationId,
      source: 'api',
    });

    const after = await prisma.documentContent.findUniqueOrThrow({ where: { documentId } });
    expect(Buffer.from(after.yjsState).equals(Buffer.from(before.yjsState))).toBe(false);
    expect(after.plainText).toContain('Neuer Inhalt');

    const snapshot = await prisma.documentSnapshot.findUnique({
      where: { id: result.snapshotId },
    });
    expect(snapshot).not.toBeNull();
    expect(snapshot?.reason).toBe('API_WRITE');
    // The snapshot is the state *before* the write, i.e. the original content.
    expect(Buffer.from(snapshot?.yjsState ?? []).equals(Buffer.from(before.yjsState))).toBe(true);
  });

  it('rejects a stale expectedYjsUpdatedAt with a conflict', async () => {
    const documentId = await createPage('Konflikt beim Schreiben');
    const stale = new Date(0).toISOString();

    await expect(
      contentService.write({
        documentId,
        userId: ownerId,
        request: { markdown: 'Text', mode: 'replace', expectedYjsUpdatedAt: stale },
        correlationId,
        source: 'api',
      }),
    ).rejects.toMatchObject({ code: 'document_content_conflict' });
  });

  it('rejects a write from a GUEST', async () => {
    const documentId = await createPage('Gast darf nicht schreiben');

    await expect(
      contentService.write({
        documentId,
        userId: guestId,
        request: { markdown: 'Text', mode: 'replace' },
        correlationId,
        source: 'api',
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });
});

describe('reaching an open editing session', () => {
  it('hands the finished document over for a replace', async () => {
    const documentId = await createPage('Ersetzen live');
    liveApplications.length = 0;

    await contentService.write({
      documentId,
      userId: ownerId,
      request: { markdown: 'Alles neu.', mode: 'replace' },
      correlationId,
      source: 'ai',
    });

    expect(liveApplications).toEqual([
      { documentId, mode: 'replace', plainText: 'Alles neu.' },
    ]);
  });

  /**
   * The point of the mode travelling along: an append must insert, not rewrite,
   * or it would undo whatever the person in the session just typed.
   */
  it('hands over only the new nodes for an append', async () => {
    const documentId = await createPage('Anhängen live');
    await contentService.write({
      documentId,
      userId: ownerId,
      request: { markdown: 'Bestehender Text.', mode: 'replace' },
      correlationId,
      source: 'api',
    });
    liveApplications.length = 0;

    await contentService.write({
      documentId,
      userId: ownerId,
      request: { markdown: 'Angehängter Text.', mode: 'append' },
      correlationId,
      source: 'ai',
    });

    expect(liveApplications).toEqual([
      { documentId, mode: 'append', plainText: 'Angehängter Text.' },
    ]);
    // The database still receives the merged document, as before.
    const stored = await prisma.documentContent.findUniqueOrThrow({ where: { documentId } });
    expect(stored.plainText).toContain('Bestehender Text.');
    expect(stored.plainText).toContain('Angehängter Text.');
  });

  it('reports the timestamp the live session persisted, not its own', async () => {
    const documentId = await createPage('Zeitstempel aus der Sitzung');
    const fromSession = new Date(Date.now() + 5_000).toISOString();
    liveResult = { applied: true, clientsCount: 2, yjsUpdatedAt: fromSession, reachable: true };

    const result = await contentService.write({
      documentId,
      userId: ownerId,
      request: { markdown: 'Offen beim Schreiben.', mode: 'replace' },
      correlationId,
      source: 'ai',
    });

    // Sending anything else back as `expectedYjsUpdatedAt` would make the very
    // next write of the same caller fail with a phantom conflict.
    expect(result.yjsUpdatedAt).toBe(fromSession);
    expect(result.appliedToLiveSession).toBe(true);
    expect(result.warnings).toEqual([]);

    liveResult = { applied: false, clientsCount: 0, yjsUpdatedAt: null, reachable: true };
  });

  it('warns when the collaboration server could not be reached', async () => {
    const documentId = await createPage('Brücke unterbrochen');
    liveResult = { applied: false, clientsCount: 0, yjsUpdatedAt: null, reachable: false };

    const result = await contentService.write({
      documentId,
      userId: ownerId,
      request: { markdown: 'Trotzdem geschrieben.', mode: 'replace' },
      correlationId,
      source: 'ai',
    });

    // The write itself must still stand; only the live update was lost.
    const stored = await prisma.documentContent.findUniqueOrThrow({ where: { documentId } });
    expect(stored.plainText).toContain('Trotzdem geschrieben.');
    expect(result.appliedToLiveSession).toBe(false);
    expect(result.warnings.join(' ')).toContain('neu laden');

    liveResult = { applied: false, clientsCount: 0, yjsUpdatedAt: null, reachable: true };
  });
});
