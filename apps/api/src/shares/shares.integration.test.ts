import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  AuthorizationError,
  type PageScopeRestriction,
  WorkspaceAccessService,
} from '@exocortex/auth';
import { loadDotEnv } from '@exocortex/config';
import { createShareRequestSchema } from '@exocortex/contracts';
import { createPrismaClient, type PrismaClient } from '@exocortex/database';
import { createLogger, type Logger } from '@exocortex/logger';
import { QueueRegistry, testQueuePrefix } from '@exocortex/queue';
import { type ObjectStorage } from '@exocortex/storage';

import { AppError } from '../common/app-error';
import { OutboxService } from '../common/outbox.service';
import { DocumentLinksService } from '../documents/document-links.service';
import { DocumentMoveService } from '../documents/document-move.service';
import { DocumentTrashService } from '../documents/document-trash.service';
import { DocumentTreeService } from '../documents/document-tree.service';
import { DocumentsService } from '../documents/documents.service';
import { type RealtimeService } from '../realtime/realtime.service';

import { PublicSharesService } from './public-shares.service';
import { SharesService } from './shares.service';

/**
 * Page shares against the real database (issue #83, ADR-044).
 *
 * The tests worth having here are the ones about what a share does *not* hand
 * over: the sections above the shared page, the pages beside it, the workspace
 * it lives in. Those are the leaks a sharing feature ships with, because the
 * routes that produce them answer about pages nobody asked for.
 *
 * The second half is the confinement of a credential, which is the same
 * question asked of a token rather than of a person.
 */
loadDotEnv();

const logger: Logger = createLogger({ name: 'api-test', level: 'silent' });
const correlationId = 'test-correlation';

let prisma: PrismaClient;
let queues: QueueRegistry;
let documents: DocumentsService;
let tree: DocumentTreeService;
let links: DocumentLinksService;
let shares: SharesService;
let publicShares: PublicSharesService;
let access: WorkspaceAccessService;

let workspaceId: string;
let ownerId: string;
let outsiderId: string;
let strangerId: string;
let secretPageId: string;
let sectionId: string;
let sharedPageId: string;
let childPageId: string;

/** What `SessionGuard` would have put in the request context. */
let restriction: PageScopeRestriction | null = null;

const realtime = {
  emit: async () => undefined,
  revoke: async () => undefined,
} as unknown as RealtimeService;
const storage = {
  deleteObject: async () => undefined,
  getObject: async () => undefined,
} as unknown as ObjectStorage;

beforeAll(async () => {
  prisma = createPrismaClient({ databaseUrl: process.env.DATABASE_URL });
  queues = new QueueRegistry({
    redisUrl: process.env.REDIS_URL ?? 'redis://127.0.0.1:6380',
    logger,
    prefix: testQueuePrefix('api-shares'),
  });
  // The provider is the whole mechanism under test for the second half: it is
  // what `PlatformModule` wires to the request context in production.
  access = new WorkspaceAccessService(prisma, { current: () => restriction });
  const outbox = new OutboxService(prisma, logger);
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
  links = new DocumentLinksService(prisma, access);
  shares = new SharesService(prisma, logger, access, outbox, realtime);
  publicShares = new PublicSharesService(prisma, storage);

  const suffix = Date.now().toString(36);
  const owner = await prisma.user.create({
    data: { email: `share-owner-${suffix}@exocortex.test`, name: 'Owner', emailVerified: true },
  });
  ownerId = owner.id;
  const outsider = await prisma.user.create({
    data: { email: `share-guest-${suffix}@exocortex.test`, name: 'Gast', emailVerified: true },
  });
  outsiderId = outsider.id;
  const stranger = await prisma.user.create({
    data: { email: `share-none-${suffix}@exocortex.test`, name: 'Fremd', emailVerified: true },
  });
  strangerId = stranger.id;

  const workspace = await prisma.workspace.create({
    data: {
      name: `Shares ${suffix}`,
      slug: `shares-${suffix}`,
      members: { create: { userId: ownerId, role: 'OWNER' } },
    },
  });
  workspaceId = workspace.id;

  secretPageId = await createPage('Steuerunterlagen');
  sectionId = await createPage('Worldbuilding');
  sharedPageId = await createPage('Cyberpunk', sectionId);
  childPageId = await createPage('Konzerne', sharedPageId);
});

afterAll(async () => {
  await prisma.documentShare.deleteMany({ where: { workspaceId } });
  await prisma.workspace.deleteMany({ where: { id: workspaceId } });
  await prisma.user.deleteMany({ where: { id: { in: [ownerId, outsiderId, strangerId] } } });
  await queues.obliterateAll();
  await queues.close();
  await prisma.$disconnect();
});

beforeEach(async () => {
  restriction = null;
  await prisma.documentShare.deleteMany({ where: { workspaceId } });
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

async function shareWith(
  documentId: string,
  email: string,
  permission: 'READ' | 'WRITE',
  scope: 'PAGE_ONLY' | 'SUBTREE',
): Promise<string> {
  const result = await shares.create({
    documentId,
    userId: ownerId,
    request: { kind: 'USER', email, permission, scope, expiresInDays: null },
    correlationId,
  });
  return result.share.id;
}

describe('a share hands over the page and nothing around it', () => {
  it('lets the recipient read the page they were given', async () => {
    const outsider = await prisma.user.findUniqueOrThrow({ where: { id: outsiderId } });
    await shareWith(sharedPageId, outsider.email, 'READ', 'PAGE_ONLY');

    const context = await access.findDocumentContext(sharedPageId, outsiderId);
    expect(context).not.toBeNull();
    expect(context?.grant).toMatchObject({ source: 'share', permission: 'READ' });
    // READ becomes GUEST, which is what every existing policy already means by
    // "may look, may not write".
    expect(context?.role).toBe('GUEST');
  });

  it('does not let them reach the section above it, or an unrelated page', async () => {
    const outsider = await prisma.user.findUniqueOrThrow({ where: { id: outsiderId } });
    await shareWith(sharedPageId, outsider.email, 'READ', 'PAGE_ONLY');

    expect(await access.findDocumentContext(sectionId, outsiderId)).toBeNull();
    expect(await access.findDocumentContext(secretPageId, outsiderId)).toBeNull();
    // A page-only grant does not carry the pages below it either.
    expect(await access.findDocumentContext(childPageId, outsiderId)).toBeNull();
  });

  it('cuts the breadcrumb at the shared page', async () => {
    const outsider = await prisma.user.findUniqueOrThrow({ where: { id: outsiderId } });
    await shareWith(sharedPageId, outsider.email, 'READ', 'PAGE_ONLY');

    const detail = await documents.getDetail(sharedPageId, outsiderId);
    expect(detail.breadcrumb).toEqual([]);
    expect(detail.viaShare).toBe(true);
    expect(detail.canShare).toBe(false);

    // The owner still sees where the page sits.
    const ownerView = await documents.getDetail(sharedPageId, ownerId);
    expect(ownerView.breadcrumb.map((entry) => entry.title)).toEqual(['Worldbuilding']);
    expect(ownerView.canShare).toBe(true);
  });

  it('carries the branch when the grant says SUBTREE, and stops at its root', async () => {
    const outsider = await prisma.user.findUniqueOrThrow({ where: { id: outsiderId } });
    await shareWith(sharedPageId, outsider.email, 'WRITE', 'SUBTREE');

    const child = await access.findDocumentContext(childPageId, outsiderId);
    expect(child?.role).toBe('MEMBER');
    expect(await access.findDocumentContext(sectionId, outsiderId)).toBeNull();
  });

  it('tells nobody but a member who else holds the page', async () => {
    const outsider = await prisma.user.findUniqueOrThrow({ where: { id: outsiderId } });
    await shareWith(sharedPageId, outsider.email, 'READ', 'SUBTREE');

    const asRecipient = await shares.list(sharedPageId, outsiderId);
    expect(asRecipient.shares).toEqual([]);
    expect(asRecipient.inherited).toEqual([]);

    const asOwner = await shares.list(sharedPageId, ownerId);
    expect(asOwner.shares).toHaveLength(1);
  });

  it('reports a grant a page inherits from a section above it', async () => {
    const outsider = await prisma.user.findUniqueOrThrow({ where: { id: outsiderId } });
    await shareWith(sectionId, outsider.email, 'READ', 'SUBTREE');

    const listed = await shares.list(sharedPageId, ownerId);
    expect(listed.shares).toEqual([]);
    expect(listed.inherited).toHaveLength(1);
    expect(listed.inherited[0]?.documentId).toBe(sectionId);
  });

  it('refuses to let a recipient share the page on', async () => {
    const outsider = await prisma.user.findUniqueOrThrow({ where: { id: outsiderId } });
    const stranger = await prisma.user.findUniqueOrThrow({ where: { id: strangerId } });
    await shareWith(sharedPageId, outsider.email, 'WRITE', 'SUBTREE');

    await expect(
      shares.create({
        documentId: sharedPageId,
        userId: outsiderId,
        request: {
          kind: 'USER',
          email: stranger.email,
          permission: 'READ',
          scope: 'PAGE_ONLY',
          expiresInDays: null,
        },
        correlationId,
      }),
    ).rejects.toBeInstanceOf(AppError);
  });

  it('stops backlinks from naming a page the recipient may not read', async () => {
    const outsider = await prisma.user.findUniqueOrThrow({ where: { id: outsiderId } });
    await shareWith(sharedPageId, outsider.email, 'READ', 'PAGE_ONLY');
    await prisma.documentLink.create({
      data: {
        workspaceId,
        sourceDocumentId: secretPageId,
        targetDocumentId: sharedPageId,
        kind: 'PAGE_LINK',
        targetTitle: 'Cyberpunk',
        targetTitleKey: 'cyberpunk',
        context: 'siehe Cyberpunk',
        position: 0,
      },
    });

    const asOwner = await links.list(sharedPageId, ownerId);
    expect(asOwner.incoming).toHaveLength(1);

    const asRecipient = await links.list(sharedPageId, outsiderId);
    expect(asRecipient.incoming).toEqual([]);
  });

  it('withdraws access the moment the grant is revoked', async () => {
    const outsider = await prisma.user.findUniqueOrThrow({ where: { id: outsiderId } });
    const shareId = await shareWith(sharedPageId, outsider.email, 'READ', 'PAGE_ONLY');
    expect(await access.findDocumentContext(sharedPageId, outsiderId)).not.toBeNull();

    await shares.revoke({ shareId, userId: ownerId, correlationId });
    expect(await access.findDocumentContext(sharedPageId, outsiderId)).toBeNull();
  });

  it('withdraws access when the grant expires', async () => {
    const outsider = await prisma.user.findUniqueOrThrow({ where: { id: outsiderId } });
    const shareId = await shareWith(sharedPageId, outsider.email, 'READ', 'PAGE_ONLY');
    await prisma.documentShare.update({
      where: { id: shareId },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });
    expect(await access.findDocumentContext(sharedPageId, outsiderId)).toBeNull();
  });

  it('ends a subtree grant for a page moved out of the branch', async () => {
    const outsider = await prisma.user.findUniqueOrThrow({ where: { id: outsiderId } });
    await shareWith(sharedPageId, outsider.email, 'READ', 'SUBTREE');
    expect(await access.findDocumentContext(childPageId, outsiderId)).not.toBeNull();

    await documents.move({
      documentId: childPageId,
      userId: ownerId,
      request: { parentId: secretPageId },
      correlationId,
    });
    expect(await access.findDocumentContext(childPageId, outsiderId)).toBeNull();

    // And a page moved *into* the branch becomes shared, which is the direction
    // the move dialog warns about.
    await documents.move({
      documentId: childPageId,
      userId: ownerId,
      request: { parentId: sharedPageId },
      correlationId,
    });
    expect(await access.findDocumentContext(childPageId, outsiderId)).not.toBeNull();
  });
});

describe("the account's own list of grants", () => {
  let colleagueId: string;
  let otherWorkspaceId: string;
  let otherPageId: string;

  const link = {
    kind: 'PUBLIC_LINK',
    permission: 'READ',
    scope: 'PAGE_ONLY',
    expiresInDays: null,
  } as const;

  beforeAll(async () => {
    const suffix = Date.now().toString(36);
    const colleague = await prisma.user.create({
      data: {
        email: `share-admin-${suffix}@exocortex.test`,
        name: 'Kollegin',
        emailVerified: true,
      },
    });
    colleagueId = colleague.id;
    await prisma.workspaceMember.create({
      data: { workspaceId, userId: colleagueId, role: 'ADMIN' },
    });

    const other = await prisma.workspace.create({
      data: {
        name: `Shares elsewhere ${suffix}`,
        slug: `shares-elsewhere-${suffix}`,
        members: { create: { userId: ownerId, role: 'OWNER' } },
      },
    });
    otherWorkspaceId = other.id;
    const page = await documents.create({
      workspaceId: otherWorkspaceId,
      userId: ownerId,
      request: { title: 'Rezepte', type: 'PAGE', parentId: null },
      correlationId,
    });
    otherPageId = page.id;
  });

  afterAll(async () => {
    await prisma.documentShare.deleteMany({ where: { workspaceId: otherWorkspaceId } });
    await prisma.workspace.deleteMany({ where: { id: otherWorkspaceId } });
    await prisma.workspaceMember.deleteMany({ where: { workspaceId, userId: colleagueId } });
    await prisma.user.deleteMany({ where: { id: colleagueId } });
  });

  beforeEach(async () => {
    await prisma.documentShare.deleteMany({ where: { workspaceId: otherWorkspaceId } });
    await prisma.workspaceMember.update({
      where: { workspaceId_userId: { workspaceId: otherWorkspaceId, userId: ownerId } },
      data: { role: 'OWNER' },
    });
  });

  it('gathers every workspace, names each one, and leaves out what others shared', async () => {
    await shares.create({
      documentId: sharedPageId,
      userId: ownerId,
      request: link,
      correlationId,
    });
    await shares.create({ documentId: otherPageId, userId: ownerId, request: link, correlationId });
    await shares.create({
      documentId: secretPageId,
      userId: colleagueId,
      request: link,
      correlationId,
    });

    const mine = await shares.listMine(ownerId);
    expect(mine.truncated).toBe(false);
    const named = new Map(mine.shares.map((share) => [share.documentTitle, share.workspaceName]));
    expect([...named.keys()].sort()).toEqual(['Cyberpunk', 'Rezepte']);
    expect(named.get('Cyberpunk')).toMatch(/^Shares [a-z0-9]+$/);
    expect(named.get('Rezepte')).toMatch(/^Shares elsewhere /);
    expect(mine.shares.every((share) => share.canRevoke)).toBe(true);
    expect(mine.shares.every((share) => share.token === null)).toBe(true);
  });

  it('puts live grants before withdrawn ones', async () => {
    const first = await shares.create({
      documentId: sharedPageId,
      userId: ownerId,
      request: link,
      correlationId,
    });
    await shares.create({ documentId: childPageId, userId: ownerId, request: link, correlationId });
    await shares.revoke({ shareId: first.share.id, userId: ownerId, correlationId });

    const mine = await shares.listMine(ownerId);
    expect(mine.shares.map((share) => share.revokedAt === null)).toEqual([true, false]);
  });

  it('keeps a grant the caller can no longer withdraw, and says so', async () => {
    await shares.create({ documentId: otherPageId, userId: ownerId, request: link, correlationId });
    await prisma.workspaceMember.update({
      where: { workspaceId_userId: { workspaceId: otherWorkspaceId, userId: ownerId } },
      data: { role: 'MEMBER' },
    });

    const mine = await shares.listMine(ownerId);
    const rezepte = mine.shares.find((share) => share.documentId === otherPageId);
    expect(rezepte?.canRevoke).toBe(false);
  });

  it('stays inside the branch a confined credential reaches', async () => {
    await shares.create({
      documentId: sharedPageId,
      userId: ownerId,
      request: link,
      correlationId,
    });
    await shares.create({
      documentId: secretPageId,
      userId: ownerId,
      request: link,
      correlationId,
    });
    await shares.create({ documentId: otherPageId, userId: ownerId, request: link, correlationId });

    restriction = {
      tokenId: 'test-token',
      declared: true,
      scopes: [{ documentId: sectionId, scope: 'SUBTREE' }],
    };
    const mine = await shares.listMine(ownerId);
    expect(mine.shares.map((share) => share.documentTitle)).toEqual(['Cyberpunk']);
  });
});

describe('a public link', () => {
  async function createLink(scope: 'PAGE_ONLY' | 'SUBTREE'): Promise<string> {
    const created = await shares.create({
      documentId: sharedPageId,
      userId: ownerId,
      request: { kind: 'PUBLIC_LINK', permission: 'READ', scope, expiresInDays: null },
      correlationId,
    });
    const token = created.share.token;
    expect(token).not.toBeNull();
    return token as string;
  }

  it('serves the page it names and nothing above it', async () => {
    const token = await createLink('PAGE_ONLY');
    const result = await publicShares.read(token);
    expect(result.page.title).toBe('Cyberpunk');
    expect(result.page.path.map((entry) => entry.title)).toEqual(['Cyberpunk']);
    expect(result.page.children).toEqual([]);

    await expect(publicShares.read(token, sectionId)).rejects.toMatchObject({
      code: 'share_link_invalid',
    });
    await expect(publicShares.read(token, secretPageId)).rejects.toMatchObject({
      code: 'share_link_invalid',
    });
  });

  it('walks down a branch when the link covers one', async () => {
    const token = await createLink('SUBTREE');
    const root = await publicShares.read(token);
    expect(root.page.children.map((child) => child.title)).toContain('Konzerne');

    const child = await publicShares.read(token, childPageId);
    expect(child.page.title).toBe('Konzerne');
    expect(child.page.path.map((entry) => entry.title)).toEqual(['Cyberpunk', 'Konzerne']);
  });

  it('answers the same way for a wrong token and a withdrawn one', async () => {
    const token = await createLink('PAGE_ONLY');
    const share = await prisma.documentShare.findFirstOrThrow({
      where: { documentId: sharedPageId, kind: 'PUBLIC_LINK' },
    });
    await shares.revoke({ shareId: share.id, userId: ownerId, correlationId });

    await expect(publicShares.read(token)).rejects.toMatchObject({
      code: 'share_link_invalid',
    });
    await expect(publicShares.read('a'.repeat(43))).rejects.toMatchObject({
      code: 'share_link_invalid',
    });
  });

  it('cannot carry write permission, at the contract or behind it', async () => {
    // The route would never get this far: the request schema refuses it.
    expect(
      createShareRequestSchema.safeParse({
        kind: 'PUBLIC_LINK',
        permission: 'WRITE',
        scope: 'PAGE_ONLY',
        expiresInDays: null,
      }).success,
    ).toBe(false);

    // And behind it, a caller who bypassed the schema still gets READ: the
    // service hard-codes it and the database has a check constraint under that.
    const created = await shares.create({
      documentId: sharedPageId,
      userId: ownerId,
      request: {
        kind: 'PUBLIC_LINK',
        permission: 'WRITE',
        scope: 'PAGE_ONLY',
        expiresInDays: null,
      },
      correlationId,
    });
    expect(created.share.permission).toBe('READ');

    await expect(
      prisma.documentShare.update({
        where: { id: created.share.id },
        data: { permission: 'WRITE' },
      }),
    ).rejects.toBeTruthy();
  });

  it('never returns the raw address a second time', async () => {
    await createLink('PAGE_ONLY');
    const listed = await shares.list(sharedPageId, ownerId);
    expect(listed.shares[0]?.token).toBeNull();
    expect(listed.shares[0]?.tokenPrefix).toHaveLength(8);
  });
});

describe('a page-scoped token', () => {
  function confineTo(documentId: string, scope: 'PAGE_ONLY' | 'SUBTREE'): void {
    restriction = { tokenId: 'test-token', declared: true, scopes: [{ documentId, scope }] };
  }

  it('reaches its branch and nothing else', async () => {
    confineTo(sharedPageId, 'SUBTREE');
    expect(await access.findDocumentContext(sharedPageId, ownerId)).not.toBeNull();
    expect(await access.findDocumentContext(childPageId, ownerId)).not.toBeNull();
    expect(await access.findDocumentContext(sectionId, ownerId)).toBeNull();
    expect(await access.findDocumentContext(secretPageId, ownerId)).toBeNull();
  });

  it('is refused outright on a workspace-wide question', async () => {
    confineTo(sharedPageId, 'SUBTREE');
    await expect(access.requireRole(workspaceId, ownerId)).rejects.toBeInstanceOf(
      AuthorizationError,
    );
    await expect(access.findRole(workspaceId, ownerId)).rejects.toMatchObject({
      code: 'token_scope_exceeded',
    });
  });

  it('sees only its branch in the page tree', async () => {
    confineTo(sharedPageId, 'SUBTREE');
    const scoped = await tree.getTree(workspaceId, ownerId);
    const titles = scoped.nodes.map((node) => node.title);
    expect(titles).toEqual(['Cyberpunk']);
    expect(scoped.totalCount).toBe(2);
  });

  it('cannot create a page outside its branch, or at the root', async () => {
    confineTo(sharedPageId, 'SUBTREE');
    await expect(
      documents.create({
        workspaceId,
        userId: ownerId,
        request: { title: 'Nope', type: 'PAGE', parentId: null },
        correlationId,
      }),
    ).rejects.toMatchObject({ code: 'token_scope_exceeded' });
    await expect(
      documents.create({
        workspaceId,
        userId: ownerId,
        request: { title: 'Nope', type: 'PAGE', parentId: secretPageId },
        correlationId,
      }),
    ).rejects.toMatchObject({ code: 'token_scope_exceeded' });

    const allowed = await documents.create({
      workspaceId,
      userId: ownerId,
      request: { title: 'Erlaubt', type: 'PAGE', parentId: childPageId },
      correlationId,
    });
    expect(allowed.parentId).toBe(childPageId);
    await prisma.document.delete({ where: { id: allowed.id } });
  });

  it('reaches nothing once the pages it named are gone', async () => {
    restriction = { tokenId: 'test-token', declared: true, scopes: [] };
    expect(await access.findDocumentContext(sharedPageId, ownerId)).toBeNull();
    expect(await access.findDocumentContext(secretPageId, ownerId)).toBeNull();
  });

  it('leaves an unconfined credential alone', async () => {
    restriction = null;
    expect(await access.findDocumentContext(secretPageId, ownerId)).not.toBeNull();
    const full = await tree.getTree(workspaceId, ownerId);
    expect(full.nodes.length).toBeGreaterThan(1);
  });
});

/**
 * The events the recipient's mail is built from (issue #103).
 *
 * Asserted here rather than at the mail, because this is where the decision
 * is: the worker sends what it is handed, so an event too many is a mail too
 * many and an event that never leaves the transaction is a mail that never
 * goes. The two cases the issue singles out are both about restraint -- a
 * public link has nobody to write to, and a page moved into a shared branch
 * must not write to everybody who holds anything nearby.
 */
describe('a changed grant leaves an event behind', () => {
  interface ShareEvent {
    change: string;
    shareId: string;
    documentId: string;
    granteeId: string;
    actorId: string;
  }

  async function shareEvents(): Promise<ShareEvent[]> {
    const rows = await prisma.outboxEvent.findMany({
      where: { workspaceId, type: 'document.share.changed' },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((row) => row.payload as unknown as ShareEvent);
  }

  beforeEach(async () => {
    await prisma.outboxEvent.deleteMany({ where: { workspaceId } });
  });

  it('records who was given what, and by whom', async () => {
    const outsider = await prisma.user.findUniqueOrThrow({ where: { id: outsiderId } });
    const shareId = await shareWith(sharedPageId, outsider.email, 'READ', 'PAGE_ONLY');

    expect(await shareEvents()).toEqual([
      {
        change: 'granted',
        shareId,
        documentId: sharedPageId,
        granteeId: outsiderId,
        actorId: ownerId,
      },
    ]);
  });

  it('records a widened permission, and stays quiet about a save that changed nothing', async () => {
    const outsider = await prisma.user.findUniqueOrThrow({ where: { id: outsiderId } });
    const shareId = await shareWith(sharedPageId, outsider.email, 'READ', 'PAGE_ONLY');
    await prisma.outboxEvent.deleteMany({ where: { workspaceId } });

    await shares.update({
      shareId,
      userId: ownerId,
      request: { permission: 'WRITE' },
      correlationId,
    });
    expect((await shareEvents()).map((event) => event.change)).toEqual(['changed']);

    // The same value again. A dialog that submits every field on every save
    // would otherwise post somebody a letter saying nothing happened.
    await shares.update({
      shareId,
      userId: ownerId,
      request: { permission: 'WRITE', scope: 'PAGE_ONLY' },
      correlationId,
    });
    expect((await shareEvents()).map((event) => event.change)).toEqual(['changed']);
  });

  it('records a withdrawal once, however often it is asked for', async () => {
    const outsider = await prisma.user.findUniqueOrThrow({ where: { id: outsiderId } });
    const shareId = await shareWith(sharedPageId, outsider.email, 'READ', 'PAGE_ONLY');
    await prisma.outboxEvent.deleteMany({ where: { workspaceId } });

    await shares.revoke({ shareId, userId: ownerId, correlationId });
    await shares.revoke({ shareId, userId: ownerId, correlationId });
    expect((await shareEvents()).map((event) => event.change)).toEqual(['revoked']);
  });

  it('writes nothing for a public link, neither when it is made nor when it ends', async () => {
    const created = await shares.create({
      documentId: sharedPageId,
      userId: ownerId,
      request: { kind: 'PUBLIC_LINK', permission: 'READ', scope: 'PAGE_ONLY', expiresInDays: null },
      correlationId,
    });
    await shares.revoke({ shareId: created.share.id, userId: ownerId, correlationId });

    expect(await shareEvents()).toEqual([]);
  });

  it('writes nothing when a page is moved into a shared branch', async () => {
    const outsider = await prisma.user.findUniqueOrThrow({ where: { id: outsiderId } });
    await shareWith(sharedPageId, outsider.email, 'READ', 'SUBTREE');
    await prisma.outboxEvent.deleteMany({ where: { workspaceId } });

    const moved = await documents.create({
      workspaceId,
      userId: ownerId,
      request: { title: 'Wandert', type: 'PAGE', parentId: secretPageId },
      correlationId,
    });
    await documents.move({
      documentId: moved.id,
      userId: ownerId,
      request: { parentId: sharedPageId },
      correlationId,
    });

    // The recipient can now read it, and hears nothing: a reorganization is
    // not an access change anybody asked to be told about, and one move can
    // carry a hundred pages.
    expect(await access.findDocumentContext(moved.id, outsiderId)).not.toBeNull();
    expect(await shareEvents()).toEqual([]);
    await prisma.document.delete({ where: { id: moved.id } });
  });
});
