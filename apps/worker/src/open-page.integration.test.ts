import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { loadWorkerEnv } from '@exocortex/config';
import {
  createPrismaClient,
  generateOrderKey,
  type PrismaClient,
  type SearchAdapter,
} from '@exocortex/database';
import { createLogger, type Logger } from '@exocortex/logger';

import { resolveOpenPageReach } from './open-page';
import { buildSystemPrompt } from './system-prompt';

/**
 * A chat on a page somebody shared with the reader (issue #234), as far as
 * the worker decides it: whether the prompt names the page at all, and what it
 * says around it.
 *
 * The API checks the grant when a message is posted; the worker asks again
 * when the run starts, because the grant can be withdrawn in between. The
 * tests that matter are the refusals: a withdrawn grant, a sub-page of a
 * single shared page, a page of a workspace the reader merely belongs to, and
 * the titles above the shared page.
 */
const logger: Logger = createLogger({ name: 'worker-test', level: 'silent' });
const search = {} as unknown as SearchAdapter;

let prisma: PrismaClient;
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
let shareId: string;

async function createPage(title: string, parentId: string | null, body = ''): Promise<string> {
  const document = await prisma.document.create({
    data: {
      workspaceId: sharerWorkspaceId,
      parentId,
      type: 'PAGE',
      title,
      orderKey: generateOrderKey(null, null),
      createdById: sharerId,
      updatedById: sharerId,
      content: {
        create: {
          yjsState: Buffer.from([]),
          plainText: body,
          markdown: body,
          materializedAt: new Date(),
        },
      },
    },
  });
  return document.id;
}

async function promptFor(input: {
  documentId: string;
  userId?: string;
  workspaceId?: string;
}): Promise<string> {
  const result = await buildSystemPrompt({
    prisma,
    workspaceId: input.workspaceId ?? readerWorkspaceId,
    basePrompt: '',
    maxRuleChars: 10_000,
    documentId: input.documentId,
    userId: input.userId ?? readerId,
    databaseViewId: null,
    conversationId: null,
    pinnedContextMaxChars: 0,
    search: { hybrid: search, keyword: search },
    toolsAvailable: true,
    includePageContent: true,
    pageContentMaxChars: 10_000,
    logger,
  });
  return result.prompt;
}

beforeAll(async () => {
  const env = loadWorkerEnv();
  prisma = createPrismaClient({ databaseUrl: env.DATABASE_URL });

  const suffix = Date.now().toString(36);
  const [sharer, reader, member] = await Promise.all(
    ['sharer', 'reader', 'member'].map((name) =>
      prisma.user.create({
        data: { email: `reach-${name}-${suffix}@exocortex.test`, name, emailVerified: true },
      }),
    ),
  );
  sharerId = sharer!.id;
  readerId = reader!.id;
  memberId = member!.id;

  const [sharerWorkspace, readerWorkspace, memberWorkspace] = await Promise.all([
    prisma.workspace.create({
      data: {
        name: `Reach sharer ${suffix}`,
        slug: `reach-sharer-${suffix}`,
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
        name: `Reach reader ${suffix}`,
        slug: `reach-reader-${suffix}`,
        members: { create: { userId: readerId, role: 'OWNER' } },
      },
    }),
    prisma.workspace.create({
      data: {
        name: `Reach member ${suffix}`,
        slug: `reach-member-${suffix}`,
        members: { create: { userId: memberId, role: 'OWNER' } },
      },
    }),
  ]);
  sharerWorkspaceId = sharerWorkspace.id;
  readerWorkspaceId = readerWorkspace.id;
  memberWorkspaceId = memberWorkspace.id;

  sectionId = await createPage('Geheimer Bereich', null);
  sharedId = await createPage('Ideenliste', sectionId, 'Punkt eins und Punkt zwei.');
  childId = await createPage('Unterseite', sharedId, 'Nicht freigegeben.');
  siblingId = await createPage('Nachbarseite', sectionId, 'Auch nicht.');

  const share = await prisma.documentShare.create({
    data: {
      workspaceId: sharerWorkspaceId,
      documentId: sharedId,
      kind: 'USER',
      granteeId: readerId,
      permission: 'READ',
      scope: 'PAGE_ONLY',
      createdById: sharerId,
    },
  });
  shareId = share.id;
}, 60_000);

beforeEach(async () => {
  await prisma.documentShare.update({
    where: { id: shareId },
    data: { revokedAt: null, scope: 'PAGE_ONLY', permission: 'READ' },
  });
});

afterAll(async () => {
  await prisma.workspace.deleteMany({
    where: { id: { in: [sharerWorkspaceId, readerWorkspaceId, memberWorkspaceId] } },
  });
  await prisma.user.deleteMany({ where: { id: { in: [sharerId, readerId, memberId] } } });
  await prisma.$disconnect();
});

describe('resolveOpenPageReach', () => {
  it("reads a page of the run's own workspace there, with no grant", async () => {
    await expect(
      resolveOpenPageReach({
        prisma,
        runWorkspaceId: sharerWorkspaceId,
        documentId: sectionId,
        userId: sharerId,
      }),
    ).resolves.toEqual({ workspaceId: sharerWorkspaceId, share: null });
  });

  it("reaches a shared page from the reader's own workspace through the grant", async () => {
    await expect(
      resolveOpenPageReach({
        prisma,
        runWorkspaceId: readerWorkspaceId,
        documentId: sharedId,
        userId: readerId,
      }),
    ).resolves.toEqual({
      workspaceId: sharerWorkspaceId,
      share: { rootId: sharedId, scope: 'PAGE_ONLY', permission: 'READ' },
    });
  });

  it('reaches nothing once the grant is withdrawn', async () => {
    await prisma.documentShare.update({ where: { id: shareId }, data: { revokedAt: new Date() } });
    await expect(
      resolveOpenPageReach({
        prisma,
        runWorkspaceId: readerWorkspaceId,
        documentId: sharedId,
        userId: readerId,
      }),
    ).resolves.toBeNull();
  });

  it('reaches neither a sub-page nor a neighbour of a single shared page', async () => {
    for (const documentId of [childId, siblingId, sectionId]) {
      await expect(
        resolveOpenPageReach({
          prisma,
          runWorkspaceId: readerWorkspaceId,
          documentId,
          userId: readerId,
        }),
      ).resolves.toBeNull();
    }
  });

  it('reaches a sub-page when the grant covers the branch', async () => {
    await prisma.documentShare.update({ where: { id: shareId }, data: { scope: 'SUBTREE' } });
    await expect(
      resolveOpenPageReach({
        prisma,
        runWorkspaceId: readerWorkspaceId,
        documentId: childId,
        userId: readerId,
      }),
    ).resolves.toEqual({
      workspaceId: sharerWorkspaceId,
      share: { rootId: sharedId, scope: 'SUBTREE', permission: 'READ' },
    });
  });

  it('does not carry a page into another workspace for a mere member of its own', async () => {
    await expect(
      resolveOpenPageReach({
        prisma,
        runWorkspaceId: memberWorkspaceId,
        documentId: sharedId,
        userId: memberId,
      }),
    ).resolves.toBeNull();
  });
});

describe('the prompt of a chat on a shared page', () => {
  it('names the page, says it is shared, and names nothing above it', async () => {
    const prompt = await promptFor({ documentId: sharedId });

    expect(prompt).toContain('Titel: Ideenliste');
    expect(prompt).toContain('Pfad: Ideenliste');
    expect(prompt).toContain('jemand hat sie mit der Nutzerin geteilt');
    expect(prompt).toContain('Punkt eins und Punkt zwei.');
    expect(prompt).not.toContain('Geheimer Bereich');
    // The run still belongs to the reader's workspace.
    expect(prompt).toContain(`Aktueller Arbeitsbereich: ${readerWorkspaceId}`);
  });

  it('cuts the breadcrumb of a sub-page at the shared page', async () => {
    await prisma.documentShare.update({ where: { id: shareId }, data: { scope: 'SUBTREE' } });
    const prompt = await promptFor({ documentId: childId });

    expect(prompt).toContain('Pfad: Ideenliste / Unterseite');
    expect(prompt).not.toContain('Geheimer Bereich');
  });

  it('leaves the page out entirely once the grant is withdrawn', async () => {
    await prisma.documentShare.update({ where: { id: shareId }, data: { revokedAt: new Date() } });
    const prompt = await promptFor({ documentId: sharedId });

    expect(prompt).not.toContain('Ideenliste');
    expect(prompt).not.toContain('Punkt eins');
  });

  it('leaves out a sub-page a single-page grant does not cover', async () => {
    const prompt = await promptFor({ documentId: childId });

    expect(prompt).not.toContain('Unterseite');
    expect(prompt).not.toContain('Nicht freigegeben.');
  });

  it('leaves out a page of a workspace the reader is no member of and holds nothing on', async () => {
    const prompt = await promptFor({ documentId: siblingId });

    expect(prompt).not.toContain('Nachbarseite');
  });
});
