import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { WorkspaceAccessService } from '@exocortex/auth';
import { loadDotEnv } from '@exocortex/config';
import { type PostConversationMessageResponse } from '@exocortex/contracts';
import { createPrismaClient, type PrismaClient } from '@exocortex/database';
import { createLogger } from '@exocortex/logger';

import { AgentProfilesService } from '../agent-profiles/agent-profiles.service';
import { type ConversationsService } from '../ai/conversations.service';
import { AppError } from '../common/app-error';
import { OutboxService } from '../common/outbox.service';
import { type RealtimeService } from '../realtime/realtime.service';

import { type WorkItemActor } from './work-item-actor';
import { WorkItemCheckpointsService } from './work-item-checkpoints.service';
import { WorkItemDelegationService } from './work-item-delegation.service';
import { WorkItemsService } from './work-items.service';

/**
 * Delegation against the real database (issue #144, ADR-072).
 *
 * The conversation service is the same stand-in the work item suite uses: it
 * writes the run row the real one would and remembers what was posted, so
 * what is proven here is the work's side -- the budget carved and counted
 * over the subtree, the write mode held, the wait recorded, and the parent
 * carried on exactly once with the children's results.
 */
loadDotEnv();

const correlationId = 'test-correlation';

let prisma: PrismaClient;
let workItems: WorkItemsService;
let delegation: WorkItemDelegationService;
let workspaceId: string;
let ownerId: string;
const posted: { conversationId: string; content: string }[] = [];
const nextRunCost: { value: number | null } = { value: null };

const realtime = { emit: async () => undefined } as unknown as RealtimeService;
const logger = createLogger({ name: 'api-test', level: 'silent' });

function human(): WorkItemActor {
  return { kind: 'human', userId: ownerId, agentLabel: null };
}

function assistant(runId?: string): WorkItemActor {
  return { kind: 'assistant', userId: ownerId, agentLabel: null, ...(runId ? { runId } : {}) };
}

beforeAll(async () => {
  prisma = createPrismaClient({ databaseUrl: process.env.DATABASE_URL });
  const access = new WorkspaceAccessService(prisma);
  const conversations = {
    create: async (input: { userId: string; request: { workspaceId: string; title?: string } }) => {
      const conversation = await prisma.aiConversation.create({
        data: {
          workspaceId: input.request.workspaceId,
          createdById: input.userId,
          title: input.request.title ?? 'Neue Unterhaltung',
        },
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
          messages: [{ role: 'user', content: input.request.content }],
          conversationId: input.conversationId,
          workItemId: input.workItemId ?? null,
          status: 'COMPLETED',
          providerCostMicroUsd: nextRunCost.value,
        },
      });
      return {
        run: {
          id: run.id,
          status: 'completed',
          model: run.model,
          createdAt: run.createdAt.toISOString(),
        } as PostConversationMessageResponse['run'],
      };
    },
  } as unknown as ConversationsService;

  const checkpoints = new WorkItemCheckpointsService(prisma, access, realtime);
  const profiles = new AgentProfilesService(prisma, access, new OutboxService(prisma, logger));
  workItems = new WorkItemsService(prisma, access, realtime, conversations, checkpoints, profiles);
  delegation = new WorkItemDelegationService(prisma, logger, access, workItems, conversations);
  delegation.onModuleInit();

  const suffix = Date.now().toString(36);
  const owner = await prisma.user.create({
    data: { email: `wd-${suffix}@exocortex.test`, name: 'Owner', emailVerified: true },
  });
  ownerId = owner.id;
  const workspace = await prisma.workspace.create({
    data: {
      name: `Delegation ${suffix}`,
      slug: `delegation-${suffix}`,
      members: { create: { userId: ownerId, role: 'OWNER' } },
    },
  });
  workspaceId = workspace.id;
});

afterAll(async () => {
  await prisma.aiRun.deleteMany({ where: { workspaceId } });
  await prisma.workItem.deleteMany({ where: { workspaceId } });
  await prisma.agentProfile.deleteMany({ where: { workspaceId } });
  await prisma.workspace.deleteMany({ where: { id: workspaceId } });
  await prisma.user.deleteMany({ where: { id: ownerId } });
  await prisma.$disconnect();
});

async function parentItem(title: string, extra: Record<string, unknown> = {}) {
  const response = await workItems.create({
    workspaceId,
    actor: human(),
    request: { title, goal: `Ziel von ${title}`, assignee: { kind: 'assistant' }, ...extra },
    correlationId,
    mayChooseProfile: true,
  });
  return response.workItem;
}

describe('WorkItemDelegationService', () => {
  it('hands a part on as a started child and notes it in the parent history', async () => {
    const parent = await parentItem('Provider vergleichen', { budgetMicroUsd: 10_000 });
    const response = await delegation.delegate({
      parentId: parent.id,
      actor: assistant(),
      request: {
        title: 'Preise bestimmen',
        goal: 'Die Preise bestimmen.',
        expectedResult: 'Eine Tabelle mit Preisen',
      },
      correlationId,
      mayLoosen: false,
      callerWriteCeiling: 'direct',
    });

    expect(response.run).not.toBeNull();
    expect(response.workItem.parentId).toBe(parent.id);
    expect(response.workItem.status).toBe('working');
    expect(response.workItem.budgetMicroUsd).toBe(10_000);
    expect(response.workItem.acceptanceCriteria[0]?.text).toBe('Eine Tabelle mit Preisen');
    const after = await workItems.get({ workItemId: parent.id, userId: ownerId });
    const delegated = after.workItem.events.find((event) => event.kind === 'delegated');
    expect(delegated?.data.childId).toBe(response.workItem.id);
    expect(after.workItem.childProgress).toMatchObject({ total: 1, open: 1 });
  });

  it('counts what the children spend against the parent and refuses once it is gone', async () => {
    const parent = await parentItem('Mit Budget', { budgetMicroUsd: 5_000 });
    const delegate = (title: string, budgetMicroUsd?: number) =>
      delegation.delegate({
        parentId: parent.id,
        actor: assistant(),
        request: { title, goal: `${title}.`, writeMode: 'propose', budgetMicroUsd },
        correlationId,
        mayLoosen: false,
        callerWriteCeiling: 'direct',
      });

    nextRunCost.value = 3_000;
    const first = await delegate('Teil eins', 5_000);
    expect(first.workItem.budgetMicroUsd).toBe(5_000);
    nextRunCost.value = 1_000;
    // Carved out of what was left after the first child's run.
    const second = await delegate('Teil zwei', 4_000);
    expect(second.workItem.budgetMicroUsd).toBe(2_000);
    nextRunCost.value = null;

    const standing = await workItems.get({ workItemId: parent.id, userId: ownerId });
    expect(standing.workItem.subtreeSpentMicroUsd).toBe(4_000);
    expect(standing.workItem.budgetRemainingMicroUsd).toBe(1_000);
    // The first child's own budget has 2 000 left; its parent's has less.
    const firstNow = await workItems.get({ workItemId: first.workItem.id, userId: ownerId });
    expect(firstNow.workItem.budgetRemainingMicroUsd).toBe(1_000);
    expect(firstNow.workItem.budgetLimitedBy?.id).toBe(parent.id);

    await prisma.aiRun.create({
      data: {
        workspaceId,
        createdById: ownerId,
        provider: 'mock',
        model: 'mock/model',
        messages: [],
        workItemId: parent.id,
        status: 'COMPLETED',
        providerCostMicroUsd: 1_000,
      },
    });
    await expect(delegate('Teil drei')).rejects.toMatchObject({
      code: 'work_item_budget_exhausted',
    });
    await expect(
      workItems.startRun({
        workItemId: first.workItem.id,
        actor: human(),
        request: {},
        correlationId,
      }),
    ).rejects.toMatchObject({ code: 'work_item_budget_exhausted' });
  });

  it('holds a child to the stricter of the parent, the request and the caller', async () => {
    const parent = await parentItem('Vorsichtig', { writeMode: 'propose' });
    const loose = await delegation.delegate({
      parentId: parent.id,
      actor: assistant(),
      request: { title: 'Direkt', goal: 'Direkt schreiben.', writeMode: 'direct', start: false },
      correlationId,
      mayLoosen: false,
      callerWriteCeiling: 'direct',
    });
    expect(loose.workItem.writeMode).toBe('propose');

    const open = await parentItem('Offen');
    const capped = await delegation.delegate({
      parentId: open.id,
      actor: assistant(),
      request: { title: 'Gedeckelt', goal: 'Vom Aufrufer gedeckelt.', start: false },
      correlationId,
      mayLoosen: false,
      callerWriteCeiling: 'read_only',
    });
    expect(capped.workItem.writeMode).toBe('read_only');
  });

  it('lets an agent pick a narrower profile for a child but not a looser one', async () => {
    const strict = await prisma.agentProfile.create({
      data: { workspaceId, name: 'Streng', toolDomains: ['pages', 'web'], writeMode: 'PROPOSE' },
    });
    const narrower = await prisma.agentProfile.create({
      data: { workspaceId, name: 'Enger', toolDomains: ['web'], writeMode: 'READ_ONLY' },
    });
    const looser = await prisma.agentProfile.create({
      data: { workspaceId, name: 'Weiter', writeMode: 'DIRECT' },
    });
    const parent = await parentItem('Unter Profil', { agentProfileId: strict.id });

    const ok = await delegation.delegate({
      parentId: parent.id,
      actor: assistant(),
      request: {
        title: 'Recherche',
        goal: 'Nur lesen.',
        agentProfileId: narrower.id,
        start: false,
      },
      correlationId,
      mayLoosen: false,
      callerWriteCeiling: 'direct',
    });
    expect(ok.workItem.agentProfile?.id).toBe(narrower.id);

    await expect(
      delegation.delegate({
        parentId: parent.id,
        actor: assistant(),
        request: { title: 'Mehr', goal: 'Mehr dürfen.', agentProfileId: looser.id, start: false },
        correlationId,
        mayLoosen: false,
        callerWriteCeiling: 'direct',
      }),
    ).rejects.toBeInstanceOf(AppError);
  });

  it('runs directly writing siblings one after another and proposing ones together', async () => {
    const parent = await parentItem('Geschwister');
    await prisma.workItem.create({
      data: {
        workspaceId,
        title: 'Läuft schon',
        goal: 'Schreibt.',
        requesterKind: 'HUMAN',
        requesterId: ownerId,
        assigneeKind: 'ASSISTANT',
        parentId: parent.id,
        status: 'WORKING',
        runs: {
          create: {
            workspaceId,
            createdById: ownerId,
            provider: 'mock',
            model: 'mock/model',
            messages: [],
            status: 'RUNNING',
          },
        },
      },
    });
    const direct = await delegation.delegate({
      parentId: parent.id,
      actor: assistant(),
      request: { title: 'Auch direkt', goal: 'Schreibt auch.' },
      correlationId,
      mayLoosen: false,
      callerWriteCeiling: 'direct',
    });
    expect(direct.run).toBeNull();
    expect(direct.startRefused).toBe('work_item_sibling_writing');

    const proposing = await delegation.delegate({
      parentId: parent.id,
      actor: assistant(),
      request: { title: 'Schlägt vor', goal: 'Schlägt vor.', writeMode: 'propose' },
      correlationId,
      mayLoosen: false,
      callerWriteCeiling: 'direct',
    });
    expect(proposing.run).not.toBeNull();
  });

  it('waits for the children and carries the paused run on once, with their results', async () => {
    const parent = await parentItem('Synthese');
    const conversation = await prisma.aiConversation.create({
      data: { workspaceId, createdById: ownerId, title: 'Elternlauf' },
    });
    const pausedRun = await prisma.aiRun.create({
      data: {
        workspaceId,
        createdById: ownerId,
        provider: 'mock',
        model: 'mock/model',
        messages: [],
        conversationId: conversation.id,
        workItemId: parent.id,
        status: 'COMPLETED',
      },
    });
    const a = await delegation.delegate({
      parentId: parent.id,
      actor: assistant(pausedRun.id),
      request: { title: 'Teil A', goal: 'A.', writeMode: 'propose' },
      correlationId,
      mayLoosen: false,
      callerWriteCeiling: 'direct',
    });
    const b = await delegation.delegate({
      parentId: parent.id,
      actor: assistant(pausedRun.id),
      request: { title: 'Teil B', goal: 'B.', writeMode: 'propose' },
      correlationId,
      mayLoosen: false,
      callerWriteCeiling: 'direct',
    });

    const waiting = await delegation.awaitChildren({
      workItemId: parent.id,
      actor: assistant(pausedRun.id),
      request: {},
      correlationId,
    });
    expect(waiting.waiting).toBe(true);
    expect(waiting.awaiting?.pendingChildIds.toSorted()).toEqual(
      [a.workItem.id, b.workItem.id].toSorted(),
    );

    await expect(
      workItems.update({
        workItemId: parent.id,
        actor: human(),
        request: { status: 'done' },
        correlationId,
      }),
    ).rejects.toMatchObject({ code: 'work_item_children_open' });

    const before = posted.length;
    await workItems.update({
      workItemId: a.workItem.id,
      actor: assistant(),
      request: { status: 'review', result: 'Ergebnis A' },
      correlationId,
    });
    expect(posted.length).toBe(before);

    await workItems.update({
      workItemId: b.workItem.id,
      actor: assistant(),
      request: { status: 'failed', statusReason: 'Quelle fehlt' },
      correlationId,
    });
    const resumes = posted
      .slice(before)
      .filter((entry) => entry.conversationId === conversation.id);
    expect(resumes).toHaveLength(1);
    expect(resumes[0]?.content).toContain('Ergebnis A');
    expect(resumes[0]?.content).toContain('Quelle fehlt');

    const after = await workItems.get({ workItemId: parent.id, userId: ownerId });
    expect(after.workItem.awaiting).toBeNull();
    expect(after.workItem.events.some((event) => event.kind === 'children_returned')).toBe(true);
    expect(after.workItem.childProgress).toMatchObject({ review: 1, failed: 1 });

    const results = await delegation.childResults({
      workItemId: parent.id,
      userId: ownerId,
      query: { childIds: [a.workItem.id], maxChars: 200 },
    });
    expect(results.children).toHaveLength(1);
    expect(results.children[0]?.returned).toBe(true);
  });

  it('answers at once when nothing is left to wait for', async () => {
    const parent = await parentItem('Schon zurück');
    const child = await delegation.delegate({
      parentId: parent.id,
      actor: assistant(),
      request: { title: 'Fertig', goal: 'Fertig.', start: false },
      correlationId,
      mayLoosen: false,
      callerWriteCeiling: 'direct',
    });
    await workItems.update({
      workItemId: child.workItem.id,
      actor: human(),
      request: { status: 'done', result: 'Erledigt' },
      correlationId,
    });
    const response = await delegation.awaitChildren({
      workItemId: parent.id,
      actor: assistant(),
      request: { childIds: [child.workItem.id] },
      correlationId,
    });
    expect(response.waiting).toBe(false);
    expect(response.results[0]?.result).toBe('Erledigt');
  });
});
