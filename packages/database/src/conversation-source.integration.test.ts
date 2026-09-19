import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadWorkerEnv } from '@exocortex/config';
import { createLogger, type Logger } from '@exocortex/logger';

import {
  type ConversationSourceRef,
  perSourceShare,
  renderConversationSources,
} from './conversation-source';
import { createPrismaClient, generateOrderKey, type PrismaClient } from './index';
import { PostgresSearchAdapter } from './search';

/**
 * `renderConversationSources` against real PostgreSQL (issue #75).
 *
 * Deliberately not unit-tested behind a fake Prisma, for the same reason
 * `describeCollection` is not: the whole point of this function is that the
 * chip row above the composer and the system prompt are the *same* characters,
 * and a fake would let the two drift apart without any test noticing.
 */
const env = loadWorkerEnv();
const logger: Logger = createLogger({ name: 'conversation-source-test', level: 'silent' });

let prisma: PrismaClient;
let workspaceId: string;
let userId: string;
let conversationId: string;
let longPageId: string;
let shortPageId: string;
let emptyPageId: string;

const LONG_BODY = 'Die Frist endet am 31. Juli. '.repeat(200);

beforeAll(async () => {
  prisma = createPrismaClient({ databaseUrl: env.DATABASE_URL });

  const suffix = Date.now().toString(36);
  const user = await prisma.user.create({
    data: {
      email: `sources-${suffix}@exocortex.test`,
      name: 'Sources Test',
      emailVerified: true,
    },
  });
  userId = user.id;
  const workspace = await prisma.workspace.create({
    data: {
      name: `Sources ${suffix}`,
      slug: `sources-${suffix}`,
      members: { create: { userId, role: 'OWNER' } },
    },
  });
  workspaceId = workspace.id;

  const createPage = async (title: string, body: string | null): Promise<string> => {
    const page = await prisma.document.create({
      data: {
        workspaceId,
        title,
        type: 'PAGE',
        orderKey: generateOrderKey(null, null),
        createdById: userId,
        updatedById: userId,
        ...(body === null
          ? {}
          : {
              content: { create: { markdown: body, plainText: body, yjsState: Buffer.alloc(0) } },
            }),
      },
    });
    return page.id;
  };

  longPageId = await createPage('Steuern 2026', LONG_BODY);
  shortPageId = await createPage('Notizen', 'Kurz und gut.');
  emptyPageId = await createPage('Nie materialisiert', null);

  const conversation = await prisma.aiConversation.create({
    data: { workspaceId, createdById: userId, title: 'Test' },
  });
  conversationId = conversation.id;
});

afterAll(async () => {
  await prisma.workspace.deleteMany({ where: { id: workspaceId } });
  await prisma.user.deleteMany({ where: { id: userId } });
  await prisma.$disconnect();
});

function refs(...rows: Omit<ConversationSourceRef, 'databaseViewId' | 'savedQueryId'>[]) {
  return rows.map((row) => ({ ...row, databaseViewId: null, savedQueryId: null }));
}

function render(sources: readonly ConversationSourceRef[], maxChars: number) {
  return renderConversationSources({
    prisma,
    workspaceId,
    sources,
    maxChars,
    search: {
      hybrid: new PostgresSearchAdapter(prisma),
      keyword: new PostgresSearchAdapter(prisma),
    },
    logger,
  });
}

describe('perSourceShare', () => {
  it('splits the budget evenly so one long page cannot eat it', () => {
    expect(perSourceShare(24_000, 1)).toBe(24_000);
    expect(perSourceShare(24_000, 4)).toBe(6_000);
  });

  it('never goes below a share a source could say anything in', () => {
    expect(perSourceShare(1_000, 10)).toBe(600);
  });

  it('is zero when nothing is embedded or the budget is off', () => {
    expect(perSourceShare(24_000, 0)).toBe(0);
    expect(perSourceShare(0, 3)).toBe(0);
  });
});

describe('renderConversationSources', () => {
  it('embeds a page and reports what it would have cost unabridged', async () => {
    const result = await render(
      refs({ id: 's1', kind: 'PAGE', mode: 'EMBED', documentId: shortPageId }),
      24_000,
    );

    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]?.title).toBe('Notizen');
    expect(result.sources[0]?.text).toBe('Kurz und gut.');
    expect(result.sources[0]?.truncated).toBe(false);
    expect(result.budget.usedChars).toBe('Kurz und gut.'.length);
  });

  it('cuts a page to its share and says so', async () => {
    const result = await render(
      refs(
        { id: 's1', kind: 'PAGE', mode: 'EMBED', documentId: longPageId },
        { id: 's2', kind: 'PAGE', mode: 'EMBED', documentId: shortPageId },
      ),
      2_000,
    );

    expect(result.budget.perSourceChars).toBe(1_000);
    expect(result.sources[0]?.truncated).toBe(true);
    expect(result.sources[0]?.text).toHaveLength(1_000);
    expect(result.sources[0]?.fullChars).toBe(LONG_BODY.trim().length);
    // The second source still gets its own share rather than the remainder.
    expect(result.sources[1]?.truncated).toBe(false);
  });

  it('carries no text for a referenced source, whatever the budget is', async () => {
    const result = await render(
      refs({ id: 's1', kind: 'PAGE', mode: 'REFERENCE', documentId: longPageId }),
      24_000,
    );

    expect(result.sources[0]?.text).toBe('');
    expect(result.sources[0]?.fullChars).toBeGreaterThan(0);
    expect(result.budget.usedChars).toBe(0);
  });

  it('degrades every source to a pointer when the budget is zero', async () => {
    const result = await render(
      refs({ id: 's1', kind: 'PAGE', mode: 'EMBED', documentId: longPageId }),
      0,
    );

    expect(result.sources[0]?.text).toBe('');
    expect(result.sources[0]?.pointer).toContain('exo_page_read');
  });

  it('marks a page that has never been materialized as empty', async () => {
    const result = await render(
      refs({ id: 's1', kind: 'PAGE', mode: 'EMBED', documentId: emptyPageId }),
      24_000,
    );

    expect(result.sources[0]?.empty).toBe(true);
    expect(result.sources[0]?.text).toBe('');
  });

  it('drops a source whose target is outside the workspace instead of naming it', async () => {
    const other = await prisma.workspace.create({
      data: {
        name: 'Fremd',
        slug: `fremd-${Date.now().toString(36)}`,
        members: { create: { userId, role: 'OWNER' } },
      },
    });
    const foreign = await prisma.document.create({
      data: {
        workspaceId: other.id,
        title: 'Geheim',
        type: 'PAGE',
        orderKey: generateOrderKey(null, null),
        createdById: userId,
        updatedById: userId,
      },
    });

    const result = await render(
      refs({ id: 's1', kind: 'PAGE', mode: 'EMBED', documentId: foreign.id }),
      24_000,
    );

    expect(result.sources).toHaveLength(0);
    await prisma.workspace.delete({ where: { id: other.id } });
  });

  it('uses the conversation the rows hang off, so a pinned row survives a page switch', async () => {
    await prisma.aiConversationSource.create({
      data: {
        conversationId,
        kind: 'PAGE',
        mode: 'EMBED',
        documentId: shortPageId,
        targetKey: `page:${shortPageId}`,
      },
    });
    const rows = await prisma.aiConversationSource.findMany({ where: { conversationId } });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.mode).toBe('EMBED');
  });
});
