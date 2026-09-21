import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AuthorizationError, WorkspaceAccessService } from '@exocortex/auth';
import { type ApiEnv, loadDotEnv } from '@exocortex/config';
import { QUEUE_NAMES, resolveSettings, type Settings } from '@exocortex/contracts';
import {
  createPrismaClient,
  type PrismaClient,
  type RelatedDocumentsPort,
  type RelatedResult,
  type SearchAdapter,
} from '@exocortex/database';
import {
  type ProseMirrorDocument,
  serializePlainText,
  yjsStateToProseMirrorJson,
} from '@exocortex/editor';
import { createLogger, type Logger } from '@exocortex/logger';
import { QueueRegistry, testQueuePrefix } from '@exocortex/queue';
import { type ObjectStorage } from '@exocortex/storage';

import { type AttachmentsService } from '../attachments/attachments.service';
import { AppError } from '../common/app-error';
import { OutboxService } from '../common/outbox.service';
import { type SettingsService } from '../platform/settings.service';
import { settingsStub } from '../platform/settings.test-support';
import { type RealtimeService } from '../realtime/realtime.service';

import {
  type ApplyToLiveSessionResult,
  type CollaborationBridgeService,
} from './collaboration-bridge.service';
import { DocumentContentService } from './document-content.service';
import { DocumentCoverService } from './document-cover.service';
import { DocumentEditService } from './document-edit.service';
import { DocumentFragmentService } from './document-fragment.service';
import { DocumentLinksService } from './document-links.service';
import { DocumentMarkdownService } from './document-markdown.service';
import { DocumentMoveService } from './document-move.service';
import { DocumentSectionExtractService } from './document-section-extract.service';
import { DocumentSnapshotService } from './document-snapshot.service';
import { DocumentTrashService } from './document-trash.service';
import { DocumentTreeService } from './document-tree.service';
import { DocumentWriteCommitService } from './document-write-commit.service';
import { DocumentsService } from './documents.service';
import { PageLinkIdentityService } from './page-link-identity.service';
import { RelatedDocumentsService } from './related-documents.service';

/** `DocumentContentService` reads one value from the environment: the origin
 * an image's address is judged against (issue #117). */
const CONTENT_TEST_ENV = { APP_URL: 'https://exocortex.test' } as unknown as ApiEnv;

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
let treeService: DocumentTreeService;
let trashService: DocumentTrashService;
let contentService: DocumentContentService;
let editService: DocumentEditService;
let extractService: DocumentSectionExtractService;
let snapshotService: DocumentSnapshotService;
let linksService: DocumentLinksService;
let markdownService: DocumentMarkdownService;
let fragmentService: DocumentFragmentService;
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

/**
 * Deleting a page removes the objects its attachments point at. MinIO is not
 * what these tests are about, so the keys are recorded instead of removed --
 * what matters here is that the service asks for exactly the right ones.
 */
const deletedObjectKeys: string[] = [];
const storage = {
  deleteObject: async ({ key }: { key: string }) => {
    deletedObjectKeys.push(key);
  },
} as unknown as ObjectStorage;

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
  treeService = new DocumentTreeService(prisma, access);
  trashService = new DocumentTrashService(
    prisma,
    queues,
    logger,
    storage,
    access,
    outbox,
    realtime,
  );
  service = new DocumentsService(
    prisma,
    queues,
    logger,
    storage,
    access,
    outbox,
    realtime,
    trashService,
    new DocumentMoveService(prisma, queues, logger, access, outbox, realtime),
  );
  linksService = new DocumentLinksService(prisma, access);
  fragmentService = new DocumentFragmentService(
    prisma,
    access,
    new PageLinkIdentityService(prisma),
  );
  markdownService = new DocumentMarkdownService(
    prisma,
    queues,
    logger,
    access,
    outbox,
    realtime,
    new PageLinkIdentityService(prisma),
    fragmentService,
  );
  contentService = new DocumentContentService(
    prisma,
    logger,
    CONTENT_TEST_ENV,
    access,
    new DocumentWriteCommitService(prisma, queues, logger, outbox, realtime, collaboration),
    new PageLinkIdentityService(prisma),
    settingsStub(),
  );
  editService = new DocumentEditService(
    prisma,
    logger,
    CONTENT_TEST_ENV,
    access,
    new DocumentWriteCommitService(prisma, queues, logger, outbox, realtime, collaboration),
    new PageLinkIdentityService(prisma),
    settingsStub(),
  );
  extractService = new DocumentSectionExtractService(
    prisma,
    logger,
    access,
    new DocumentWriteCommitService(prisma, queues, logger, outbox, realtime, collaboration),
    new PageLinkIdentityService(prisma),
    service,
  );
  snapshotService = new DocumentSnapshotService(
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

    const tree = await treeService.getTree(workspaceId, ownerId);
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

describe('importing Markdown with an icon (issue #37)', () => {
  it('keeps the icon the caller sent along with the content', async () => {
    // The regression: importing content and setting a symbol were two separate
    // paths, and the import one had no icon field. The page arrived complete,
    // the call reported success, and the symbol was gone without a word.
    const imported = await markdownService.import({
      workspaceId,
      userId: ownerId,
      request: { markdown: '# Test\n\nInhalt', icon: 'lucide:cpu', iconColor: 'purple' },
      correlationId,
    });

    expect(imported).toMatchObject({ icon: 'lucide:cpu', iconColor: 'purple' });
    const stored = await service.getDetail(imported.id, ownerId);
    expect(stored).toMatchObject({ icon: 'lucide:cpu', iconColor: 'purple' });
  });

  it('still reads the icon out of the frontmatter when the caller sends none', async () => {
    const imported = await markdownService.import({
      workspaceId,
      userId: ownerId,
      request: { markdown: '---\nicon: lucide:star\niconColor: blue\n---\n\n# Aus der Datei' },
      correlationId,
    });

    expect(imported).toMatchObject({ icon: 'lucide:star', iconColor: 'blue' });
  });

  it('lets the caller overrule the frontmatter, the way the title already does', async () => {
    const imported = await markdownService.import({
      workspaceId,
      userId: ownerId,
      request: {
        markdown: '---\nicon: lucide:star\niconColor: blue\n---\n\n# Aus der Datei',
        icon: 'lucide:cpu',
        iconColor: 'purple',
      },
      correlationId,
    });

    expect(imported).toMatchObject({ icon: 'lucide:cpu', iconColor: 'purple' });
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
      // Cover generation resolves against the page's workspace since issue #52.
      getForWorkspace: async (): Promise<Settings> => ({ ...resolved, ...settings }),
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
      coverService({
        'ai.imageGenerationEnabled': false,
        'ai.imageModelSlug': 'a/b',
      }).requestGeneration({
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
      coverService({
        'ai.imageGenerationEnabled': true,
        'ai.imageModelSlug': null,
      }).requestGeneration({
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
      coverService({
        'ai.imageGenerationEnabled': true,
        'ai.imageModelSlug': 'a/b',
      }).requestGeneration({
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
    await expect(treeService.getTree(workspaceId, outsiderId)).rejects.toMatchObject({
      code: 'workspace_access_denied',
    });
  });

  it('is readable for a guest', async () => {
    const tree = await treeService.getTree(workspaceId, guestId);
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
      service.move({
        documentId,
        userId: ownerId,
        request: { parentId: documentId },
        correlationId,
      }),
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
      where: {
        workspaceId: otherWorkspaceId,
        action: 'document.moved_workspace',
        targetId: documentId,
      },
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

describe('the trash as a view (issue #32)', () => {
  it('keeps the hierarchy and says what came along', async () => {
    const parent = await createPage('Papierkorb-Eltern');
    const child = await createPage('Papierkorb-Kind', parent);
    await createPage('Papierkorb-Enkel', child);

    await service.archive({ documentId: parent, userId: ownerId, correlationId });
    const trash = await trashService.getTrash(workspaceId, ownerId);

    const root = trash.entries.find((entry) => entry.id === parent);
    expect(root).toBeDefined();
    // The page somebody chose, and the two that had no say in it.
    expect(root?.reason).toBe('direct');
    expect(root?.descendantCount).toBe(2);
    expect(root?.children).toHaveLength(1);
    expect(root?.children[0]?.reason).toBe('cascade');
    expect(root?.children[0]?.children[0]?.reason).toBe('cascade');
    // A page that went along is never a root of the trash, or it would read
    // like a second thing somebody threw away.
    expect(trash.entries.some((entry) => entry.id === child)).toBe(false);
  });

  it('calls a page archived on its own direct, even under an archived parent', async () => {
    const parent = await createPage('Später archiviert');
    const child = await createPage('Zuerst archiviert', parent);

    await service.archive({ documentId: child, userId: ownerId, correlationId });
    await service.archive({ documentId: parent, userId: ownerId, correlationId });

    const trash = await trashService.getTrash(workspaceId, ownerId);
    const root = trash.entries.find((entry) => entry.id === parent);
    expect(root?.children[0]?.id).toBe(child);
    // Two operations, two timestamps: this one was chosen once.
    expect(root?.children[0]?.reason).toBe('direct');
  });
});

describe('deleting for good (issue #31)', () => {
  it('refuses to delete a page that is not archived', async () => {
    const documentId = await createPage('Noch aktiv');
    await expect(
      service.deletePermanently({ documentIds: [documentId], userId: ownerId, correlationId }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('refuses a member without the ADMIN role', async () => {
    const memberUser = await prisma.user.create({
      data: {
        email: `member-${Date.now().toString(36)}@exocortex.test`,
        name: 'Member',
        emailVerified: true,
      },
    });
    await prisma.workspaceMember.create({
      data: { workspaceId, userId: memberUser.id, role: 'MEMBER' },
    });

    const documentId = await createPage('Nur Admins');
    await service.archive({ documentId, userId: ownerId, correlationId });

    await expect(
      service.deletePermanently({
        documentIds: [documentId],
        userId: memberUser.id,
        correlationId,
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });

    await prisma.workspaceMember.deleteMany({ where: { userId: memberUser.id } });
    await prisma.user.delete({ where: { id: memberUser.id } });
  });

  it('takes the subtree, its content and its files, and says so beforehand', async () => {
    const parent = await createPage('Endgültig weg');
    const child = await createPage('Kind weg', parent);
    const attachment = await prisma.attachment.create({
      data: {
        workspaceId,
        documentId: child,
        filename: 'anhang.txt',
        mimeType: 'text/plain',
        byteSize: 3,
        storageKey: `test/trash-${Date.now().toString(36)}`,
        createdById: ownerId,
      },
    });
    await service.archive({ documentId: parent, userId: ownerId, correlationId });

    const [preview] = await service.previewDeletion({
      documentIds: [parent],
      userId: ownerId,
    });
    expect(preview?.descendantCount).toBe(1);
    expect(preview?.attachmentCount).toBe(1);
    // The page the caller named is the one the confirmation opens with.
    expect(preview?.documents[0]?.id).toBe(parent);

    deletedObjectKeys.length = 0;
    const result = await service.deletePermanently({
      documentIds: [parent],
      userId: ownerId,
      correlationId,
    });

    expect(result.deletedCount).toBe(2);
    expect(result.attachmentCount).toBe(1);
    expect(deletedObjectKeys).toContain(attachment.storageKey);
    expect(await prisma.document.count({ where: { id: { in: [parent, child] } } })).toBe(0);
    // Cascades, not a second sweep: content and search projection go with it.
    expect(await prisma.documentContent.count({ where: { documentId: parent } })).toBe(0);
    expect(await prisma.attachment.count({ where: { id: attachment.id } })).toBe(0);
  });

  it('turns references to a deleted page into unresolved ones', async () => {
    const target = await createPage('Zielseite für Verweise');
    const source = await createPage('Quellseite');
    await prisma.documentLink.create({
      data: {
        workspaceId,
        sourceDocumentId: source,
        targetDocumentId: target,
        targetTitle: 'Zielseite für Verweise',
        targetTitleKey: 'zielseite für verweise',
        kind: 'WIKI_MARK',
        context: 'Siehe [[Zielseite für Verweise]]',
      },
    });

    await service.archive({ documentId: target, userId: ownerId, correlationId });
    const [preview] = await service.previewDeletion({ documentIds: [target], userId: ownerId });
    expect(preview?.incomingLinkCount).toBe(1);

    const result = await service.deletePermanently({
      documentIds: [target],
      userId: ownerId,
      correlationId,
    });
    expect(result.unresolvedLinkCount).toBe(1);

    // The reference survives its target: the reader lands on "not found",
    // which is what it has become, rather than on nothing at all.
    const link = await prisma.documentLink.findFirst({ where: { sourceDocumentId: source } });
    expect(link).not.toBeNull();
    expect(link?.targetDocumentId).toBeNull();
    expect(link?.targetTitle).toBe('Zielseite für Verweise');
  });

  it('writes an audit entry that outlives the page', async () => {
    const documentId = await createPage('Auditiert und gelöscht');
    await service.archive({ documentId, userId: ownerId, correlationId });
    await service.deletePermanently({ documentIds: [documentId], userId: ownerId, correlationId });

    const entries = await prisma.auditLog.findMany({
      where: { targetId: documentId, action: 'document.deleted' },
      select: { metadata: true },
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.metadata).toMatchObject({ title: 'Auditiert und gelöscht' });
  });

  it('refuses a deletion that spans two workspaces', async () => {
    const here = await createPage('Hier');
    const there = await service.create({
      workspaceId: otherWorkspaceId,
      userId: ownerId,
      request: { title: 'Dort', type: 'PAGE', parentId: null },
      correlationId,
    });
    await service.archive({ documentId: here, userId: ownerId, correlationId });
    await service.archive({ documentId: there.id, userId: ownerId, correlationId });

    await expect(
      service.deletePermanently({
        documentIds: [here, there.id],
        userId: ownerId,
        correlationId,
      }),
    ).rejects.toMatchObject({ code: 'document_cross_workspace' });
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
      growth: 'guarded',
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

  /**
   * Agents open a page with its own title as a heading, because that is what a
   * Markdown file looks like everywhere else. Here the title is metadata and is
   * rendered above the page, so the heading would show it a second time.
   */
  describe('a heading that repeats the page title', () => {
    it('is left out of the content, and said so in a warning', async () => {
      const documentId = await createPage('Mein Plan');

      const result = await contentService.write({
        documentId,
        userId: ownerId,
        request: { markdown: '# Mein Plan\n\nEin Absatz.', mode: 'replace' },
        correlationId,
        source: 'api',
        growth: 'guarded',
      });

      const after = await prisma.documentContent.findUniqueOrThrow({ where: { documentId } });
      expect(after.plainText?.trim()).toBe('Ein Absatz.');
      expect(result.warnings.join(' ')).toContain('wiederholte den Seitentitel');
    });

    it('becomes the title when the page has none yet', async () => {
      const documentId = await createPage('Unbenannte Seite');

      await contentService.write({
        documentId,
        userId: ownerId,
        request: { markdown: '# Aus dem Text\n\nEin Absatz.', mode: 'replace' },
        correlationId,
        source: 'api',
        growth: 'guarded',
      });

      const document = await prisma.document.findUniqueOrThrow({ where: { id: documentId } });
      expect(document.title).toBe('Aus dem Text');
      const after = await prisma.documentContent.findUniqueOrThrow({ where: { documentId } });
      expect(after.plainText?.trim()).toBe('Ein Absatz.');
    });

    it('is kept when it is not the title, only something like it', async () => {
      const documentId = await createPage('Mein Plan');

      await contentService.write({
        documentId,
        userId: ownerId,
        request: { markdown: '# Mein Plan für 2026\n\nEin Absatz.', mode: 'replace' },
        correlationId,
        source: 'api',
        growth: 'guarded',
      });

      const after = await prisma.documentContent.findUniqueOrThrow({ where: { documentId } });
      expect(after.plainText).toContain('Mein Plan für 2026');
    });

    it('is kept when it belongs to content that was already there', async () => {
      const documentId = await createPage('Mein Plan');
      await contentService.write({
        documentId,
        userId: ownerId,
        request: { markdown: 'Erster Absatz.', mode: 'replace' },
        correlationId,
        source: 'api',
        growth: 'guarded',
      });

      await contentService.write({
        documentId,
        userId: ownerId,
        request: { markdown: '# Mein Plan\n\nZweiter Absatz.', mode: 'append' },
        correlationId,
        source: 'api',
        growth: 'guarded',
      });

      const after = await prisma.documentContent.findUniqueOrThrow({ where: { documentId } });
      expect(after.plainText).toContain('Mein Plan');
    });

    it('is left out of an imported file, whose title it became', async () => {
      const imported = await markdownService.import({
        workspaceId,
        userId: ownerId,
        request: { markdown: '# Aus der Datei\n\nEin Absatz.' },
        correlationId,
      });

      expect(imported.title).toBe('Aus der Datei');
      const content = await prisma.documentContent.findUniqueOrThrow({
        where: { documentId: imported.id },
      });
      expect(content.plainText?.trim()).toBe('Ein Absatz.');
    });
  });

  /**
   * The reference index and the comment anchors are derived by the
   * materialization job, and that job skips a document whose `materializedAt`
   * has caught up with its `yjsUpdatedAt`. A write that stamps both leaves the
   * page's references describing the text it used to hold, which is what
   * happened to 515 pages on this deployment before anyone noticed: nothing
   * fails, the index just quietly describes the past.
   */
  it('leaves materializedAt behind yjsUpdatedAt so the job still has work to do', async () => {
    const documentId = await createPage('Materialisierung nach dem Schreiben');
    await contentService.write({
      documentId,
      userId: ownerId,
      request: { markdown: 'Ein Absatz mit [[Irgendeinem Verweis]].', mode: 'replace' },
      correlationId,
      source: 'api',
      growth: 'guarded',
    });

    const after = await prisma.documentContent.findUniqueOrThrow({ where: { documentId } });
    expect(after.materializedAt === null || after.materializedAt < after.yjsUpdatedAt).toBe(true);
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
        growth: 'guarded',
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
        growth: 'guarded',
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });
});

describe('restoring a snapshot', () => {
  it('puts the content back as an edit, not as the bytes it came from', async () => {
    const documentId = await createPage('Wiederhergestellt');
    await contentService.write({
      documentId,
      userId: ownerId,
      request: { markdown: 'Fassung A.', mode: 'replace' },
      correlationId,
      source: 'api',
      growth: 'guarded',
    });
    const snapshot = await snapshotService.create({
      documentId,
      userId: ownerId,
      reason: 'manual',
    });
    await contentService.write({
      documentId,
      userId: ownerId,
      request: { markdown: 'Fassung B.', mode: 'replace' },
      correlationId,
      source: 'api',
      growth: 'guarded',
    });

    await snapshotService.restore({ snapshotId: snapshot.id, userId: ownerId, correlationId });

    const after = await prisma.documentContent.findUniqueOrThrow({ where: { documentId } });
    const stored = serializePlainText(yjsStateToProseMirrorJson(new Uint8Array(after.yjsState)));
    expect(stored).toContain('Fassung A.');
    expect(stored).not.toContain('Fassung B.');

    /*
     * The same text, arrived at by moving forwards: had the snapshot's bytes
     * been put back, the state would be that snapshot again and "Fassung B."
     * would be missing from it rather than deleted in it -- which is what lets
     * a copy that still holds B merge it back in and undo the restore.
     */
    const source = await prisma.documentSnapshot.findUniqueOrThrow({
      where: { id: snapshot.id },
      select: { yjsState: true },
    });
    expect(Buffer.from(after.yjsState).equals(Buffer.from(source.yjsState))).toBe(false);
    expect(after.yjsState.byteLength).toBeGreaterThan(source.yjsState.byteLength);
  });

  it('tells an open session what to show', async () => {
    const documentId = await createPage('Wiederhergestellt live');
    await contentService.write({
      documentId,
      userId: ownerId,
      request: { markdown: 'Fassung A.', mode: 'replace' },
      correlationId,
      source: 'api',
      growth: 'guarded',
    });
    const snapshot = await snapshotService.create({
      documentId,
      userId: ownerId,
      reason: 'manual',
    });
    await contentService.write({
      documentId,
      userId: ownerId,
      request: { markdown: 'Fassung B.', mode: 'replace' },
      correlationId,
      source: 'api',
      growth: 'guarded',
    });
    liveApplications.length = 0;

    await snapshotService.restore({ snapshotId: snapshot.id, userId: ownerId, correlationId });

    expect(liveApplications).toEqual([{ documentId, mode: 'replace', plainText: 'Fassung A.' }]);
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
      growth: 'guarded',
    });

    expect(liveApplications).toEqual([{ documentId, mode: 'replace', plainText: 'Alles neu.' }]);
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
      growth: 'guarded',
    });
    liveApplications.length = 0;

    await contentService.write({
      documentId,
      userId: ownerId,
      request: { markdown: 'Angehängter Text.', mode: 'append' },
      correlationId,
      source: 'ai',
      growth: 'guarded',
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
      growth: 'guarded',
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
      growth: 'guarded',
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

    const result = await treeService.resolveLink(workspaceId, ownerId, {
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

    const result = await treeService.resolveLink(workspaceId, ownerId, {
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

    const withoutArchived = await treeService.resolveLink(workspaceId, ownerId, {
      title,
      includeArchived: false,
      limit: 10,
    });
    expect(withoutArchived.matches.map((match) => match.id)).toEqual([activeId]);

    const withArchived = await treeService.resolveLink(workspaceId, ownerId, {
      title,
      includeArchived: true,
      limit: 10,
    });
    expect(withArchived.matches.map((match) => match.id)).toEqual([activeId, archivedId]);
    expect(
      withArchived.matches.find((match) => match.id === archivedId)?.archivedAt,
    ).not.toBeNull();
    expect(withArchived.matches.find((match) => match.id === activeId)?.archivedAt).toBeNull();
  });

  it('resolves two pages with the same title, each with its ancestor path root-first', async () => {
    const marker = Math.random().toString(36).slice(2);
    const title = `Doppelt ${marker}`;
    const parentTitle = `Elternseite ${marker}`;
    const parent = await createPage(parentTitle);
    const child = await createPage(title, parent);
    const rootSibling = await createPage(title);

    const result = await treeService.resolveLink(workspaceId, ownerId, {
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

    const result = await treeService.resolveLink(workspaceId, ownerId, {
      title,
      includeArchived: true,
      limit: 10,
    });

    expect(result.matches.map((match) => match.id)).toEqual([documentId]);
  });

  it('is not resolvable for a non-member', async () => {
    await expect(
      treeService.resolveLink(workspaceId, outsiderId, {
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

    const result = await treeService.resolveLink(workspaceId, ownerId, {
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

    const result = await treeService.resolveLink(workspaceId, ownerId, {
      documentId: 'doc-that-never-existed',
      title,
      includeArchived: true,
      limit: 10,
    });

    expect(result.resolvedBy).toBe('title');
    expect(result.matches.map((match) => match.id)).toEqual([documentId]);
  });

  it('reports an unresolved reference when neither the identity nor the title answers', async () => {
    const result = await treeService.resolveLink(workspaceId, ownerId, {
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

    const result = await treeService.resolveLink(workspaceId, ownerId, {
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

  /**
   * Pages that resemble the open one although nobody linked them (issue #33).
   *
   * The neighbour query itself is a database concern and is covered against
   * real vectors in `apps/worker`. What the service adds is what is asserted
   * here: authorization, and the two things it says about a neighbour that the
   * vector cannot know — where the page sits, and whether it is already linked.
   */
  describe('related documents', () => {
    /** Stands in for the vector half, so these tests need no embedding model. */
    function adapterReturning(
      documentIds: readonly string[],
    ): SearchAdapter & RelatedDocumentsPort {
      return {
        id: 'stub',
        search: async () => [],
        index: async () => {},
        remove: async () => {},
        healthCheck: async () => true,
        findRelated: async (): Promise<RelatedResult> => ({
          state: 'ready',
          hits: documentIds.map((documentId, position) => ({
            documentId,
            workspaceId,
            title: 'egal',
            icon: null,
            iconColor: null,
            type: 'PAGE' as const,
            snippet: 'Ein Auszug.',
            section: null,
            rank: 0.9 - position / 10,
            archivedAt: null,
            updatedAt: new Date().toISOString(),
          })),
        }),
      } satisfies SearchAdapter & RelatedDocumentsPort;
    }

    it('marks a neighbour that is already linked, and reports its path', async () => {
      const parent = await createPage('Projekte');
      const source = await createPage('Segeln');
      const linkedNeighbour = await service.create({
        workspaceId,
        userId: ownerId,
        request: { title: 'Törnbericht', type: 'PAGE', parentId: parent },
        correlationId,
      });
      const looseNeighbour = await createPage('Hafenhandbuch');
      await writeLink({
        sourceDocumentId: source,
        targetDocumentId: linkedNeighbour.id,
        targetTitle: 'Törnbericht',
        workspaceId,
      });

      const relatedService = new RelatedDocumentsService(
        prisma,
        adapterReturning([linkedNeighbour.id, looseNeighbour]),
        new WorkspaceAccessService(prisma),
      );
      const result = await relatedService.list(source, ownerId);

      expect(result.state).toBe('ready');
      expect(result.related.map((entry) => entry.document.id)).toEqual([
        linkedNeighbour.id,
        looseNeighbour,
      ]);
      expect(result.related[0]?.linked).toBe(true);
      expect(result.related[0]?.path.map((step) => step.title)).toEqual(['Projekte']);
      expect(result.related[1]?.linked).toBe(false);
    });

    it('counts a reference in the other direction as linked too', async () => {
      const source = await createPage('Zwiebelkuchen');
      const neighbour = await createPage('Federweißer');
      await writeLink({
        sourceDocumentId: neighbour,
        targetDocumentId: source,
        targetTitle: 'Zwiebelkuchen',
        workspaceId,
      });

      const relatedService = new RelatedDocumentsService(
        prisma,
        adapterReturning([neighbour]),
        new WorkspaceAccessService(prisma),
      );
      expect((await relatedService.list(source, ownerId)).related[0]?.linked).toBe(true);
    });

    it('refuses a page the caller may not read', async () => {
      const source = await createPage('Vertraulich');
      const relatedService = new RelatedDocumentsService(
        prisma,
        adapterReturning([]),
        new WorkspaceAccessService(prisma),
      );
      await expect(relatedService.list(source, outsiderId)).rejects.toBeInstanceOf(
        AuthorizationError,
      );
    });

    it('reports an engine that cannot compare vectors as disabled', async () => {
      const source = await createPage('Ohne Vektoren');
      const keywordOnly: SearchAdapter = {
        id: 'stub-keyword',
        search: async () => [],
        index: async () => {},
        remove: async () => {},
        healthCheck: async () => true,
      };

      const relatedService = new RelatedDocumentsService(
        prisma,
        keywordOnly,
        new WorkspaceAccessService(prisma),
      );
      const result = await relatedService.list(source, ownerId);
      expect(result.state).toBe('disabled');
      expect(result.related).toEqual([]);
    });
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

/**
 * Transclusion (issue #78, ADR-045).
 *
 * What is asserted here is the half that cannot be proven in the editor
 * package: that the fragment is read *as the caller*, that a dead block is
 * said out loud rather than papered over, and that an export makes the choice
 * between the reference and the text.
 */
describe('reading a fragment of a page', () => {
  /** A source page with two sections, written the way anything else writes one. */
  async function createSource(title: string): Promise<{ documentId: string; heading: string }> {
    const documentId = await createPage(title);
    await contentService.write({
      documentId,
      userId: ownerId,
      request: {
        markdown:
          '## Stand\n\nLäuft seit gestern.\n\nNächster Schritt: ausrollen.\n\n## Offen\n\nNichts.',
        mode: 'replace',
      },
      correlationId,
      source: 'api',
      growth: 'guarded',
    });
    const outline = await fragmentService.read(documentId, ownerId, { outline: true });
    const heading = outline.blocks.find((block) => block.preview === 'Stand');
    expect(heading).toBeDefined();
    return { documentId, heading: (heading as { blockId: string }).blockId };
  }

  it('answers with the whole page when no block is named', async () => {
    const { documentId } = await createSource('Quelle ganz');
    const fragment = await fragmentService.read(documentId, ownerId, { outline: false });

    expect(fragment.resolved).toBe(true);
    expect(fragment.blockId).toBeNull();
    expect(fragment.markdown).toContain('Läuft seit gestern.');
    expect(fragment.markdown).toContain('Nichts.');
    // The outline costs something, so it is only there when it was asked for.
    expect(fragment.blocks).toEqual([]);
  });

  it('gives a heading its section and stops at the next heading', async () => {
    const { documentId, heading } = await createSource('Quelle Abschnitt');
    const fragment = await fragmentService.read(documentId, ownerId, {
      blockId: heading,
      outline: false,
    });

    expect(fragment.resolved).toBe(true);
    expect(fragment.markdown).toContain('Nächster Schritt: ausrollen.');
    expect(fragment.markdown).not.toContain('Nichts.');
  });

  it('says a block is gone instead of showing a different one', async () => {
    const { documentId, heading } = await createSource('Quelle geändert');
    await contentService.write({
      documentId,
      userId: ownerId,
      request: { markdown: '## Ganz anders\n\nNeuer Text.', mode: 'replace' },
      correlationId,
      source: 'api',
      growth: 'guarded',
    });

    const fragment = await fragmentService.read(documentId, ownerId, {
      blockId: heading,
      outline: false,
    });
    expect(fragment.resolved).toBe(false);
    expect(fragment.markdown).toBe('');
    // The page itself is still there, and still named.
    expect(fragment.title).toBe('Quelle geändert');
  });

  it('refuses a source the caller may not read', async () => {
    const { documentId } = await createSource('Quelle fremd');
    await expect(
      fragmentService.read(documentId, outsiderId, { outline: false }),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

  it('reads a window of blocks when both ends are named', async () => {
    const { documentId } = await createSource('Quelle Fenster');
    const outline = await fragmentService.read(documentId, ownerId, { outline: true });
    const [first, second] = outline.blocks;

    const fragment = await fragmentService.read(documentId, ownerId, {
      blockId: (first as { blockId: string }).blockId,
      toBlockId: (second as { blockId: string }).blockId,
      outline: false,
    });

    expect(fragment.resolved).toBe(true);
    expect(fragment.markdown).toContain('Läuft seit gestern.');
    expect(fragment.markdown).not.toContain('Nichts.');
  });

  it('answers a page past the budget with its map and no text at all', async () => {
    // The failure this pins (issue #118): a page larger than the reader's
    // budget used to come back as its first N characters, which reads like a
    // beginning and sends an agent looking for the rest one call at a time.
    const documentId = await createPage('Quelle groß');
    const sections = Array.from(
      { length: 6 },
      (_, index) => `## Abschnitt ${index}\n\n${'Text. '.repeat(200)}`,
    ).join('\n\n');
    await contentService.write({
      documentId,
      userId: ownerId,
      request: { markdown: sections, mode: 'replace' },
      correlationId,
      source: 'api',
      growth: 'guarded',
    });

    const fragment = await fragmentService.read(documentId, ownerId, {
      outline: false,
      maxChars: 1_000,
    });

    expect(fragment.view).toBe('map');
    expect(fragment.markdown).toBe('');
    expect(fragment.chars).toBeGreaterThan(1_000);
    expect(fragment.map?.mode).toBe('sections');
    expect(fragment.map?.entries).toHaveLength(6);
    // Every entry carries the address to read it with, which is the whole
    // point of answering with a map.
    expect(fragment.map?.entries.every((entry) => entry.fromBlockId !== null)).toBe(true);

    // And that address resolves, so the map is navigation and not decoration.
    const first = fragment.map?.entries[0]?.fromBlockId as string;
    const section = await fragmentService.read(documentId, ownerId, {
      blockId: first,
      outline: false,
      maxChars: 10_000,
    });
    expect(section.view).toBe('content');
    expect(section.markdown).toContain('## Abschnitt 0');
    expect(section.markdown).not.toContain('## Abschnitt 1');
  });

  it('maps a flat part as block windows, because the recursion needs a floor', async () => {
    const documentId = await createPage('Quelle flach');
    const flat = Array.from({ length: 40 }, (_, index) => `Absatz ${index}. ${'x'.repeat(200)}`);
    await contentService.write({
      documentId,
      userId: ownerId,
      request: { markdown: flat.join('\n\n'), mode: 'replace' },
      correlationId,
      source: 'api',
      growth: 'guarded',
    });

    const fragment = await fragmentService.read(documentId, ownerId, {
      outline: false,
      maxChars: 1_000,
      maxEntries: 8,
    });

    expect(fragment.view).toBe('map');
    expect(fragment.map?.mode).toBe('ranges');
    expect(fragment.map?.entries.length).toBeLessThanOrEqual(8);

    const window = fragment.map?.entries[0];
    const part = await fragmentService.read(documentId, ownerId, {
      blockId: window?.fromBlockId as string,
      toBlockId: window?.toBlockId ?? undefined,
      outline: false,
      maxChars: 100_000,
    });
    expect(part.view).toBe('content');
    expect(part.markdown).toContain('Absatz 0.');
  });

  it('hands back the text of a block that cannot be divided, rather than a map of it', async () => {
    // A map whose only entry is its own subject would answer the next read
    // with itself, forever. One enormous block has no inside to offer, so the
    // content goes back and the caller's own cap cuts it.
    const documentId = await createPage('Quelle unteilbar');
    await contentService.write({
      documentId,
      userId: ownerId,
      request: { markdown: 'x'.repeat(5_000), mode: 'replace' },
      correlationId,
      source: 'api',
      growth: 'guarded',
    });

    const fragment = await fragmentService.read(documentId, ownerId, {
      outline: false,
      maxChars: 1_000,
    });

    expect(fragment.view).toBe('content');
    expect(fragment.markdown.length).toBeGreaterThan(1_000);
  });

  it('hands the whole page to a caller that named no budget', async () => {
    const { documentId } = await createSource('Quelle ohne Budget');
    const fragment = await fragmentService.read(documentId, ownerId, { outline: false });

    expect(fragment.view).toBe('content');
    expect(fragment.map).toBeNull();
    expect(fragment.markdown).toContain('Nichts.');
  });
});

describe('exporting a page that embeds another', () => {
  async function createEmbedding(sourceTitle: string): Promise<string> {
    const source = await createPage(sourceTitle);
    await contentService.write({
      documentId: source,
      userId: ownerId,
      request: { markdown: 'Der eine Satz, der überall stehen soll.', mode: 'replace' },
      correlationId,
      source: 'api',
      growth: 'guarded',
    });

    const embedding = await createPage(`Einbettung von ${sourceTitle}`);
    await contentService.write({
      documentId: embedding,
      userId: ownerId,
      request: { markdown: `Davor.\n\n:::transclusion ${sourceTitle}\n:::`, mode: 'replace' },
      correlationId,
      source: 'api',
      growth: 'guarded',
    });
    return embedding;
  }

  it('keeps the reference by default and never the text', async () => {
    const embedding = await createEmbedding('Stammdaten A');
    const exported = await markdownService.export(embedding, ownerId);

    expect(exported.view).toBe('content');
    expect(exported.markdown).toContain(':::transclusion Stammdaten A');
    expect(exported.markdown).not.toContain('Der eine Satz');
  });

  it('exports the map instead of the page when the caller named a budget', async () => {
    const documentId = await createPage('Export groß');
    await contentService.write({
      documentId,
      userId: ownerId,
      request: {
        markdown: `## Eins\n\n${'a'.repeat(900)}\n\n## Zwei\n\n${'b'.repeat(900)}`,
        mode: 'replace',
      },
      correlationId,
      source: 'api',
      growth: 'guarded',
    });

    const exported = await markdownService.export(documentId, ownerId, { maxChars: 500 });

    expect(exported.view).toBe('map');
    expect(exported.markdown).toBe('');
    expect(exported.map?.entries.map((entry) => entry.title)).toEqual(['Eins', 'Zwei']);
    // The page's own children still travel: they are the structure, and a map
    // of the body never says what hangs underneath the page.
    expect(exported.children).toEqual([]);
  });

  it('puts the source text in place when asked to', async () => {
    const embedding = await createEmbedding('Stammdaten B');
    const exported = await markdownService.export(embedding, ownerId, { transclusions: 'text' });

    expect(exported.markdown).toContain('Der eine Satz, der überall stehen soll.');
    expect(exported.markdown).not.toContain(':::transclusion');
  });

  it('does not put content into an export the caller may not read', async () => {
    const embedding = await createEmbedding('Stammdaten C');
    // The guest may read the embedding page, and the source is refused to
    // nobody here -- so the interesting case is the one where resolution fails
    // outright: the reference has to survive as a reference.
    await prisma.document.update({
      where: { id: embedding },
      data: { title: 'Einbettung mit toter Quelle' },
    });
    const source = await prisma.document.findFirstOrThrow({
      where: { workspaceId, title: 'Stammdaten C' },
    });
    await prisma.document.delete({ where: { id: source.id } });

    const exported = await markdownService.export(embedding, ownerId, { transclusions: 'text' });
    expect(exported.markdown).toContain(':::transclusion Stammdaten C');
  });

  it('refuses to embed the page into itself', async () => {
    const documentId = await createPage('Selbstbezug');
    await contentService.write({
      documentId,
      userId: ownerId,
      request: { markdown: 'Text.\n\n:::transclusion Selbstbezug\n:::', mode: 'replace' },
      correlationId,
      source: 'api',
      growth: 'guarded',
    });

    const exported = await markdownService.export(documentId, ownerId, { transclusions: 'text' });
    // The reference stays a reference rather than duplicating the page inside
    // itself, which is the one case one level of expansion does not cover.
    expect(exported.markdown).toContain(':::transclusion Selbstbezug');
  });
});

/**
 * The narrow writes (issue #111, ADR-055).
 *
 * The promise they make is not "the text changed" -- `exo_page_write` already
 * does that. It is "and nothing else did", which is what these check: the
 * identifiers of the blocks that were not addressed, and that an ambiguous
 * target writes nothing at all.
 */
describe('editing part of a page', () => {
  /** Block identifiers of a page's top-level blocks, in reading order. */
  async function blockIdsOf(documentId: string): Promise<string[]> {
    const fragment = await fragmentService.read(documentId, ownerId, { outline: true });
    return fragment.blocks.map((block) => block.blockId);
  }

  async function markdownOf(documentId: string): Promise<string> {
    const content = await prisma.documentContent.findUniqueOrThrow({ where: { documentId } });
    return content.markdown ?? '';
  }

  async function seed(markdown: string): Promise<{ documentId: string; blockIds: string[] }> {
    const documentId = await createPage(
      `Teilweise schreiben ${Math.random().toString(36).slice(2)}`,
    );
    await contentService.write({
      documentId,
      userId: ownerId,
      request: { markdown, mode: 'replace' },
      correlationId,
      source: 'api',
      growth: 'guarded',
    });
    return { documentId, blockIds: await blockIdsOf(documentId) };
  }

  it('replaces one block and leaves every other identifier standing', async () => {
    const { documentId, blockIds } = await seed('## Stand\n\nAlt.\n\nBleibt stehen.');

    const result = await editService.writeBlock({
      documentId,
      userId: ownerId,
      request: { blockId: blockIds[1] as string, markdown: 'Neu.', mode: 'replace' },
      correlationId,
      source: 'api',
    });

    const after = await markdownOf(documentId);
    expect(after).toContain('Neu.');
    expect(after).not.toContain('Alt.');
    expect(after).toContain('Bleibt stehen.');

    const ids = await blockIdsOf(documentId);
    expect([ids[0], ids[2]]).toEqual([blockIds[0], blockIds[2]]);
    expect(result.snapshotId).toBeTruthy();
    expect(result.blockIds).toHaveLength(1);
  });

  it('writes a section without rewriting the rest of the page', async () => {
    const { documentId, blockIds } = await seed('## Stand\n\nAlt.\n\n## Danach\n\nUnberührt.');

    await editService.writeSection({
      documentId,
      userId: ownerId,
      request: { heading: 'stand', markdown: 'Frisch.', mode: 'replace' },
      correlationId,
      source: 'api',
    });

    const after = await markdownOf(documentId);
    expect(after).toContain('## Stand');
    expect(after).toContain('Frisch.');
    expect(after).not.toContain('Alt.');
    expect(after).toContain('Unberührt.');

    const ids = await blockIdsOf(documentId);
    // The heading is the address, so it must be the same heading afterwards.
    expect(ids[0]).toBe(blockIds[0]);
  });

  it('patches a line and says how many it replaced', async () => {
    const { documentId } = await seed('Eine Zeile.\n\nEine andere Zeile.');

    const result = await editService.patch({
      documentId,
      userId: ownerId,
      request: { oldText: 'Eine Zeile.', newText: 'Korrigierte Zeile.', replaceAll: false },
      correlationId,
      source: 'api',
    });

    expect(result.replacements).toBe(1);
    expect(await markdownOf(documentId)).toContain('Korrigierte Zeile.');
  });

  it('writes nothing when the text occurs twice', async () => {
    const { documentId } = await seed('Doppelt.\n\nDoppelt.');
    const before = await markdownOf(documentId);

    const error = await editService
      .patch({
        documentId,
        userId: ownerId,
        request: { oldText: 'Doppelt.', newText: 'Einfach.', replaceAll: false },
        correlationId,
        source: 'api',
      })
      .then(() => null)
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: 'document_patch_not_unique' });
    expect(await markdownOf(documentId)).toBe(before);
  });

  it('refuses a block that is not on the page', async () => {
    const { documentId } = await seed('Nur ein Absatz.');

    const error = await editService
      .writeBlock({
        documentId,
        userId: ownerId,
        request: { blockId: 'nichtvorhanden', markdown: 'x', mode: 'replace' },
        correlationId,
        source: 'api',
      })
      .then(() => null)
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: 'document_block_not_found' });
  });

  it('refuses a stale expectedYjsUpdatedAt instead of overwriting', async () => {
    const { documentId, blockIds } = await seed('Absatz.');

    const error = await editService
      .writeBlock({
        documentId,
        userId: ownerId,
        request: {
          blockId: blockIds[0] as string,
          markdown: 'x',
          mode: 'replace',
          expectedYjsUpdatedAt: new Date(0).toISOString(),
        },
        correlationId,
        source: 'api',
      })
      .then(() => null)
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: 'document_content_conflict' });
  });

  it("warns about an image on somebody else's host (issue #117)", async () => {
    const { documentId, blockIds } = await seed('Absatz.');

    const result = await editService.writeBlock({
      documentId,
      userId: ownerId,
      request: {
        blockId: blockIds[0] as string,
        markdown: '![Schild](https://haushalt.example.de/schild.jpg)',
        mode: 'replace',
      },
      correlationId,
      source: 'api',
    });

    expect(result.warnings.join(' ')).toContain('fremden Server');
  });
});

/**
 * Moving a section onto its own page (issue #118).
 *
 * What is checked here is the pair: the new page holds exactly what left the
 * old one, and the old one keeps everything else -- the identifiers included,
 * because this is a narrow write like the three above it.
 */
describe('extracting a section', () => {
  async function blockIdsOf(documentId: string): Promise<string[]> {
    const fragment = await fragmentService.read(documentId, ownerId, { outline: true });
    return fragment.blocks.map((block) => block.blockId);
  }

  async function markdownOf(documentId: string): Promise<string> {
    const content = await prisma.documentContent.findUniqueOrThrow({ where: { documentId } });
    return content.markdown ?? '';
  }

  /**
   * The content of a page nobody has written to yet.
   *
   * A page created with content of its own has no Markdown column until
   * materialization runs, and that is a worker job. Reading it back from the
   * canonical state is what the browser and the export do anyway.
   */
  async function contentOf(documentId: string): Promise<string> {
    const fragment = await fragmentService.read(documentId, ownerId, { outline: false });
    return fragment.markdown;
  }

  async function seed(markdown: string): Promise<{ documentId: string; blockIds: string[] }> {
    const documentId = await createPage(`Auslagern ${Math.random().toString(36).slice(2)}`);
    await contentService.write({
      documentId,
      userId: ownerId,
      request: { markdown, mode: 'replace' },
      correlationId,
      source: 'api',
      growth: 'guarded',
    });
    return { documentId, blockIds: await blockIdsOf(documentId) };
  }

  const PAGE =
    '## Oben\n\nBleibt.\n\n## Tumorambulanz\n\nTermin am Montag.\n\n### Details\n\nRaum 3.\n\n## Unten\n\nAuch da.';

  it('moves a section to a new child page and leaves a link behind', async () => {
    const { documentId, blockIds } = await seed(PAGE);

    const result = await extractService.extract({
      documentId,
      userId: ownerId,
      request: { blockId: blockIds[2] as string, replacement: 'link' },
      correlationId,
      source: 'api',
    });

    expect(result.created).toBe(true);
    expect(result.document.title).toBe('Tumorambulanz');
    expect(result.document.parentId).toBe(documentId);
    expect(result.heading).toBe('Tumorambulanz');
    // The subsection travelled with it, the way a heading addresses one; the
    // heading itself stayed behind, so three blocks moved, not four.
    expect(result.movedBlocks).toBe(3);

    const moved = await contentOf(result.document.id);
    expect(moved).toContain('Termin am Montag.');
    expect(moved).toContain('### Details');
    // The heading became the page's title, so it does not stand on it twice.
    expect(moved).not.toContain('## Tumorambulanz');

    const after = await markdownOf(documentId);
    expect(after).toContain('## Tumorambulanz');
    expect(after).not.toContain('Termin am Montag.');
    // The block form of a page link, which is what a reader clicks.
    expect(after).toContain(':::page Tumorambulanz');
    expect(after).toContain('Bleibt.');
    expect(after).toContain('Auch da.');

    // A narrow write: everything outside the section keeps its address.
    const ids = await blockIdsOf(documentId);
    expect([ids[0], ids[1], ids[2]]).toEqual([blockIds[0], blockIds[1], blockIds[2]]);
  });

  it('embeds the new page where the section stood, when asked to', async () => {
    const { documentId, blockIds } = await seed(PAGE);

    const result = await extractService.extract({
      documentId,
      userId: ownerId,
      request: { blockId: blockIds[2] as string, replacement: 'transclusion' },
      correlationId,
      source: 'api',
    });

    const after = await markdownOf(documentId);
    expect(after).toContain(':::transclusion Tumorambulanz');
    // A reader of the source page sees the moved text again, from its new home.
    const shown = await fragmentService.read(result.document.id, ownerId, { outline: false });
    expect(shown.markdown).toContain('Termin am Montag.');
  });

  it('takes the heading too when nothing is to stand in its place', async () => {
    const { documentId, blockIds } = await seed(PAGE);

    await extractService.extract({
      documentId,
      userId: ownerId,
      request: { blockId: blockIds[2] as string, replacement: 'remove' },
      correlationId,
      source: 'api',
    });

    const after = await markdownOf(documentId);
    expect(after).not.toContain('Tumorambulanz');
    expect(after).toContain('## Oben');
    expect(after).toContain('## Unten');
  });

  it('moves a window of blocks that has no heading of its own', async () => {
    const { documentId, blockIds } = await seed('Eins.\n\nZwei.\n\nDrei.');

    const result = await extractService.extract({
      documentId,
      userId: ownerId,
      request: {
        blockId: blockIds[0] as string,
        toBlockId: blockIds[1] as string,
        title: 'Die ersten beiden',
        replacement: 'link',
      },
      correlationId,
      source: 'api',
    });

    expect(result.heading).toBeNull();
    expect(result.movedBlocks).toBe(2);
    expect(await contentOf(result.document.id)).toContain('Zwei.');

    const after = await markdownOf(documentId);
    expect(after).not.toContain('Eins.');
    expect(after).toContain('Drei.');
    expect(after).toContain(':::page Die ersten beiden');
  });

  it('appends to an existing page when one is named', async () => {
    const { documentId, blockIds } = await seed(PAGE);
    const targetId = await createPage('Sammelseite');
    await contentService.write({
      documentId: targetId,
      userId: ownerId,
      request: { markdown: 'Schon da.', mode: 'replace' },
      correlationId,
      source: 'api',
      growth: 'guarded',
    });

    const result = await extractService.extract({
      documentId,
      userId: ownerId,
      request: { blockId: blockIds[2] as string, targetDocumentId: targetId, replacement: 'link' },
      correlationId,
      source: 'api',
    });

    expect(result.created).toBe(false);
    expect(result.document.id).toBe(targetId);
    const target = await markdownOf(targetId);
    expect(target).toContain('Schon da.');
    expect(target).toContain('Termin am Montag.');
  });

  it('refuses to empty the page it was asked to divide', async () => {
    const { documentId, blockIds } = await seed('## Alles\n\nNur das hier.');

    const error = await extractService
      .extract({
        documentId,
        userId: ownerId,
        request: { blockId: blockIds[0] as string, replacement: 'remove' },
        correlationId,
        source: 'api',
      })
      .then(() => null)
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: 'validation_failed' });
    expect(await markdownOf(documentId)).toContain('Nur das hier.');
  });

  it('writes nothing when the address is gone', async () => {
    const { documentId } = await seed(PAGE);
    const before = await markdownOf(documentId);

    const error = await extractService
      .extract({
        documentId,
        userId: ownerId,
        request: { blockId: 'nichtvorhanden', replacement: 'link' },
        correlationId,
        source: 'api',
      })
      .then(() => null)
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: 'document_block_not_found' });
    expect(await markdownOf(documentId)).toBe(before);
  });

  it('refuses a stale expectedYjsUpdatedAt instead of dividing a page that moved', async () => {
    const { documentId, blockIds } = await seed(PAGE);

    const error = await extractService
      .extract({
        documentId,
        userId: ownerId,
        request: {
          blockId: blockIds[2] as string,
          replacement: 'link',
          expectedYjsUpdatedAt: new Date(0).toISOString(),
        },
        correlationId,
        source: 'api',
      })
      .then(() => null)
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: 'document_content_conflict' });
  });

  it('refuses a guest, the way every other write to this page does', async () => {
    const { documentId, blockIds } = await seed(PAGE);

    const error = await extractService
      .extract({
        documentId,
        userId: guestId,
        request: { blockId: blockIds[2] as string, replacement: 'link' },
        correlationId,
        source: 'api',
      })
      .then(() => null)
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: 'forbidden' });
  });
});

describe('how large an agent may let a page grow', () => {
  /*
   * Small limits rather than the real 15,000 and 50,000, because what is being
   * proved is the policy and its wiring, not the numbers -- and a stub that
   * answers with different numbers than the deployment defaults is also the
   * proof that the numbers really do come from the settings (ADR-023).
   */
  const limits = {
    'agents.largePageChars': 400,
    'agents.oversizedPageChars': 1_200,
  } as const;

  function guarded(): DocumentContentService {
    return new DocumentContentService(
      prisma,
      logger,
      CONTENT_TEST_ENV,
      new WorkspaceAccessService(prisma),
      new DocumentWriteCommitService(
        prisma,
        queues,
        logger,
        new OutboxService(prisma, logger),
        realtime,
        collaboration,
      ),
      new PageLinkIdentityService(prisma),
      settingsStub(limits),
    );
  }

  function narrow(): DocumentEditService {
    return new DocumentEditService(
      prisma,
      logger,
      CONTENT_TEST_ENV,
      new WorkspaceAccessService(prisma),
      new DocumentWriteCommitService(
        prisma,
        queues,
        logger,
        new OutboxService(prisma, logger),
        realtime,
        collaboration,
      ),
      new PageLinkIdentityService(prisma),
      settingsStub(limits),
    );
  }

  /** A page of `sections` sections, each about `chars` characters long. */
  async function seed(sections: number, chars: number): Promise<string> {
    const documentId = await createPage(`Wächst ${Math.random().toString(36).slice(2)}`);
    const markdown = Array.from(
      { length: sections },
      (_unused, index) => `## Abschnitt ${index + 1}\n\n${'wort '.repeat(chars / 5)}`,
    ).join('\n\n');
    await contentService.write({
      documentId,
      userId: ownerId,
      request: { markdown, mode: 'replace' },
      correlationId,
      source: 'api',
      // The seeding itself is not what is under test, and a `replace` that
      // creates the oversized page is exactly the operation the policy allows.
      growth: 'exempt',
    });
    return documentId;
  }

  it('says nothing about a page that is still small', async () => {
    const documentId = await seed(1, 50);

    const result = await guarded().write({
      documentId,
      userId: ownerId,
      request: { markdown: 'Noch ein Satz.', mode: 'append' },
      correlationId,
      source: 'api',
      growth: 'guarded',
    });

    expect(result.warnings.filter((warning) => warning.includes('Zeichen'))).toEqual([]);
  });

  it('lets an append onto a large page through, and names its biggest sections', async () => {
    const documentId = await seed(2, 250);

    const result = await guarded().write({
      documentId,
      userId: ownerId,
      request: { markdown: 'Noch ein Satz.', mode: 'append' },
      correlationId,
      source: 'api',
      growth: 'guarded',
    });

    const warning = result.warnings.find((entry) => entry.includes('Unterseite'));
    expect(warning).toBeDefined();
    expect(warning).toContain('Abschnitt 1');
    // Addressable, or the advice would be something nobody can act on.
    expect(warning).toMatch(/\^[a-z0-9]+/);
  });

  it('refuses an append that would make an oversized page bigger, and writes nothing', async () => {
    const documentId = await seed(4, 400);
    const before = await prisma.documentContent.findUniqueOrThrow({ where: { documentId } });

    const error = await guarded()
      .write({
        documentId,
        userId: ownerId,
        request: { markdown: 'Noch ein Satz.', mode: 'append' },
        correlationId,
        source: 'api',
        growth: 'guarded',
      })
      .then(() => null)
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: 'document_page_oversized' });
    expect((error as Error).message).toContain('exo_page_extract_section');
    const after = await prisma.documentContent.findUniqueOrThrow({ where: { documentId } });
    expect(after.yjsUpdatedAt).toEqual(before.yjsUpdatedAt);
  });

  it('still lets an oversized page be written smaller, or it could never be repaired', async () => {
    const documentId = await seed(4, 400);

    const result = await guarded().write({
      documentId,
      userId: ownerId,
      request: { markdown: '## Abschnitt 1\n\nKurz.', mode: 'replace' },
      correlationId,
      source: 'api',
      growth: 'guarded',
    });

    expect(result.snapshotId).toBeTruthy();
  });

  it('refuses the same append through the narrow write, which is the door beside it', async () => {
    const documentId = await seed(4, 400);

    const error = await narrow()
      .writeSection({
        documentId,
        userId: ownerId,
        request: { heading: 'Abschnitt 4', markdown: 'Noch ein Satz.', mode: 'append' },
        correlationId,
        source: 'api',
      })
      .then(() => null)
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: 'document_page_oversized' });
  });

  it('exempts the paths that record rather than decide, the memory among them', async () => {
    const documentId = await seed(4, 400);

    const result = await guarded().write({
      documentId,
      userId: ownerId,
      request: { markdown: 'Eine Sitzungsnotiz.', mode: 'append' },
      correlationId,
      source: 'ai',
      // What `memory.service.ts` passes. Without it the memory would stop
      // recording, and the SessionEnd hook fails silently, so nobody would see.
      growth: 'exempt',
    });

    expect(result.snapshotId).toBeTruthy();
  });
});
