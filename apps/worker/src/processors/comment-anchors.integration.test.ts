import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { loadDotEnv } from '@exocortex/config';
import { createPrismaClient, generateOrderKey, type PrismaClient } from '@exocortex/database';
import { BLOCK_ID_ATTRIBUTE, type ProseMirrorDocument } from '@exocortex/editor';

import { sweepCommentAnchors } from './comment-anchors';

/**
 * The one rule an anchored comment has to obey: deleting the block it names
 * must never delete the comment (issue #18).
 */
loadDotEnv();

let prisma: PrismaClient;
let workspaceId: string;
let documentId: string;
let userId: string;

const LIVE_BLOCK = 'aliveblock11';
const GONE_BLOCK = 'goneblock222';

function documentWith(...blockIds: string[]): ProseMirrorDocument {
  return {
    type: 'doc',
    content: blockIds.map((blockId) => ({
      type: 'paragraph',
      attrs: { [BLOCK_ID_ATTRIBUTE]: blockId },
      content: [{ type: 'text', text: 'Ein Absatz' }],
    })),
  };
}

beforeAll(async () => {
  prisma = createPrismaClient({ databaseUrl: process.env.DATABASE_URL });
  const suffix = Date.now().toString(36);

  const user = await prisma.user.create({
    data: { email: `anchor-${suffix}@exocortex.test`, name: 'Anker', emailVerified: true },
  });
  userId = user.id;

  const workspace = await prisma.workspace.create({
    data: {
      name: `Anchors ${suffix}`,
      slug: `anchors-${suffix}`,
      members: { create: { userId, role: 'OWNER' } },
    },
  });
  workspaceId = workspace.id;

  const document = await prisma.document.create({
    data: {
      workspaceId,
      title: 'Verankerte Seite',
      orderKey: generateOrderKey(null, null),
      createdById: userId,
      updatedById: userId,
    },
  });
  documentId = document.id;
});

afterAll(async () => {
  await prisma.workspace.deleteMany({ where: { id: workspaceId } });
  await prisma.user.deleteMany({ where: { id: userId } });
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.comment.deleteMany({ where: { workspaceId } });
});

async function anchoredComment(blockId: string | null): Promise<string> {
  const created = await prisma.comment.create({
    data: {
      workspaceId,
      documentId,
      blockId,
      anchorText: blockId === null ? null : 'Der kommentierte Absatz',
      body: 'Anmerkung',
      createdById: userId,
    },
  });
  return created.id;
}

describe('sweepCommentAnchors', () => {
  it('orphans a comment whose block is gone instead of deleting it', async () => {
    const id = await anchoredComment(GONE_BLOCK);

    const result = await sweepCommentAnchors(prisma, {
      documentId,
      proseMirrorJson: documentWith(LIVE_BLOCK),
      sweptAt: new Date(),
    });

    expect(result.orphaned).toBe(1);
    const row = await prisma.comment.findUnique({ where: { id } });
    expect(row).not.toBeNull();
    expect(row?.orphanedAt).not.toBeNull();
    // What the thread was about is still readable, which is the point of
    // keeping the quote at creation time.
    expect(row?.anchorText).toBe('Der kommentierte Absatz');
  });

  it('leaves a live anchor alone', async () => {
    const id = await anchoredComment(LIVE_BLOCK);

    const result = await sweepCommentAnchors(prisma, {
      documentId,
      proseMirrorJson: documentWith(LIVE_BLOCK, GONE_BLOCK),
      sweptAt: new Date(),
    });

    expect(result).toEqual({ orphaned: 0, restored: 0 });
    expect((await prisma.comment.findUnique({ where: { id } }))?.orphanedAt).toBeNull();
  });

  it('clears the mark when the block comes back', async () => {
    const id = await anchoredComment(GONE_BLOCK);
    await sweepCommentAnchors(prisma, {
      documentId,
      proseMirrorJson: documentWith(LIVE_BLOCK),
      sweptAt: new Date(),
    });

    const result = await sweepCommentAnchors(prisma, {
      documentId,
      proseMirrorJson: documentWith(LIVE_BLOCK, GONE_BLOCK),
      sweptAt: new Date(),
    });

    expect(result.restored).toBe(1);
    expect((await prisma.comment.findUnique({ where: { id } }))?.orphanedAt).toBeNull();
  });

  it('never touches a page-wide comment', async () => {
    const id = await anchoredComment(null);

    const result = await sweepCommentAnchors(prisma, {
      documentId,
      proseMirrorJson: { type: 'doc', content: [] },
      sweptAt: new Date(),
    });

    expect(result).toEqual({ orphaned: 0, restored: 0 });
    expect((await prisma.comment.findUnique({ where: { id } }))?.orphanedAt).toBeNull();
  });

  it('finds a block nested inside another block', async () => {
    const id = await anchoredComment(LIVE_BLOCK);

    await sweepCommentAnchors(prisma, {
      documentId,
      proseMirrorJson: {
        type: 'doc',
        content: [
          {
            type: 'blockquote',
            attrs: { [BLOCK_ID_ATTRIBUTE]: 'outerblock11' },
            content: [
              {
                type: 'paragraph',
                attrs: { [BLOCK_ID_ATTRIBUTE]: LIVE_BLOCK },
                content: [{ type: 'text', text: 'Tief' }],
              },
            ],
          },
        ],
      },
      sweptAt: new Date(),
    });

    expect((await prisma.comment.findUnique({ where: { id } }))?.orphanedAt).toBeNull();
  });
});
