import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AuthorizationError, WorkspaceAccessService } from '@exocortex/auth';
import { loadDotEnv } from '@exocortex/config';
import { type PostConversationMessageResponse } from '@exocortex/contracts';
import { createPrismaClient, type PrismaClient } from '@exocortex/database';

import { type ConversationsService } from '../ai/conversations.service';
import { AppError } from '../common/app-error';
import { type RealtimeService } from '../realtime/realtime.service';

import { type WorkItemActor } from './work-item-actor';
import { WorkItemsService } from './work-items.service';

/**
 * Work items against the real database (issue #138, ADR-066).
 *
 * The conversation service is replaced by a stand-in that writes the run row
 * the real one would, tagged with the item, and enqueues nothing: what is
 * proven here is the item's side -- that runs hang on it, that the budget is
 * counted from them, that the history is written with every change -- not the
 * chat, which has its own suite.
 */
loadDotEnv();

const correlationId = 'test-correlation';

let prisma: PrismaClient;
let service: WorkItemsService;
let workspaceId: string;
let otherWorkspaceId: string;
let ownerId: string;
let guestId: string;
let strangerId: string;
let pageId: string;
let foreignPageId: string;
const nextRunCost: { value: number | null } = { value: null };

const realtime = { emit: async () => undefined } as unknown as RealtimeService;

function human(userId: string): WorkItemActor {
  return { kind: 'human', userId, agentLabel: null };
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

  service = new WorkItemsService(prisma, access, realtime, conversations);

  const suffix = Date.now().toString(36);
  const owner = await prisma.user.create({
    data: { email: `wi-${suffix}@exocortex.test`, name: 'Owner', emailVerified: true },
  });
  ownerId = owner.id;
  const guest = await prisma.user.create({
    data: { email: `wi-guest-${suffix}@exocortex.test`, name: 'Guest', emailVerified: true },
  });
  guestId = guest.id;
  const stranger = await prisma.user.create({
    data: { email: `wi-out-${suffix}@exocortex.test`, name: 'Stranger', emailVerified: true },
  });
  strangerId = stranger.id;

  const workspace = await prisma.workspace.create({
    data: {
      name: `Work items ${suffix}`,
      slug: `work-items-${suffix}`,
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
      name: `Work items other ${suffix}`,
      slug: `work-items-other-${suffix}`,
      members: { create: { userId: ownerId, role: 'OWNER' } },
    },
  });
  otherWorkspaceId = other.id;

  const page = await prisma.document.create({
    data: {
      workspaceId,
      title: 'Kontext',
      orderKey: 'a0',
      createdById: ownerId,
      updatedById: ownerId,
    },
  });
  pageId = page.id;
  const foreign = await prisma.document.create({
    data: {
      workspaceId: otherWorkspaceId,
      title: 'Fremd',
      orderKey: 'a0',
      createdById: ownerId,
      updatedById: ownerId,
    },
  });
  foreignPageId = foreign.id;
});

afterAll(async () => {
  await prisma.aiRun.deleteMany({ where: { workspaceId } });
  await prisma.workItem.deleteMany({
    where: { workspaceId: { in: [workspaceId, otherWorkspaceId] } },
  });
  await prisma.workspace.deleteMany({ where: { id: { in: [workspaceId, otherWorkspaceId] } } });
  await prisma.user.deleteMany({ where: { id: { in: [ownerId, guestId, strangerId] } } });
  await prisma.$disconnect();
});

async function createItem(title: string, extra: Record<string, unknown> = {}) {
  const response = await service.create({
    workspaceId,
    actor: human(ownerId),
    request: { title, goal: `Ziel von ${title}`, ...extra },
    correlationId,
  });
  return response.workItem;
}

describe('WorkItemsService', () => {
  it('creates an item with its requester, criteria, context and a history', async () => {
    const item = await createItem('Recherche', {
      acceptanceCriteria: [{ text: 'Drei Quellen', met: false }],
      contextDocumentIds: [pageId],
      assignee: { kind: 'human', userId: guestId },
    });

    expect(item.status).toBe('queued');
    expect(item.requester).toEqual({ kind: 'human', userId: ownerId, name: 'Owner' });
    expect(item.assignee).toEqual({ kind: 'human', userId: guestId, name: 'Guest' });
    expect(item.criteriaTotal).toBe(1);
    expect(item.contextRefs).toEqual([{ documentId: pageId, title: 'Kontext' }]);
    expect(item.events.map((event) => event.kind).toSorted()).toEqual(['assigned', 'created']);
  });

  it('refuses a context page from another workspace and an assignee who is no member', async () => {
    await expect(
      createItem('Fremde Seite', { contextDocumentIds: [foreignPageId] }),
    ).rejects.toMatchObject({ code: 'work_item_ref_invalid' });
    await expect(
      createItem('Fremde Person', { assignee: { kind: 'human', userId: strangerId } }),
    ).rejects.toMatchObject({ code: 'work_item_assignee_invalid' });
  });

  it('closes on done, records the transition and reopens when moved back', async () => {
    const item = await createItem('Abschluss');
    const done = await service.update({
      workItemId: item.id,
      actor: human(ownerId),
      request: { status: 'done', result: 'Erledigt.' },
      correlationId,
    });
    expect(done.workItem.closedAt).not.toBeNull();
    expect(done.workItem.result).toBe('Erledigt.');
    const transition = done.workItem.events.find((event) => event.kind === 'status_changed');
    expect(transition?.data).toMatchObject({ from: 'queued', to: 'done' });
    expect(done.workItem.events.some((event) => event.kind === 'result_recorded')).toBe(true);

    const reopened = await service.update({
      workItemId: item.id,
      actor: human(ownerId),
      request: { status: 'working' },
      correlationId,
    });
    expect(reopened.workItem.closedAt).toBeNull();
  });

  it('lets the assignee move work along but not rewrite it', async () => {
    const item = await createItem('Für den Gast', { assignee: { kind: 'human', userId: guestId } });
    const moved = await service.update({
      workItemId: item.id,
      actor: human(guestId),
      request: { status: 'waiting_for_human', statusReason: 'Brauche Zugang' },
      correlationId,
    });
    expect(moved.workItem.statusReason).toBe('Brauche Zugang');

    await expect(
      service.update({
        workItemId: item.id,
        actor: human(guestId),
        request: { title: 'Anders' },
        correlationId,
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

  it('hides an item from somebody outside the workspace', async () => {
    const item = await createItem('Geheim');
    await expect(service.get({ workItemId: item.id, userId: strangerId })).rejects.toBeInstanceOf(
      AppError,
    );
  });

  it('refuses a parent below the item and one from another workspace', async () => {
    const parent = await createItem('Eltern');
    const child = await createItem('Kind', { parentId: parent.id });
    expect(child.parentId).toBe(parent.id);

    await expect(
      service.update({
        workItemId: parent.id,
        actor: human(ownerId),
        request: { parentId: child.id },
        correlationId,
      }),
    ).rejects.toMatchObject({ code: 'work_item_parent_invalid' });

    const foreign = await service.create({
      workspaceId: otherWorkspaceId,
      actor: human(ownerId),
      request: { title: 'Anderswo', goal: 'x' },
      correlationId,
    });
    await expect(
      service.update({
        workItemId: child.id,
        actor: human(ownerId),
        request: { parentId: foreign.workItem.id },
        correlationId,
      }),
    ).rejects.toMatchObject({ code: 'work_item_parent_invalid' });

    const detail = await service.get({ workItemId: parent.id, userId: ownerId });
    expect(detail.workItem.children.map((entry) => entry.id)).toEqual([child.id]);
  });

  it('links runs, assigns the assistant, starts working and stops at the budget', async () => {
    const item = await createItem('Mit Budget', { budgetMicroUsd: 1_000 });

    nextRunCost.value = 1_500;
    const started = await service.startRun({
      workItemId: item.id,
      actor: human(ownerId),
      request: { instructions: 'Kurz halten' },
      correlationId,
    });
    expect(started.workItem.runs.map((run) => run.id)).toEqual([started.run.id]);
    expect(started.workItem.assignee?.kind).toBe('assistant');
    expect(started.workItem.status).toBe('working');
    expect(started.workItem.spentMicroUsd).toBe(1_500);

    const conversationMessage = await prisma.aiRun.findUniqueOrThrow({
      where: { id: started.run.id },
      select: { messages: true },
    });
    expect(JSON.stringify(conversationMessage.messages)).toContain(item.id);

    await expect(
      service.startRun({ workItemId: item.id, actor: human(ownerId), request: {}, correlationId }),
    ).rejects.toMatchObject({ code: 'work_item_budget_exhausted' });
  });

  it('refuses a run on a closed item', async () => {
    const item = await createItem('Zu');
    await service.update({
      workItemId: item.id,
      actor: human(ownerId),
      request: { status: 'cancelled' },
      correlationId,
    });
    await expect(
      service.startRun({ workItemId: item.id, actor: human(ownerId), request: {}, correlationId }),
    ).rejects.toMatchObject({ code: 'work_item_closed' });
  });

  it('records a note and an agent as the actor', async () => {
    const item = await createItem('Notiz');
    const noted = await service.addNote({
      workItemId: item.id,
      actor: { kind: 'agent', userId: ownerId, agentLabel: 'claude-code' },
      request: { note: 'Halb fertig' },
      correlationId,
    });
    const note = noted.workItem.events.find((event) => event.kind === 'note');
    expect(note).toMatchObject({ note: 'Halb fertig', agentLabel: 'claude-code' });
    expect(note?.actor.kind).toBe('agent');
  });

  it('filters the list and keeps closed work out by default', async () => {
    const open = await createItem('Offen für mich', {
      assignee: { kind: 'human', userId: ownerId },
    });
    const closed = await createItem('Geschlossen für mich', {
      assignee: { kind: 'human', userId: ownerId },
    });
    await service.update({
      workItemId: closed.id,
      actor: human(ownerId),
      request: { status: 'done' },
      correlationId,
    });

    const mine = await service.list({
      workspaceId,
      userId: ownerId,
      query: { assignee: 'me', open: true, limit: 100 },
    });
    const ids = mine.workItems.map((entry) => entry.id);
    expect(ids).toContain(open.id);
    expect(ids).not.toContain(closed.id);

    const all = await service.list({
      workspaceId,
      userId: ownerId,
      query: { assignee: 'me', open: null, limit: 100 },
    });
    expect(all.workItems.map((entry) => entry.id)).toContain(closed.id);
  });

  it('deletes for the requester only and detaches the children', async () => {
    const parent = await createItem('Weg damit');
    await createItem('Bleibt', { parentId: parent.id });

    await expect(
      service.remove({ workItemId: parent.id, userId: guestId, correlationId }),
    ).rejects.toBeInstanceOf(AuthorizationError);

    const removed = await service.remove({ workItemId: parent.id, userId: ownerId, correlationId });
    expect(removed).toEqual({ deleted: true, detachedChildren: 1 });
  });
});
