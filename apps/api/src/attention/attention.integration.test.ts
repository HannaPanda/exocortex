import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { WorkspaceAccessService } from '@exocortex/auth';
import { loadDotEnv } from '@exocortex/config';
import { type PostConversationMessageResponse } from '@exocortex/contracts';
import {
  attentionDedupeKeys,
  createPrismaClient,
  type PrismaClient,
  raiseAttentionItems,
} from '@exocortex/database';

import { type ConversationsService } from '../ai/conversations.service';
import { AppError } from '../common/app-error';
import { type RealtimeService } from '../realtime/realtime.service';
import { type WorkItemActor } from '../work-items/work-item-actor';
import { WorkItemQuestionsService } from '../work-items/work-item-questions.service';
import { WorkItemsService } from '../work-items/work-items.service';

import { AttentionService } from './attention.service';

/**
 * Attention items against the real database (issue #139, ADR-067).
 *
 * What is proven: a waiting state raises exactly one item and leaving it
 * settles that item; an answer from the inbox is the work item change it
 * stands for, in one transaction with the history line; a question an agent
 * asks is the waiting state's item rather than a second one; closing or
 * deleting the work settles everything; the list shows a person only what is
 * theirs to act on.
 */
loadDotEnv();

const correlationId = 'test-correlation';

let prisma: PrismaClient;
let workItems: WorkItemsService;
let attention: AttentionService;
let workspaceId: string;
let ownerId: string;
let guestId: string;
let strangerId: string;
const emitted: { type: string; payload: unknown }[] = [];

const realtime = {
  emit: async (type: string, _workspaceId: string, _correlationId: string, payload: unknown) => {
    emitted.push({ type, payload });
  },
} as unknown as RealtimeService;

function human(userId: string): WorkItemActor {
  return { kind: 'human', userId, agentLabel: null };
}
function agent(userId: string): WorkItemActor {
  return { kind: 'agent', userId, agentLabel: 'claude-code' };
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

  workItems = new WorkItemsService(prisma, access, realtime, conversations);
  attention = new AttentionService(
    prisma,
    access,
    realtime,
    workItems,
    new WorkItemQuestionsService(prisma, workItems),
  );

  const suffix = Date.now().toString(36);
  const owner = await prisma.user.create({
    data: { email: `att-${suffix}@exocortex.test`, name: 'Owner', emailVerified: true },
  });
  ownerId = owner.id;
  const guest = await prisma.user.create({
    data: { email: `att-guest-${suffix}@exocortex.test`, name: 'Guest', emailVerified: true },
  });
  guestId = guest.id;
  const stranger = await prisma.user.create({
    data: { email: `att-out-${suffix}@exocortex.test`, name: 'Stranger', emailVerified: true },
  });
  strangerId = stranger.id;

  const workspace = await prisma.workspace.create({
    data: {
      name: `Attention ${suffix}`,
      slug: `attention-${suffix}`,
      members: {
        create: [
          { userId: ownerId, role: 'OWNER' },
          { userId: guestId, role: 'GUEST' },
        ],
      },
    },
  });
  workspaceId = workspace.id;
});

afterAll(async () => {
  await prisma.attentionItem.deleteMany({ where: { workspaceId } });
  await prisma.aiRun.deleteMany({ where: { workspaceId } });
  await prisma.workItem.deleteMany({ where: { workspaceId } });
  await prisma.workspace.deleteMany({ where: { id: workspaceId } });
  await prisma.user.deleteMany({ where: { id: { in: [ownerId, guestId, strangerId] } } });
  await prisma.$disconnect();
});

async function createItem(title: string) {
  const response = await workItems.create({
    workspaceId,
    actor: human(ownerId),
    request: { title, goal: `Ziel von ${title}`, assignee: { kind: 'assistant' } },
    correlationId,
  });
  return response.workItem;
}

async function setStatus(
  workItemId: string,
  status: 'review' | 'blocked' | 'waiting_for_human' | 'working' | 'cancelled',
  reason?: string,
) {
  return workItems.update({
    workItemId,
    actor: agent(ownerId),
    request: { status, ...(reason === undefined ? {} : { statusReason: reason }) },
    correlationId,
  });
}

async function openFor(workItemId: string) {
  const list = await attention.list({
    userId: ownerId,
    query: { scope: 'for_me', status: 'open', workItemId, limit: 100 },
  });
  return list.attentionItems;
}

describe('AttentionService', () => {
  it('raises one review item when work enters review, and accepting it closes the work', async () => {
    const item = await createItem('Bericht');
    await setStatus(item.id, 'review', 'Bitte gegenlesen');

    const open = await openFor(item.id);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({
      kind: 'review',
      system: true,
      reason: 'Bitte gegenlesen',
      recipientId: ownerId,
      raisedBy: { kind: 'agent', userId: ownerId },
      options: [
        { id: 'accept', label: null },
        { id: 'return', label: null },
      ],
    });
    expect(emitted.some((event) => event.type === 'attention.changed')).toBe(true);

    const resolved = await attention.resolve({
      attentionItemId: open[0]!.id,
      actor: human(ownerId),
      request: { optionId: 'accept' },
      correlationId,
    });
    expect(resolved.attentionItem).toMatchObject({
      status: 'resolved',
      settledBy: { kind: 'human', userId: ownerId },
      resolution: { optionId: 'accept', workItemStatus: 'done' },
    });

    const after = await workItems.get({ workItemId: item.id, userId: ownerId });
    expect(after.workItem.status).toBe('done');
    expect(after.workItem.events.map((event) => event.kind)).toContain('attention_resolved');
    expect(await openFor(item.id)).toHaveLength(0);
  });

  it('sends a review back with the note as the reason', async () => {
    const item = await createItem('Entwurf');
    await setStatus(item.id, 'review');
    const [review] = await openFor(item.id);

    await attention.resolve({
      attentionItemId: review!.id,
      actor: human(ownerId),
      request: { optionId: 'return', note: 'Quellen fehlen' },
      correlationId,
    });
    const after = await workItems.get({ workItemId: item.id, userId: ownerId });
    expect(after.workItem.status).toBe('working');
    expect(after.workItem.statusReason).toBe('Quellen fehlen');
    const answer = after.workItem.events.find((event) => event.kind === 'attention_resolved');
    expect(answer?.note).toBe('Quellen fehlen');
  });

  it('never raises two items for one waiting state, and a new visit raises a new one', async () => {
    const item = await createItem('Hin und her');
    await setStatus(item.id, 'blocked', 'Zugang fehlt');
    await setStatus(item.id, 'blocked', 'Zugang fehlt noch immer');
    expect(await openFor(item.id)).toHaveLength(1);

    await setStatus(item.id, 'working');
    expect(await openFor(item.id)).toHaveLength(0);
    await setStatus(item.id, 'blocked');
    expect(await openFor(item.id)).toHaveLength(1);

    const all = await attention.list({
      userId: ownerId,
      query: { scope: 'for_me', status: 'all', workItemId: item.id, limit: 100 },
    });
    expect(all.attentionItems.map((entry) => entry.status).toSorted()).toEqual([
      'open',
      'resolved',
    ]);
  });

  it('turns an agent question into the waiting state, and the answer back into the queue', async () => {
    const item = await createItem('Verbindung');
    const asked = await attention.request({
      workspaceId,
      actor: agent(ownerId),
      request: {
        kind: 'decision',
        title: 'MCP-Verbindung global oder pro Arbeitsbereich?',
        workItemId: item.id,
        options: [
          { id: 'global', label: 'Global' },
          { id: 'workspace', label: 'Arbeitsbereich' },
        ],
        key: 'mcp-scope',
      },
      correlationId,
    });
    expect(asked.attentionItem).toMatchObject({
      kind: 'decision',
      system: false,
      recipientId: ownerId,
      noteMode: 'optional',
    });

    const waiting = await workItems.get({ workItemId: item.id, userId: ownerId });
    expect(waiting.workItem.status).toBe('waiting_for_human');
    // The question is the waiting state's item: no generic one beside it.
    expect(await openFor(item.id)).toHaveLength(1);

    // Asking the same key again answers with the open item.
    const again = await attention.request({
      workspaceId,
      actor: agent(ownerId),
      request: {
        kind: 'decision',
        title: 'Nochmal',
        workItemId: item.id,
        options: [{ id: 'global', label: 'Global' }],
        key: 'mcp-scope',
      },
      correlationId,
    });
    expect(again.attentionItem.id).toBe(asked.attentionItem.id);

    await expect(
      attention.resolve({
        attentionItemId: asked.attentionItem.id,
        actor: human(ownerId),
        request: { optionId: 'elsewhere' },
        correlationId,
      }),
    ).rejects.toMatchObject({ code: 'attention_option_invalid' });

    await attention.resolve({
      attentionItemId: asked.attentionItem.id,
      actor: human(ownerId),
      request: { optionId: 'workspace', note: 'Nur für diesen Bereich' },
      correlationId,
    });
    const after = await workItems.get({ workItemId: item.id, userId: ownerId });
    expect(after.workItem.status).toBe('queued');
    const answer = after.workItem.events.find((event) => event.kind === 'attention_resolved');
    expect(answer).toMatchObject({
      note: 'Nur für diesen Bereich',
      data: { attentionItemId: asked.attentionItem.id, optionId: 'workspace' },
    });

    await expect(
      attention.resolve({
        attentionItemId: asked.attentionItem.id,
        actor: human(ownerId),
        request: { optionId: 'global' },
        correlationId,
      }),
    ).rejects.toMatchObject({ code: 'attention_item_settled' });
  });

  it('asks for words when the work waits on a person without a question', async () => {
    const item = await createItem('Frage');
    await setStatus(item.id, 'waiting_for_human', 'Welcher Zeitraum?');
    const [asked] = await openFor(item.id);
    expect(asked).toMatchObject({ kind: 'information', noteMode: 'required' });

    await expect(
      attention.resolve({
        attentionItemId: asked!.id,
        actor: human(ownerId),
        request: { optionId: 'answer' },
        correlationId,
      }),
    ).rejects.toMatchObject({ code: 'attention_note_required' });

    await attention.resolve({
      attentionItemId: asked!.id,
      actor: human(ownerId),
      request: { optionId: 'answer', note: 'Das letzte Quartal' },
      correlationId,
    });
    const after = await workItems.get({ workItemId: item.id, userId: ownerId });
    expect(after.workItem.status).toBe('queued');
  });

  it('makes everything obsolete when the work is cancelled or deleted', async () => {
    const cancelled = await createItem('Abgesagt');
    await setStatus(cancelled.id, 'review');
    const [review] = await openFor(cancelled.id);
    await setStatus(cancelled.id, 'cancelled');
    const settled = await attention.get({ attentionItemId: review!.id, userId: ownerId });
    expect(settled.attentionItem).toMatchObject({
      status: 'obsolete',
      resolution: { reason: 'work_item_cancelled' },
    });

    const deleted = await createItem('Gelöscht');
    await setStatus(deleted.id, 'blocked');
    const [blocked] = await openFor(deleted.id);
    await workItems.remove({ workItemId: deleted.id, userId: ownerId, correlationId });
    const gone = await attention.get({ attentionItemId: blocked!.id, userId: ownerId });
    expect(gone.attentionItem).toMatchObject({
      status: 'obsolete',
      workItem: null,
      resolution: { reason: 'work_item_deleted' },
    });
  });

  it('retries a failed run from the inbox, which settles the failure with the new run', async () => {
    const item = await createItem('Lauf');
    const failed = await prisma.aiRun.create({
      data: {
        workspaceId,
        createdById: ownerId,
        provider: 'mock',
        model: 'mock/model',
        messages: [],
        workItemId: item.id,
        status: 'FAILED',
        errorCode: 'ai_timeout',
        finishedAt: new Date(),
      },
    });
    const [raisedId] = await raiseAttentionItems(prisma, [
      {
        workspaceId,
        kind: 'RUN_FAILED',
        title: item.title,
        reason: 'ai_timeout',
        recipientId: ownerId,
        raisedByKind: 'ASSISTANT',
        raisedById: ownerId,
        system: true,
        workItemId: item.id,
        aiRunId: failed.id,
        options: [
          { id: 'retry', label: null },
          { id: 'give_up', label: null },
        ],
        dedupeKey: attentionDedupeKeys.runFailed(failed.id),
      },
    ]);

    const resolved = await attention.resolve({
      attentionItemId: raisedId!,
      actor: human(ownerId),
      request: { optionId: 'retry' },
      correlationId,
    });
    expect(resolved.attentionItem.status).toBe('resolved');
    expect(resolved.attentionItem.resolution?.optionId).toBe('retry');
    expect(resolved.attentionItem.resolution?.runId).toBeDefined();
    expect(resolved.attentionItem.resolution?.runId).not.toBe(failed.id);
  });

  it('shows a person only what is theirs to act on', async () => {
    const unaddressed = await attention.request({
      workspaceId,
      actor: agent(ownerId),
      request: { kind: 'information', title: 'Wer kennt das Passwort?', recipientId: null },
      correlationId,
    });
    expect(unaddressed.attentionItem.noteMode).toBe('required');

    const mine = await attention.list({
      userId: ownerId,
      query: { scope: 'for_me', status: 'open', limit: 100 },
    });
    expect(mine.attentionItems.map((entry) => entry.id)).toContain(unaddressed.attentionItem.id);
    expect(mine.openCounts.information).toBeGreaterThan(0);

    // A guest does not manage work, so an item for nobody in particular is not theirs.
    const guests = await attention.list({
      userId: guestId,
      query: { scope: 'for_me', status: 'open', limit: 100 },
    });
    expect(guests.attentionItems).toHaveLength(0);

    const strangers = await attention.list({
      userId: strangerId,
      query: { scope: 'all', status: 'all', limit: 100 },
    });
    expect(strangers.attentionItems).toHaveLength(0);
    await expect(
      attention.get({ attentionItemId: unaddressed.attentionItem.id, userId: strangerId }),
    ).rejects.toBeInstanceOf(AppError);

    const raised = await attention.list({
      userId: ownerId,
      query: { scope: 'raised_by_me', status: 'open', limit: 100 },
    });
    expect(raised.attentionItems.map((entry) => entry.id)).toContain(unaddressed.attentionItem.id);
  });

  it('lets only the asker withdraw a question, and never a system item', async () => {
    const asked = await attention.request({
      workspaceId,
      actor: agent(ownerId),
      request: {
        kind: 'approval',
        title: 'Darf ich aufräumen?',
        options: [{ id: 'yes', label: 'Ja' }],
      },
      correlationId,
    });
    await expect(
      attention.withdraw({
        attentionItemId: asked.attentionItem.id,
        actor: human(guestId),
        request: {},
        correlationId,
      }),
    ).rejects.toBeInstanceOf(AppError);

    const withdrawn = await attention.withdraw({
      attentionItemId: asked.attentionItem.id,
      actor: agent(ownerId),
      request: { reason: 'Hat sich erledigt' },
      correlationId,
    });
    expect(withdrawn.attentionItem).toMatchObject({
      status: 'obsolete',
      resolution: { reason: 'withdrawn', note: 'Hat sich erledigt' },
    });

    const item = await createItem('System');
    await setStatus(item.id, 'review');
    const [review] = await openFor(item.id);
    await expect(
      attention.withdraw({
        attentionItemId: review!.id,
        actor: agent(ownerId),
        request: {},
        correlationId,
      }),
    ).rejects.toBeInstanceOf(AppError);
  });
});
