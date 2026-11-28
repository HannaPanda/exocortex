import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AuthorizationError, WorkspaceAccessService } from '@exocortex/auth';
import { loadDotEnv } from '@exocortex/config';
import { createPrismaClient, generateOrderKey, type PrismaClient } from '@exocortex/database';
import { createLogger, type Logger } from '@exocortex/logger';
import { QueueRegistry, testQueuePrefix } from '@exocortex/queue';
import { type ObjectStorage } from '@exocortex/storage';

import { OutboxService } from '../common/outbox.service';
import { DocumentMoveService } from '../documents/document-move.service';
import { DocumentTrashService } from '../documents/document-trash.service';
import { DocumentTreeService } from '../documents/document-tree.service';
import { DocumentsService } from '../documents/documents.service';
import { SettingsService } from '../platform/settings.service';
import { type RealtimeService } from '../realtime/realtime.service';

import { AiModelResolverService } from './ai-model-resolver.service';
import { ChatAttachmentsService } from './chat-attachments.service';
import { ConversationsService } from './conversations.service';

/**
 * The KI chat on a page somebody shared with the reader (issue #234,
 * ADR-092), against the real database.
 *
 * The chat runs in the reader's own workspace; the shared page is its open
 * page. Every tool call of the run reaches the API with a service token minted
 * for the reader and nothing else (no workspace claim for an ordinary chat), so
 * what a tool may do on the page is what `WorkspaceAccessService` lets the
 * reader do -- and the tests below call the same functions the tool routes
 * call. The ones that matter are the refusals: writing on a READ grant,
 * reaching a sub-page or a neighbour of a single shared page, reaching
 * anything else in the sharer's workspace, carrying on after the grant is
 * withdrawn, and a run being billed anywhere but in the reader's workspace.
 */
loadDotEnv();

const logger: Logger = createLogger({ name: 'api-test', level: 'silent' });
const correlationId = 'shared-page-chat';

const realtime = {
  emit: async () => undefined,
  revoke: async () => undefined,
} as unknown as RealtimeService;
const storage = {
  deleteObject: async () => undefined,
  getObject: async () => undefined,
} as unknown as ObjectStorage;

let prisma: PrismaClient;
let queues: QueueRegistry;
let access: WorkspaceAccessService;
let conversations: ConversationsService;
let documents: DocumentsService;
let tree: DocumentTreeService;

let sharerId: string;
let readerId: string;
let memberId: string;
let sharerWorkspaceId: string;
let readerWorkspaceId: string;
let memberWorkspaceId: string;
let sectionId: string;
let sharedId: string;
let childId: string;
let siblingId: string;
let collectionId: string;
let shareId: string;

async function createPage(
  title: string,
  parentId: string | null,
  type: 'PAGE' | 'COLLECTION' = 'PAGE',
): Promise<string> {
  const document = await prisma.document.create({
    data: {
      workspaceId: sharerWorkspaceId,
      parentId,
      type,
      title,
      orderKey: generateOrderKey(null, null),
      createdById: sharerId,
      updatedById: sharerId,
    },
  });
  return document.id;
}

async function setGrant(data: {
  permission?: 'READ' | 'WRITE';
  scope?: 'PAGE_ONLY' | 'SUBTREE';
  revoked?: boolean;
}): Promise<void> {
  await prisma.documentShare.update({
    where: { id: shareId },
    data: {
      permission: data.permission ?? 'READ',
      scope: data.scope ?? 'PAGE_ONLY',
      revokedAt: data.revoked === true ? new Date() : null,
    },
  });
}

/** A rename: the smallest page write a tool can make, through the route's own service. */
function renameAsReader(documentId: string, title: string): Promise<unknown> {
  return documents.update({ documentId, userId: readerId, request: { title }, correlationId });
}

beforeAll(async () => {
  prisma = createPrismaClient({ databaseUrl: process.env.DATABASE_URL });
  queues = new QueueRegistry({
    redisUrl: process.env.REDIS_URL ?? 'redis://127.0.0.1:6380',
    logger,
    prefix: testQueuePrefix('api-shared-page-chat'),
  });
  access = new WorkspaceAccessService(prisma);
  const outbox = new OutboxService(prisma, logger);
  const settings = new SettingsService(prisma, logger, outbox);
  const modelResolver = new AiModelResolverService(
    prisma,
    process.env.OPENROUTER_DEFAULT_MODEL ?? 'anthropic/claude-sonnet-4.5',
    settings,
  );
  conversations = new ConversationsService(
    prisma,
    queues,
    logger,
    access,
    modelResolver,
    settings,
    new ChatAttachmentsService(
      prisma,
      // Nothing in this suite uploads a chat file or holds one in storage.
      {} as unknown as ConstructorParameters<typeof ChatAttachmentsService>[1],
      logger,
      access,
      {} as unknown as ConstructorParameters<typeof ChatAttachmentsService>[4],
      settings,
      {} as unknown as ConstructorParameters<typeof ChatAttachmentsService>[6],
    ),
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
  tree = new DocumentTreeService(prisma, access);

  const suffix = Date.now().toString(36);
  const [sharer, reader, member] = await Promise.all(
    ['sharer', 'reader', 'member'].map((name) =>
      prisma.user.create({
        data: { email: `spc-${name}-${suffix}@exocortex.test`, name, emailVerified: true },
      }),
    ),
  );
  sharerId = sharer!.id;
  readerId = reader!.id;
  memberId = member!.id;

  const [sharerWorkspace, readerWorkspace, memberWorkspace] = await Promise.all([
    prisma.workspace.create({
      data: {
        name: `Shared chat sharer ${suffix}`,
        slug: `spc-sharer-${suffix}`,
        members: {
          create: [
            { userId: sharerId, role: 'OWNER' },
            { userId: memberId, role: 'MEMBER' },
          ],
        },
      },
    }),
    prisma.workspace.create({
      data: {
        name: `Shared chat reader ${suffix}`,
        slug: `spc-reader-${suffix}`,
        members: { create: { userId: readerId, role: 'OWNER' } },
      },
    }),
    prisma.workspace.create({
      data: {
        name: `Shared chat member ${suffix}`,
        slug: `spc-member-${suffix}`,
        members: { create: { userId: memberId, role: 'OWNER' } },
      },
    }),
  ]);
  sharerWorkspaceId = sharerWorkspace.id;
  readerWorkspaceId = readerWorkspace.id;
  memberWorkspaceId = memberWorkspace.id;

  sectionId = await createPage('Bereich', null);
  sharedId = await createPage('Ideen', sectionId);
  childId = await createPage('Ideen im Detail', sharedId);
  siblingId = await createPage('Nachbar', sectionId);
  collectionId = await createPage('Kunden', null, 'COLLECTION');

  const share = await prisma.documentShare.create({
    data: {
      workspaceId: sharerWorkspaceId,
      documentId: sharedId,
      kind: 'USER',
      granteeId: readerId,
      createdById: sharerId,
    },
  });
  shareId = share.id;
}, 60_000);

beforeEach(async () => {
  await setGrant({});
});

afterAll(async () => {
  await prisma.workspace.deleteMany({
    where: { id: { in: [sharerWorkspaceId, readerWorkspaceId, memberWorkspaceId] } },
  });
  await prisma.user.deleteMany({ where: { id: { in: [sharerId, readerId, memberId] } } });
  await queues.obliterateAll();
  await queues.close();
  await prisma.$disconnect();
});

describe("a chat on a shared page runs in the reader's own workspace", () => {
  it('starts a conversation of the reader workspace with the shared page open', async () => {
    const { conversation } = await conversations.create({
      userId: readerId,
      request: { workspaceId: readerWorkspaceId, documentId: sharedId },
    });
    expect(conversation.workspaceId).toBe(readerWorkspaceId);
    expect(conversation.documentId).toBe(sharedId);
  });

  it("bills the run to the reader's workspace and never to the page's", async () => {
    const { conversation } = await conversations.create({
      userId: readerId,
      request: { workspaceId: readerWorkspaceId, documentId: null },
    });
    const posted = await conversations.postMessage({
      conversationId: conversation.id,
      userId: readerId,
      request: { content: 'Was steht auf dieser Seite?', documentId: sharedId },
      correlationId,
    });

    const run = await prisma.aiRun.findUniqueOrThrow({ where: { id: posted.run!.id } });
    expect(run.workspaceId).toBe(readerWorkspaceId);
    expect(run.createdById).toBe(readerId);
    expect(run.documentId).toBe(sharedId);
    await expect(prisma.aiRun.count({ where: { workspaceId: sharerWorkspaceId } })).resolves.toBe(
      0,
    );
  });

  it('/context names the shared page while the grant holds, and not after', async () => {
    const { conversation } = await conversations.create({
      userId: readerId,
      request: { workspaceId: readerWorkspaceId, documentId: sharedId },
    });
    const ask = () =>
      conversations.postMessage({
        conversationId: conversation.id,
        userId: readerId,
        request: { content: '/context' },
        correlationId,
      });

    expect((await ask()).command?.message).toContain('Ideen');
    await setGrant({ revoked: true });
    expect((await ask()).command?.message).not.toContain('Ideen');
  });

  it('refuses a page of the same workspace nobody shared', async () => {
    for (const documentId of [siblingId, sectionId, childId, collectionId]) {
      await expect(
        conversations.create({
          userId: readerId,
          request: { workspaceId: readerWorkspaceId, documentId },
        }),
      ).rejects.toMatchObject({ code: 'document_access_denied' });
    }
  });

  it("refuses a page of a workspace the caller belongs to, as the context of another one's chat", async () => {
    await expect(
      conversations.create({
        userId: memberId,
        request: { workspaceId: memberWorkspaceId, documentId: sharedId },
      }),
    ).rejects.toMatchObject({ code: 'document_access_denied' });
  });

  it('refuses the page once the grant is withdrawn, and keeps the transcript usable', async () => {
    const { conversation } = await conversations.create({
      userId: readerId,
      request: { workspaceId: readerWorkspaceId, documentId: sharedId },
    });
    await setGrant({ revoked: true });

    await expect(
      conversations.postMessage({
        conversationId: conversation.id,
        userId: readerId,
        request: { content: 'Und jetzt?', documentId: sharedId },
        correlationId,
      }),
    ).rejects.toMatchObject({ code: 'document_access_denied' });

    // A conversation bound to the page earlier carries on without it.
    const posted = await conversations.postMessage({
      conversationId: conversation.id,
      userId: readerId,
      request: { content: 'Und jetzt?' },
      correlationId,
    });
    const run = await prisma.aiRun.findUniqueOrThrow({ where: { id: posted.run!.id } });
    expect(run.documentId).toBeNull();
  });
});

describe("the run's tool calls reach exactly what the grant reaches", () => {
  it('reads the shared page on a READ grant but cannot change it', async () => {
    await expect(access.requireDocumentContext(sharedId, readerId)).resolves.toMatchObject({
      role: 'GUEST',
      grant: { source: 'share', permission: 'READ' },
    });
    await expect(renameAsReader(sharedId, 'Umbenannt')).rejects.toBeInstanceOf(AuthorizationError);
    const page = await prisma.document.findUniqueOrThrow({ where: { id: sharedId } });
    expect(page.title).toBe('Ideen');
  });

  it('changes the shared page on a WRITE grant', async () => {
    await setGrant({ permission: 'WRITE' });
    await renameAsReader(sharedId, 'Ideen (bearbeitet)');
    const page = await prisma.document.findUniqueOrThrow({ where: { id: sharedId } });
    expect(page.title).toBe('Ideen (bearbeitet)');
    await prisma.document.update({ where: { id: sharedId }, data: { title: 'Ideen' } });
  });

  it('reaches no sub-page and no neighbour of a single shared page, even on WRITE', async () => {
    await setGrant({ permission: 'WRITE' });
    for (const documentId of [childId, siblingId, sectionId]) {
      await expect(access.findDocumentContext(documentId, readerId)).resolves.toBeNull();
      await expect(renameAsReader(documentId, 'Übernommen')).rejects.toBeInstanceOf(
        AuthorizationError,
      );
    }
  });

  it('reaches the pages below when the grant covers the branch, and nothing beside it', async () => {
    await setGrant({ scope: 'SUBTREE' });
    await expect(access.findDocumentContext(childId, readerId)).resolves.not.toBeNull();
    await expect(access.findDocumentContext(siblingId, readerId)).resolves.toBeNull();
    await expect(access.findDocumentContext(sectionId, readerId)).resolves.toBeNull();
  });

  it("reaches nothing else in the sharer's workspace: no search, no database, only its branch of the tree", async () => {
    await setGrant({ permission: 'WRITE', scope: 'SUBTREE' });
    // `requireScopedRole` is what the search, the tree and the trash ask.
    await expect(access.requireScopedRole(sharerWorkspaceId, readerId)).rejects.toBeInstanceOf(
      AuthorizationError,
    );
    // The tree answers a grantee since issue #327, with the branch the grant
    // reaches and nothing above it or beside it.
    const branch = await tree.getTree(sharerWorkspaceId, readerId);
    expect(branch.nodes.map((node) => node.id)).toEqual([sharedId]);
    expect(branch.nodes.flatMap((node) => node.children.map((child) => child.id))).toEqual([
      childId,
    ]);
    expect(branch.archived).toEqual([]);
    await expect(access.findRole(sharerWorkspaceId, readerId)).resolves.toBeNull();
    await expect(access.findDocumentContext(collectionId, readerId)).resolves.toBeNull();
  });

  it('fails the next call the moment the grant is withdrawn', async () => {
    await setGrant({ permission: 'WRITE' });
    await expect(access.findDocumentContext(sharedId, readerId)).resolves.not.toBeNull();

    // Withdrawn between two tool calls of the same run.
    await setGrant({ permission: 'WRITE', revoked: true });
    await expect(access.requireDocumentContext(sharedId, readerId)).rejects.toMatchObject({
      code: 'document_access_denied',
    });
    await expect(renameAsReader(sharedId, 'Zu spät')).rejects.toBeInstanceOf(AuthorizationError);
  });

  it('keeps a run held to its own workspace by an agent profile away from the shared page', async () => {
    const confined = new WorkspaceAccessService(prisma, {
      current: () => null,
      workspace: () => readerWorkspaceId,
    });
    await expect(confined.findDocumentContext(sharedId, readerId)).resolves.toBeNull();
  });
});
