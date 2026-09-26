import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { WorkspaceAccessService } from '@exocortex/auth';
import { type ApiEnv, loadDotEnv } from '@exocortex/config';
import { type ChangesetResponse, type PostConversationMessageResponse } from '@exocortex/contracts';
import { createPrismaClient, type PrismaClient } from '@exocortex/database';
import { serializeMarkdown, yjsStateToProseMirrorJson } from '@exocortex/editor';
import { createLogger, type Logger } from '@exocortex/logger';
import { QueueRegistry, testQueuePrefix } from '@exocortex/queue';
import { type ObjectStorage } from '@exocortex/storage';

import { type ConversationsService } from '../ai/conversations.service';
import { AppError } from '../common/app-error';
import { OutboxService } from '../common/outbox.service';
import { type CollaborationBridgeService } from '../documents/collaboration-bridge.service';
import { DocumentContentService } from '../documents/document-content.service';
import { DocumentEditService } from '../documents/document-edit.service';
import { DocumentMoveService } from '../documents/document-move.service';
import { DocumentTrashService } from '../documents/document-trash.service';
import { DocumentWriteCommitService } from '../documents/document-write-commit.service';
import { DocumentsService } from '../documents/documents.service';
import { PageLinkIdentityService } from '../documents/page-link-identity.service';
import { settingsStub } from '../platform/settings.test-support';
import { type RealtimeService } from '../realtime/realtime.service';
import { type WorkItemActor } from '../work-items/work-item-actor';
import { WorkItemCheckpointsService } from '../work-items/work-item-checkpoints.service';
import { WorkItemQuestionsService } from '../work-items/work-item-questions.service';
import { WorkItemResumeService } from '../work-items/work-item-resume.service';
import { WorkItemsService } from '../work-items/work-items.service';

import { ChangesetApplyService } from './changeset-apply.service';
import { ChangesetProposalService } from './changeset-proposal.service';
import { ChangesetReviewService } from './changeset-review.service';
import { ChangesetsService } from './changesets.service';

/**
 * Proposed changes against the real database (issue #141, ADR-070).
 *
 * The page writes are the real services, so what is proven is the promise
 * the feature makes: nothing reaches a page until a person applies it, an
 * apply is the ordinary write with its snapshot, and a page that moved is
 * never written from a proposal made on an older state.
 */
loadDotEnv();

const logger: Logger = createLogger({ name: 'api-test', level: 'silent' });
const correlationId = 'test-correlation';
const ENV = { APP_URL: 'https://exocortex.test' } as unknown as ApiEnv;

let prisma: PrismaClient;
let queues: QueueRegistry;
let service: ChangesetsService;
let content: DocumentContentService;
let workspaceId: string;
let ownerId: string;
let memberId: string;
let strangerId: string;
let pageId: string;

const emitted: string[] = [];
const realtime = {
  emit: async (type: string) => {
    emitted.push(type);
  },
} as unknown as RealtimeService;
const collaboration = {
  applyToLiveSession: async () => ({
    applied: false,
    clientsCount: 0,
    yjsUpdatedAt: null,
    reachable: true,
  }),
} as unknown as CollaborationBridgeService;
const storage = { deleteObject: async () => undefined } as unknown as ObjectStorage;

const posted: { conversationId: string; content: string }[] = [];

function human(userId: string): WorkItemActor {
  return { kind: 'human', userId, agentLabel: null };
}

async function markdownOf(documentId: string): Promise<string> {
  const row = await prisma.documentContent.findUniqueOrThrow({
    where: { documentId },
    select: { yjsState: true },
  });
  return serializeMarkdown(yjsStateToProseMirrorJson(row.yjsState));
}

async function revisionOf(documentId: string): Promise<string> {
  const row = await prisma.documentContent.findUniqueOrThrow({
    where: { documentId },
    select: { yjsUpdatedAt: true },
  });
  return row.yjsUpdatedAt.toISOString();
}

async function pageWith(markdown: string): Promise<string> {
  const page = await prisma.document.create({
    data: {
      workspaceId,
      title: `Seite ${Math.random().toString(36).slice(2, 7)}`,
      orderKey: `a${Math.random().toString(36).slice(2, 7)}`,
      createdById: ownerId,
      updatedById: ownerId,
      content: { create: { yjsState: new Uint8Array() } },
    },
  });
  await content.write({
    documentId: page.id,
    userId: ownerId,
    request: { markdown, mode: 'replace' },
    correlationId,
    source: 'api',
    growth: 'exempt',
  });
  return page.id;
}

beforeAll(async () => {
  prisma = createPrismaClient({ databaseUrl: process.env.DATABASE_URL });
  queues = new QueueRegistry({
    redisUrl: process.env.REDIS_URL ?? 'redis://127.0.0.1:6380',
    logger,
    prefix: testQueuePrefix('api-changesets'),
  });
  const access = new WorkspaceAccessService(prisma);
  const outbox = new OutboxService(prisma, logger);
  const commits = () =>
    new DocumentWriteCommitService(prisma, queues, logger, outbox, realtime, collaboration);
  content = new DocumentContentService(
    prisma,
    logger,
    ENV,
    access,
    commits(),
    new PageLinkIdentityService(prisma),
    settingsStub(),
  );
  const edits = new DocumentEditService(
    prisma,
    logger,
    ENV,
    access,
    commits(),
    new PageLinkIdentityService(prisma),
    settingsStub(),
  );
  const trash = new DocumentTrashService(prisma, queues, logger, storage, access, outbox, realtime);
  const documents = new DocumentsService(
    prisma,
    queues,
    logger,
    storage,
    access,
    outbox,
    realtime,
    trash,
    new DocumentMoveService(prisma, queues, logger, access, outbox, realtime),
  );

  const conversations = {
    create: async (input: { userId: string; request: { workspaceId: string } }) => {
      const conversation = await prisma.aiConversation.create({
        data: { workspaceId: input.request.workspaceId, createdById: input.userId, title: 'T' },
      });
      return { conversation: { id: conversation.id } };
    },
    postMessage: async (input: {
      conversationId: string;
      userId: string;
      workItemId?: string;
      request: { content: string };
    }): Promise<Pick<PostConversationMessageResponse, 'run'>> => {
      posted.push({ conversationId: input.conversationId, content: input.request.content });
      const run = await prisma.aiRun.create({
        data: {
          workspaceId,
          createdById: input.userId,
          provider: 'mock',
          model: 'mock/model',
          messages: [],
          conversationId: input.conversationId,
          workItemId: input.workItemId ?? null,
          status: 'PENDING',
        },
      });
      return {
        run: {
          id: run.id,
          status: 'pending',
          model: run.model,
          createdAt: run.createdAt.toISOString(),
        } as PostConversationMessageResponse['run'],
      };
    },
  } as unknown as ConversationsService;
  const checkpoints = new WorkItemCheckpointsService(prisma, access, realtime);
  const workItems = new WorkItemsService(prisma, access, realtime, conversations, checkpoints);
  const questions = new WorkItemQuestionsService(prisma, workItems);
  const resume = new WorkItemResumeService(prisma, workItems, conversations);

  service = new ChangesetsService(
    prisma,
    access,
    realtime,
    new ChangesetProposalService(access, edits, content),
    new ChangesetApplyService(prisma, logger, edits, content, documents),
    new ChangesetReviewService(prisma, realtime, workItems, questions, resume),
  );

  const suffix = Date.now().toString(36);
  const [owner, member, stranger] = await Promise.all(
    ['owner', 'member', 'stranger'].map((name) =>
      prisma.user.create({
        data: { email: `cs-${name}-${suffix}@exocortex.test`, name, emailVerified: true },
      }),
    ),
  );
  ownerId = owner!.id;
  memberId = member!.id;
  strangerId = stranger!.id;
  const workspace = await prisma.workspace.create({
    data: {
      name: `Changesets ${suffix}`,
      slug: `changesets-${suffix}`,
      members: {
        create: [
          { userId: ownerId, role: 'OWNER' },
          { userId: memberId, role: 'MEMBER' },
        ],
      },
    },
  });
  workspaceId = workspace.id;
  pageId = await pageWith('# Plan\n\nErster Absatz.\n\n## Ziele\n\nAlt.\n\n## Rest\n\nBleibt.');
});

afterAll(async () => {
  await prisma.workspace.deleteMany({ where: { id: workspaceId } });
  await prisma.user.deleteMany({ where: { id: { in: [ownerId, memberId, strangerId] } } });
  await queues.close();
  await prisma.$disconnect();
});

describe('proposing', () => {
  it('stores the change with its diff and leaves the page untouched', async () => {
    const before = await markdownOf(pageId);
    const created = (await service.create({
      workspaceId,
      actor: human(memberId),
      request: {
        title: 'Ziele schärfen',
        change: {
          kind: 'section',
          documentId: pageId,
          heading: 'Ziele',
          markdown: 'Neu und klar.',
          mode: 'replace',
        },
      },
      correlationId,
    })) as ChangesetResponse & { changeId: string };

    expect(created.changeset.status).toBe('draft');
    expect(created.changeId).toBeDefined();
    const [change] = created.changeset.changes;
    expect(change?.kind).toBe('section');
    expect(change?.applicable).toBe(true);
    expect((change?.diff.summary.changed ?? 0) + (change?.diff.summary.added ?? 0)).toBeGreaterThan(
      0,
    );
    expect(JSON.stringify(change?.diff.blocks)).toContain('Neu und klar.');
    expect(await markdownOf(pageId)).toBe(before);
  });

  it('refuses a change that does not resolve, and keeps no empty draft', async () => {
    const count = await prisma.changeset.count({ where: { workspaceId } });
    await expect(
      service.create({
        workspaceId,
        actor: human(memberId),
        request: {
          title: 'Kaputt',
          change: {
            kind: 'section',
            documentId: pageId,
            heading: 'Gibt es nicht',
            markdown: 'x',
            mode: 'replace',
          },
        },
        correlationId,
      }),
    ).rejects.toMatchObject({ code: 'document_heading_not_found' });
    expect(await prisma.changeset.count({ where: { workspaceId } })).toBe(count);
  });

  it('refuses a stranger and a revision that is already stale', async () => {
    await expect(
      service.create({
        workspaceId,
        actor: human(strangerId),
        request: { title: 'x' },
        correlationId,
      }),
    ).rejects.toBeDefined();
    await expect(
      service.create({
        workspaceId,
        actor: human(memberId),
        request: {
          title: 'Alt gelesen',
          change: {
            kind: 'patch',
            documentId: pageId,
            oldText: 'Bleibt.',
            newText: 'Bleibt nicht.',
            replaceAll: false,
            expectedYjsUpdatedAt: '2020-01-01T00:00:00.000Z',
          },
        },
        correlationId,
      }),
    ).rejects.toMatchObject({ code: 'document_content_conflict' });
  });

  it('only lets the proposer shape a draft, and freezes it once handed in', async () => {
    const created = await service.create({
      workspaceId,
      actor: human(memberId),
      request: { title: 'Leer' },
      correlationId,
    });
    const id = created.changeset.id;
    await expect(
      service.submit({ changesetId: id, actor: human(memberId), request: {}, correlationId }),
    ).rejects.toMatchObject({ code: 'changeset_empty' });
    await expect(
      service.addChange({
        changesetId: id,
        actor: human(ownerId),
        change: { kind: 'create', title: 'Neu', markdown: 'Text' },
        correlationId,
      }),
    ).rejects.toBeInstanceOf(AppError);
    await service.addChange({
      changesetId: id,
      actor: human(memberId),
      change: { kind: 'create', title: 'Neu', markdown: 'Text' },
      correlationId,
    });
    await service.submit({ changesetId: id, actor: human(memberId), request: {}, correlationId });
    await expect(
      service.addChange({
        changesetId: id,
        actor: human(memberId),
        change: { kind: 'create', title: 'Noch', markdown: 'Text' },
        correlationId,
      }),
    ).rejects.toMatchObject({ code: 'changeset_not_draft' });
  });
});

describe('deciding', () => {
  it('applies chosen changes through the ordinary write, and the rest stay pending', async () => {
    const page = await pageWith('## Eins\n\nA.\n\n## Zwei\n\nB.');
    const created = await service.create({
      workspaceId,
      actor: human(memberId),
      request: {
        title: 'Zwei Stellen',
        change: {
          kind: 'patch',
          documentId: page,
          oldText: 'A.',
          newText: 'A2.',
          replaceAll: false,
        },
      },
      correlationId,
    });
    const id = created.changeset.id;
    const second = await service.addChange({
      changesetId: id,
      actor: human(memberId),
      change: {
        kind: 'section',
        documentId: page,
        heading: 'Zwei',
        markdown: 'B2.',
        mode: 'replace',
      },
      correlationId,
    });
    const submitted = await service.submit({
      changesetId: id,
      actor: human(memberId),
      request: {},
      correlationId,
    });
    expect(submitted.changeset.status).toBe('ready');
    expect(submitted.changeset.attentionItemId).not.toBeNull();
    const firstId = submitted.changeset.changes[0]!.id;

    const decided = await service.apply({
      changesetId: id,
      actor: human(ownerId),
      request: { changeIds: [firstId] },
      correlationId,
    });
    expect(decided.outcomes).toEqual([
      expect.objectContaining({ changeId: firstId, outcome: 'applied' }),
    ]);
    expect(decided.changeset.status).toBe('partially_applied');
    const applied = decided.changeset.changes.find((change) => change.id === firstId)!;
    expect(applied.snapshotId).not.toBeNull();
    expect(applied.decidedBy?.userId).toBe(ownerId);
    // The sibling on the same page is not stale from the set's own write.
    const sibling = decided.changeset.changes.find((change) => change.id === second.changeId)!;
    expect(sibling.applicable).toBe(true);
    expect(await markdownOf(page)).toContain('A2.');
    expect(await markdownOf(page)).toContain('B.');

    const rest = await service.apply({
      changesetId: id,
      actor: human(ownerId),
      request: {},
      correlationId,
    });
    expect(rest.changeset.status).toBe('applied');
    expect(rest.changeset.closedAt).not.toBeNull();
    expect(await markdownOf(page)).toContain('B2.');

    const item = await prisma.attentionItem.findUniqueOrThrow({
      where: { id: submitted.changeset.attentionItemId! },
    });
    expect(item.status).toBe('RESOLVED');
    await expect(
      service.apply({ changesetId: id, actor: human(ownerId), request: {}, correlationId }),
    ).rejects.toMatchObject({ code: 'changeset_closed' });
  });

  it('never applies a change whose page moved, and marks it stale', async () => {
    const page = await pageWith('Absatz eins.\n\nAbsatz zwei.');
    const created = await service.create({
      workspaceId,
      actor: human(memberId),
      request: {
        title: 'Veraltet',
        change: {
          kind: 'patch',
          documentId: page,
          oldText: 'Absatz zwei.',
          newText: 'Absatz 2.',
          replaceAll: false,
        },
      },
      correlationId,
    });
    await service.submit({
      changesetId: created.changeset.id,
      actor: human(memberId),
      request: {},
      correlationId,
    });
    // Somebody else writes the page meanwhile.
    await content.write({
      documentId: page,
      userId: ownerId,
      request: { markdown: 'Nachtrag.', mode: 'append' },
      correlationId,
      source: 'api',
      growth: 'exempt',
    });
    const read = await service.get({ changesetId: created.changeset.id, userId: ownerId });
    expect(read.changeset.changes[0]?.applicable).toBe(false);

    const revision = await revisionOf(page);
    const decided = await service.apply({
      changesetId: created.changeset.id,
      actor: human(ownerId),
      request: {},
      correlationId,
    });
    expect(decided.outcomes[0]).toMatchObject({
      outcome: 'stale',
      errorCode: 'document_content_conflict',
    });
    expect(decided.changeset.status).toBe('stale');
    expect(await revisionOf(page)).toBe(revision);
    expect(await markdownOf(page)).toContain('Absatz zwei.');
  });

  it('rejects with a note, and a person may not decide a draft', async () => {
    const created = await service.create({
      workspaceId,
      actor: human(memberId),
      request: { title: 'Neue Seite', change: { kind: 'create', title: 'Idee', markdown: 'Hm.' } },
      correlationId,
    });
    await expect(
      service.reject({
        changesetId: created.changeset.id,
        actor: human(ownerId),
        request: {},
        correlationId,
      }),
    ).rejects.toMatchObject({ code: 'changeset_not_draft' });
    await service.submit({
      changesetId: created.changeset.id,
      actor: human(memberId),
      request: {},
      correlationId,
    });
    const rejected = await service.reject({
      changesetId: created.changeset.id,
      actor: human(ownerId),
      request: { note: 'Passt nicht hierher' },
      correlationId,
    });
    expect(rejected.changeset.status).toBe('rejected');
    expect(rejected.changeset.changes[0]?.decisionNote).toBe('Passt nicht hierher');
    expect(await prisma.document.count({ where: { workspaceId, title: 'Idee' } })).toBe(0);
  });

  it('applies a new page', async () => {
    const created = await service.create({
      workspaceId,
      actor: human(memberId),
      request: {
        title: 'Neue Seite',
        change: { kind: 'create', parentId: pageId, title: 'Kind', markdown: 'Inhalt hier.' },
      },
      correlationId,
    });
    await service.submit({
      changesetId: created.changeset.id,
      actor: human(memberId),
      request: {},
      correlationId,
    });
    const decided = await service.apply({
      changesetId: created.changeset.id,
      actor: human(ownerId),
      request: {},
      correlationId,
    });
    const change = decided.changeset.changes[0]!;
    expect(change.status).toBe('applied');
    expect(change.createdDocumentId).not.toBeNull();
    const child = await prisma.document.findUniqueOrThrow({
      where: { id: change.createdDocumentId! },
    });
    expect(child.parentId).toBe(pageId);
    expect(await markdownOf(child.id)).toContain('Inhalt hier.');
  });
});

describe('review on a work item', () => {
  it('moves the work into review, and the decision sends it back to working', async () => {
    const work = await prisma.workItem.create({
      data: {
        workspaceId,
        title: 'Plan überarbeiten',
        goal: 'Besser',
        requesterKind: 'HUMAN',
        requesterId: ownerId,
        assigneeKind: 'HUMAN',
        assigneeId: memberId,
        status: 'WORKING',
      },
    });
    const page = await pageWith('Text.');
    const created = await service.create({
      workspaceId,
      actor: human(memberId),
      request: {
        title: 'Vorschlag',
        workItemId: work.id,
        change: { kind: 'page', documentId: page, markdown: 'Neuer Text.', mode: 'replace' },
      },
      correlationId,
    });
    const submitted = await service.submit({
      changesetId: created.changeset.id,
      actor: human(memberId),
      request: { context: 'Bitte ansehen' },
      correlationId,
    });
    const inReview = await prisma.workItem.findUniqueOrThrow({ where: { id: work.id } });
    expect(inReview.status).toBe('REVIEW');
    const review = await prisma.attentionItem.findUniqueOrThrow({
      where: { id: submitted.changeset.attentionItemId! },
    });
    expect(review.kind).toBe('REVIEW');
    expect(review.subject).toMatchObject({ kind: 'changeset', changesetId: created.changeset.id });

    await service.reject({
      changesetId: created.changeset.id,
      actor: human(ownerId),
      request: { note: 'Noch nicht' },
      correlationId,
    });
    const after = await prisma.workItem.findUniqueOrThrow({ where: { id: work.id } });
    expect(after.status).toBe('WORKING');
    const settled = await prisma.attentionItem.findUniqueOrThrow({ where: { id: review.id } });
    expect(settled.status).toBe('RESOLVED');
    expect(JSON.stringify(settled.resolution)).toContain('0 übernommen, 1 abgelehnt');
    expect(JSON.stringify(settled.resolution)).toContain('Noch nicht');
  });
});
