import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AuthorizationError, WorkspaceAccessService } from '@exocortex/auth';
import { loadDotEnv } from '@exocortex/config';
import { QUEUE_NAMES, resolveSettings, type Settings } from '@exocortex/contracts';
import { createPrismaClient, type PrismaClient } from '@exocortex/database';
import { type ProseMirrorDocument, serializePlainText } from '@exocortex/editor';
import { createLogger, type Logger } from '@exocortex/logger';
import { QueueRegistry, testQueuePrefix } from '@exocortex/queue';

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
import { DocumentLinksService } from './document-links.service';
import { DocumentsService } from './documents.service';
import { PageLinkIdentityService } from './page-link-identity.service';

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
let linksService: DocumentLinksService;
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
    prefix: testQueuePrefix('api-documents'),
  });
  const access = new WorkspaceAccessService(prisma);
  const outbox = new OutboxService(prisma, logger);
  service = new DocumentsService(prisma, queues, logger, access, outbox, realtime);
  linksService = new DocumentLinksService(prisma, access);
  contentService = new DocumentContentService(
    prisma,
    queues,
    logger,
    access,
    outbox,
    realtime,
    collaboration,
    new PageLinkIdentityService(prisma),
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
  await queues.obliterateAll();
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

describe('document detail metadata (issue #17)', () => {
  it('names who created and who last changed the page', async () => {
    const documentId = await createPage('Herkunft');
    await service.update({
      documentId,
      userId: ownerId,
      request: { title: 'Herkunft geändert' },
      correlationId,
    });

    const detail = await service.getDetail(documentId, ownerId);
    expect(detail.createdByName).toBe('Owner');
    expect(detail.updatedByName).toBe('Owner');
  });

  it('reports parentType null at the workspace root and PAGE under an ordinary page', async () => {
    const root = await createPage('Wurzel für parentType');
    const child = await createPage('Kind für parentType', root);

    expect((await service.getDetail(root, ownerId)).parentType).toBeNull();
    expect((await service.getDetail(child, ownerId)).parentType).toBe('PAGE');
  });

  it('reports parentType COLLECTION for a database row and rowCount for the database', async () => {
    const collection = await service.create({
      workspaceId,
      userId: ownerId,
      request: { title: 'Sammlung für rowCount', type: 'COLLECTION', parentId: null },
      correlationId,
    });
    const row = await service.create({
      workspaceId,
      userId: ownerId,
      request: { title: 'Zeile', type: 'PAGE', parentId: collection.id },
      correlationId,
    });

    const rowDetail = await service.getDetail(row.id, ownerId);
    expect(rowDetail.parentType).toBe('COLLECTION');
    expect(rowDetail.rowCount).toBeNull();

    const collectionDetail = await service.getDetail(collection.id, ownerId);
    expect(collectionDetail.rowCount).toBe(1);
  });

  it('does not count an archived row', async () => {
    const collection = await service.create({
      workspaceId,
      userId: ownerId,
      request: { title: 'Sammlung mit Papierkorb', type: 'COLLECTION', parentId: null },
      correlationId,
    });
    const row = await service.create({
      workspaceId,
      userId: ownerId,
      request: { title: 'Wird archiviert', type: 'PAGE', parentId: collection.id },
      correlationId,
    });
    await service.archive({ documentId: row.id, userId: ownerId, correlationId });

    expect((await service.getDetail(collection.id, ownerId)).rowCount).toBe(0);
  });

  it('answers rowCount null for a plain page', async () => {
    const documentId = await createPage('Gewöhnliche Seite ohne rowCount');
    expect((await service.getDetail(documentId, ownerId)).rowCount).toBeNull();
  });
});

describe('page icons', () => {
  it('keeps the drawn icon and its colour, and hands both back everywhere', async () => {
    const parentId = await createPage('Technik');
    const childId = await createPage('Server', parentId);

    await service.update({
      documentId: parentId,
      userId: ownerId,
      request: { icon: 'lucide:folder', iconColor: 'blue' },
      correlationId,
    });

    const detail = await service.getDetail(childId, ownerId);
    expect(detail.breadcrumb.at(-1)).toMatchObject({
      id: parentId,
      icon: 'lucide:folder',
      iconColor: 'blue',
    });

    const tree = await service.getTree(workspaceId, ownerId);
    const node = tree.nodes.find((entry) => entry.id === parentId);
    expect(node).toMatchObject({ icon: 'lucide:folder', iconColor: 'blue' });
  });

  it('clears the colour on its own, without touching the icon', async () => {
    const documentId = await createPage('Nur Farbe weg');
    await service.update({
      documentId,
      userId: ownerId,
      request: { icon: 'lucide:star', iconColor: 'red' },
      correlationId,
    });

    const updated = await service.update({
      documentId,
      userId: ownerId,
      request: { iconColor: null },
      correlationId,
    });

    expect(updated.icon).toBe('lucide:star');
    expect(updated.iconColor).toBeNull();
  });

  // The column is free text so the palette can grow without a migration. A value
  // that is not in it must read back as "no colour" rather than reach a client
  // that only knows the palette.
  it('reports a colour outside the palette as no colour', async () => {
    const documentId = await createPage('Alte Farbe');
    await prisma.document.update({
      where: { id: documentId },
      data: { icon: 'lucide:star', iconColor: 'chartreuse' },
    });

    const detail = await service.getDetail(documentId, ownerId);
    expect(detail.icon).toBe('lucide:star');
    expect(detail.iconColor).toBeNull();
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

describe('moving documents across workspaces', () => {
  it('moves the whole subtree, its search index rows and its attachments', async () => {
    const parent = await createPage('Fusion-Eltern');
    const child = await createPage('Fusion-Kind', parent);
    const grandchild = await createPage('Fusion-Enkel', child);

    const attachment = await prisma.attachment.create({
      data: {
        workspaceId,
        documentId: child,
        filename: 'anhang.png',
        mimeType: 'image/png',
        byteSize: 3,
        storageKey: `test/${Math.random().toString(36).slice(2)}`,
        createdById: ownerId,
      },
    });
    // The indexing worker is not running in this test; insert the row
    // directly so the move has something real to carry along.
    await prisma.documentSearchIndex.create({
      data: { documentId: grandchild, workspaceId, title: 'Fusion-Enkel', plainText: '' },
    });

    const moved = await service.move({
      documentId: parent,
      userId: ownerId,
      request: { parentId: null, workspaceId: otherWorkspaceId },
      correlationId,
    });
    expect(moved.workspaceId).toBe(otherWorkspaceId);

    const rows = await prisma.document.findMany({
      where: { id: { in: [parent, child, grandchild] } },
      select: { id: true, workspaceId: true, parentId: true },
    });
    expect(rows.every((row) => row.workspaceId === otherWorkspaceId)).toBe(true);
    // The subtree's internal shape survives the move untouched.
    expect(rows.find((row) => row.id === child)?.parentId).toBe(parent);
    expect(rows.find((row) => row.id === grandchild)?.parentId).toBe(child);

    const movedAttachment = await prisma.attachment.findUniqueOrThrow({
      where: { id: attachment.id },
    });
    expect(movedAttachment.workspaceId).toBe(otherWorkspaceId);

    const movedSearchIndex = await prisma.documentSearchIndex.findUniqueOrThrow({
      where: { documentId: grandchild },
    });
    expect(movedSearchIndex.workspaceId).toBe(otherWorkspaceId);

    // Move it back: proves the path works both ways and keeps later tests in
    // this file working against `workspaceId` as they expect.
    const movedBack = await service.move({
      documentId: parent,
      userId: ownerId,
      request: { parentId: null, workspaceId },
      correlationId,
    });
    expect(movedBack.workspaceId).toBe(workspaceId);
  });

  it('writes an audit entry into both the source and the target workspace', async () => {
    const documentId = await createPage('Fusion-Audit');

    await service.move({
      documentId,
      userId: ownerId,
      request: { parentId: null, workspaceId: otherWorkspaceId },
      correlationId,
    });

    const sourceAudit = await prisma.auditLog.findFirst({
      where: { workspaceId, action: 'document.moved_workspace', targetId: documentId },
    });
    const targetAudit = await prisma.auditLog.findFirst({
      where: { workspaceId: otherWorkspaceId, action: 'document.moved_workspace', targetId: documentId },
    });
    expect(sourceAudit).not.toBeNull();
    expect(targetAudit).not.toBeNull();
  });

  it('rejects a mover who is not a member of the target workspace', async () => {
    const suffix = Date.now().toString(36);
    const outsiderToTarget = await prisma.user.create({
      data: { email: `mover-${suffix}@exocortex.test`, name: 'Mover', emailVerified: true },
    });
    await prisma.workspaceMember.create({
      data: { workspaceId, userId: outsiderToTarget.id, role: 'MEMBER' },
    });
    const documentId = await createPage('Kein Zielzugriff');

    try {
      await expect(
        service.move({
          documentId,
          userId: outsiderToTarget.id,
          request: { parentId: null, workspaceId: otherWorkspaceId },
          correlationId,
        }),
      ).rejects.toMatchObject({ code: 'workspace_access_denied' });
    } finally {
      await prisma.workspaceMember.deleteMany({ where: { userId: outsiderToTarget.id } });
      await prisma.user.delete({ where: { id: outsiderToTarget.id } });
    }
  });

  it('rejects a GUEST of the source workspace, even with a valid target', async () => {
    const documentId = await createPage('Gast-Verschieben');

    await expect(
      service.move({
        documentId,
        userId: guestId,
        request: { parentId: null, workspaceId: otherWorkspaceId },
        correlationId,
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

  it('rejects a target parent that does not belong to the target workspace', async () => {
    const documentId = await createPage('Falsches Ziel');
    const foreignParent = await createPage('Bleibt im Quellbereich');

    await expect(
      service.move({
        documentId,
        userId: ownerId,
        request: { parentId: foreignParent, workspaceId: otherWorkspaceId },
        correlationId,
      }),
    ).rejects.toMatchObject({ code: 'document_cross_workspace' });
  });

  it('keeps an AiRun pinned to the workspace it happened in, even after its page moves', async () => {
    const documentId = await createPage('Mit KI-Lauf');
    const run = await prisma.aiRun.create({
      data: {
        workspaceId,
        documentId,
        createdById: ownerId,
        provider: 'mock',
        model: 'mock',
        messages: [],
      },
    });

    await service.move({
      documentId,
      userId: ownerId,
      request: { parentId: null, workspaceId: otherWorkspaceId },
      correlationId,
    });

    const unchanged = await prisma.aiRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(unchanged.workspaceId).toBe(workspaceId);
    expect(unchanged.documentId).toBe(documentId);
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

describe('resolveLink', () => {
  it('finds an exact title match regardless of case and surrounding whitespace', async () => {
    const marker = Math.random().toString(36).slice(2);
    const title = `Ziel ${marker}`;
    const documentId = await createPage(title);

    const result = await service.resolveLink(workspaceId, ownerId, {
      title: `  ziel ${marker}  `,
      includeArchived: true,
      limit: 10,
    });

    expect(result.matches.map((match) => match.id)).toEqual([documentId]);
  });

  it('does not find a same-titled page in another workspace', async () => {
    const marker = Math.random().toString(36).slice(2);
    const title = `Nur hier ${marker}`;
    await service.create({
      workspaceId: otherWorkspaceId,
      userId: ownerId,
      request: { title, type: 'PAGE', parentId: null },
      correlationId,
    });

    const result = await service.resolveLink(workspaceId, ownerId, {
      title,
      includeArchived: true,
      limit: 10,
    });

    expect(result.matches).toEqual([]);
  });

  it('excludes an archived page unless asked for, then ranks it after active matches', async () => {
    const marker = Math.random().toString(36).slice(2);
    const title = `Zwilling ${marker}`;
    const activeId = await createPage(title);
    const archivedId = await createPage(title);
    await service.archive({ documentId: archivedId, userId: ownerId, correlationId });

    const withoutArchived = await service.resolveLink(workspaceId, ownerId, {
      title,
      includeArchived: false,
      limit: 10,
    });
    expect(withoutArchived.matches.map((match) => match.id)).toEqual([activeId]);

    const withArchived = await service.resolveLink(workspaceId, ownerId, {
      title,
      includeArchived: true,
      limit: 10,
    });
    expect(withArchived.matches.map((match) => match.id)).toEqual([activeId, archivedId]);
    expect(withArchived.matches.find((match) => match.id === archivedId)?.archivedAt).not.toBeNull();
    expect(withArchived.matches.find((match) => match.id === activeId)?.archivedAt).toBeNull();
  });

  it('resolves two pages with the same title, each with its ancestor path root-first', async () => {
    const marker = Math.random().toString(36).slice(2);
    const title = `Doppelt ${marker}`;
    const parentTitle = `Elternseite ${marker}`;
    const parent = await createPage(parentTitle);
    const child = await createPage(title, parent);
    const rootSibling = await createPage(title);

    const result = await service.resolveLink(workspaceId, ownerId, {
      title,
      includeArchived: true,
      limit: 10,
    });

    expect(result.matches).toHaveLength(2);
    const childMatch = result.matches.find((match) => match.id === child);
    const rootMatch = result.matches.find((match) => match.id === rootSibling);
    expect(childMatch?.path.map((entry) => entry.title)).toEqual([parentTitle]);
    expect(rootMatch?.path).toEqual([]);
  });

  it('treats % and _ in a title as literal characters, not as SQL wildcards', async () => {
    const marker = Math.random().toString(36).slice(2);
    const title = `100%_Plan ${marker}`;
    const documentId = await createPage(title);
    // Would also match the search below if `%` and `_` were treated as ILIKE
    // wildcards instead of literal characters — the reason resolveLink uses a
    // raw equality comparison rather than Prisma's `mode: 'insensitive'`.
    await createPage(`100XYQPlan ${marker}`);

    const result = await service.resolveLink(workspaceId, ownerId, {
      title,
      includeArchived: true,
      limit: 10,
    });

    expect(result.matches.map((match) => match.id)).toEqual([documentId]);
  });

  it('is not resolvable for a non-member', async () => {
    await expect(
      service.resolveLink(workspaceId, outsiderId, {
        title: 'Irrelevant',
        includeArchived: true,
        limit: 10,
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

  // Issue #14: a reference stores the identity of its target, and honouring it
  // is what makes renaming that target harmless.
  it('prefers the identity over the stored title, so a rename changes nothing', async () => {
    const marker = Math.random().toString(36).slice(2);
    const documentId = await createPage(`Alter Name ${marker}`);
    await service.update({
      documentId,
      userId: ownerId,
      request: { title: `Neuer Name ${marker}` },
      correlationId,
    });

    const result = await service.resolveLink(workspaceId, ownerId, {
      documentId,
      title: `Alter Name ${marker}`,
      includeArchived: true,
      limit: 10,
    });

    expect(result.resolvedBy).toBe('id');
    expect(result.matches.map((match) => match.id)).toEqual([documentId]);
    // The caller gets the title the page carries now, not the stale label.
    expect(result.title).toBe(`Neuer Name ${marker}`);
  });

  it('falls back to the title when the identity no longer names a document', async () => {
    const marker = Math.random().toString(36).slice(2);
    const title = `Neu geschrieben ${marker}`;
    const documentId = await createPage(title);

    const result = await service.resolveLink(workspaceId, ownerId, {
      documentId: 'doc-that-never-existed',
      title,
      includeArchived: true,
      limit: 10,
    });

    expect(result.resolvedBy).toBe('title');
    expect(result.matches.map((match) => match.id)).toEqual([documentId]);
  });

  it('reports an unresolved reference when neither the identity nor the title answers', async () => {
    const result = await service.resolveLink(workspaceId, ownerId, {
      documentId: 'doc-that-never-existed',
      title: `Gibt es nicht ${Math.random().toString(36).slice(2)}`,
      includeArchived: true,
      limit: 10,
    });

    expect(result).toMatchObject({ resolvedBy: 'none', matches: [] });
  });

  it('does not resolve an identity that belongs to another workspace', async () => {
    const marker = Math.random().toString(36).slice(2);
    const foreign = await service.create({
      workspaceId: otherWorkspaceId,
      userId: ownerId,
      request: { title: `Fremd ${marker}`, type: 'PAGE', parentId: null },
      correlationId,
    });

    const result = await service.resolveLink(workspaceId, ownerId, {
      documentId: foreign.id,
      title: `Fremd ${marker}`,
      includeArchived: true,
      limit: 10,
    });

    expect(result).toMatchObject({ resolvedBy: 'none', matches: [] });
  });
});

/**
 * Reading the reference index (issue #19).
 *
 * The rows are written by the worker; what this service adds is authorization
 * and the workspace boundary, so that is what is asserted here. A reference is
 * a fragment of another page's content, and it must never reach someone who
 * cannot read that page.
 */
describe('document links', () => {
  async function writeLink(input: {
    sourceDocumentId: string;
    targetDocumentId: string | null;
    targetTitle: string;
    workspaceId: string;
    context?: string;
  }): Promise<string> {
    const row = await prisma.documentLink.create({
      data: {
        workspaceId: input.workspaceId,
        sourceDocumentId: input.sourceDocumentId,
        targetDocumentId: input.targetDocumentId,
        targetTitle: input.targetTitle,
        targetTitleKey: input.targetTitle.toLowerCase(),
        kind: 'WIKI_MARK',
        blockId: null,
        context: input.context ?? `Ein Satz über ${input.targetTitle}.`,
        position: 0,
      },
    });
    return row.id;
  }

  it('reports both directions, with the sentence around the reference', async () => {
    const target = await createPage('Verweisziel');
    const source = await createPage('Verweisquelle');
    await writeLink({
      sourceDocumentId: source,
      targetDocumentId: target,
      targetTitle: 'Verweisziel',
      workspaceId,
      context: 'Der Betrieb steht in Verweisziel beschrieben.',
    });

    const incoming = await linksService.list(target, ownerId);
    expect(incoming.incoming).toHaveLength(1);
    expect(incoming.incoming[0]?.source.id).toBe(source);
    expect(incoming.incoming[0]?.context).toContain('Der Betrieb steht in');
    expect(incoming.outgoing).toHaveLength(0);

    const outgoing = await linksService.list(source, ownerId);
    expect(outgoing.outgoing).toHaveLength(1);
    expect(outgoing.outgoing[0]?.target?.id).toBe(target);
    expect(outgoing.incoming).toHaveLength(0);
  });

  it('keeps an unresolved reference visible instead of dropping it', async () => {
    const source = await createPage('Quelle mit totem Verweis');
    await writeLink({
      sourceDocumentId: source,
      targetDocumentId: null,
      targetTitle: 'Gibt es nicht',
      workspaceId,
    });

    const result = await linksService.list(source, ownerId);
    expect(result.outgoing).toHaveLength(1);
    expect(result.outgoing[0]?.target).toBeNull();
    expect(result.outgoing[0]?.targetTitle).toBe('Gibt es nicht');
  });

  it('reports that a page has not been indexed yet', async () => {
    const page = await createPage('Frisch angelegt');
    const result = await linksService.list(page, ownerId);
    expect(result.pending).toBe(true);

    await prisma.documentContent.update({
      where: { documentId: page },
      data: { linksIndexedAt: new Date() },
    });
    expect((await linksService.list(page, ownerId)).pending).toBe(false);
  });

  it('refuses a non-member', async () => {
    const page = await createPage('Nicht für Fremde');
    await expect(linksService.list(page, outsiderId)).rejects.toBeInstanceOf(AuthorizationError);
  });

  it('lets a guest read them, because a guest may read the pages they come from', async () => {
    const target = await createPage('Gastziel');
    const source = await createPage('Gastquelle');
    await writeLink({
      sourceDocumentId: source,
      targetDocumentId: target,
      targetTitle: 'Gastziel',
      workspaceId,
    });

    const result = await linksService.list(target, guestId);
    expect(result.incoming.map((link) => link.source.id)).toEqual([source]);
  });

  it('never shows a reference whose source lives in another workspace', async () => {
    const target = await createPage('Grenzziel');
    const foreignSource = await service.create({
      workspaceId: otherWorkspaceId,
      userId: ownerId,
      request: { title: 'Fremde Quelle', type: 'PAGE' },
      correlationId,
    });
    // The state a cross-workspace move leaves behind before the worker has
    // corrected the denormalized workspace of the row.
    await writeLink({
      sourceDocumentId: foreignSource.id,
      targetDocumentId: target,
      targetTitle: 'Grenzziel',
      workspaceId,
    });

    const result = await linksService.list(target, ownerId);
    expect(result.incoming).toHaveLength(0);
  });

  it('treats a target in another workspace as unresolved', async () => {
    const source = await createPage('Quelle mit Fernziel');
    const foreignTarget = await service.create({
      workspaceId: otherWorkspaceId,
      userId: ownerId,
      request: { title: 'Fernziel', type: 'PAGE' },
      correlationId,
    });
    await writeLink({
      sourceDocumentId: source,
      targetDocumentId: foreignTarget.id,
      targetTitle: 'Fernziel',
      workspaceId,
    });

    const result = await linksService.list(source, ownerId);
    expect(result.outgoing).toHaveLength(1);
    expect(result.outgoing[0]?.target).toBeNull();
  });
});

describe('renaming a page', () => {
  it('writes an outbox event so the reference index is re-resolved', async () => {
    const documentId = await createPage('Alter Titel');
    const before = await prisma.outboxEvent.count({
      where: { workspaceId, type: 'document.updated' },
    });

    await service.update({
      documentId,
      userId: ownerId,
      request: { title: 'Neuer Titel' },
      correlationId,
    });
    expect(
      await prisma.outboxEvent.count({ where: { workspaceId, type: 'document.updated' } }),
    ).toBe(before + 1);

    // Anything that is not a rename must not produce one: an event per icon
    // change would be a storm for nothing.
    await service.update({
      documentId,
      userId: ownerId,
      request: { icon: '🧠' },
      correlationId,
    });
    // Setting the same title again is not a rename either.
    await service.update({
      documentId,
      userId: ownerId,
      request: { title: 'Neuer Titel' },
      correlationId,
    });
    expect(
      await prisma.outboxEvent.count({ where: { workspaceId, type: 'document.updated' } }),
    ).toBe(before + 1);
  });

  it('writes exactly one document.renamed audit entry per actual rename (issue #20)', async () => {
    const documentId = await createPage('Vorher');

    await service.update({
      documentId,
      userId: ownerId,
      request: { title: 'Nachher' },
      correlationId,
    });
    // An icon-only change is not a rename and must not audit one either.
    await service.update({
      documentId,
      userId: ownerId,
      request: { icon: '🧠' },
      correlationId,
    });

    const entries = await prisma.auditLog.findMany({
      where: { targetType: 'document', targetId: documentId, action: 'document.renamed' },
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.actorId).toBe(ownerId);
    expect(entries[0]?.metadata).toMatchObject({ previousTitle: 'Vorher', nextTitle: 'Nachher' });
  });
});
