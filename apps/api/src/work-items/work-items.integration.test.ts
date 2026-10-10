import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AuthorizationError, WorkspaceAccessService } from '@exocortex/auth';
import { loadDotEnv } from '@exocortex/config';
import { type PostConversationMessageResponse } from '@exocortex/contracts';
import { createPrismaClient, type PrismaClient } from '@exocortex/database';
import { createLogger } from '@exocortex/logger';

import { AgentProfilesService } from '../agent-profiles/agent-profiles.service';
import { type ConversationsService } from '../ai/conversations.service';
import { AppError } from '../common/app-error';
import { runWithRequestContext } from '../common/correlation';
import { OutboxService } from '../common/outbox.service';
import { type RealtimeService } from '../realtime/realtime.service';

import { type WorkItemActor } from './work-item-actor';
import { WorkItemCheckpointsService } from './work-item-checkpoints.service';
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
let checkpoints: WorkItemCheckpointsService;
let profiles: AgentProfilesService;
const lastConversationRequest: { value: Record<string, unknown> | null } = { value: null };
const logger = createLogger({ name: 'api-test', level: 'silent' });
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
      lastConversationRequest.value = input.request;
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

  checkpoints = new WorkItemCheckpointsService(prisma, access, realtime);
  profiles = new AgentProfilesService(prisma, access, new OutboxService(prisma, logger));
  service = new WorkItemsService(prisma, access, realtime, conversations, checkpoints, profiles);

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

describe('work checkpoints (issue #142)', () => {
  async function promptOf(runId: string): Promise<string> {
    const run = await prisma.aiRun.findUniqueOrThrow({
      where: { id: runId },
      select: { messages: true },
    });
    return JSON.stringify(run.messages);
  }

  it('needs a summary first, then carries every left-out field forward', async () => {
    const item = await createItem('Recherche');
    await expect(
      checkpoints.record({
        workItemId: item.id,
        actor: human(ownerId),
        request: { trigger: 'step', plan: [{ text: 'Lesen', status: 'open' }] },
        correlationId,
      }),
    ).rejects.toMatchObject({ code: 'work_checkpoint_summary_required' });

    await prisma.documentContent.create({
      data: { documentId: pageId, yjsState: Buffer.from([0, 0]) },
    });
    const first = await checkpoints.record({
      workItemId: item.id,
      actor: { kind: 'agent', userId: ownerId, agentLabel: 'claude-code' },
      request: {
        trigger: 'step',
        summary: 'Zwei von drei Quellen gelesen.',
        plan: [
          { text: 'Quellen lesen', status: 'in_progress' },
          { text: 'Zusammenfassen', status: 'open' },
        ],
        findings: ['A widerspricht B.'],
        sourceDocumentIds: [pageId],
      },
      correlationId,
    });
    expect(first.checkpoint.author.kind).toBe('agent');
    expect(first.checkpoint.refs).toMatchObject([
      { documentId: pageId, role: 'source', changedSince: false },
    ]);

    const second = await checkpoints.record({
      workItemId: item.id,
      actor: human(ownerId),
      request: {
        trigger: 'pause',
        plan: [
          { text: 'Quellen lesen', status: 'done' },
          { text: 'Zusammenfassen', status: 'open' },
        ],
      },
      correlationId,
    });
    expect(second.checkpoint.summary).toBe('Zwei von drei Quellen gelesen.');
    expect(second.checkpoint.findings).toEqual(['A widerspricht B.']);
    expect(second.checkpoint.refs).toHaveLength(1);
    expect(second.checkpoint.plan[0]?.status).toBe('done');

    // The page moves on; the checkpoint remembers the revision it saw.
    await prisma.documentContent.update({
      where: { documentId: pageId },
      data: { yjsUpdatedAt: new Date(Date.now() + 60_000) },
    });
    const listed = await checkpoints.list({
      workItemId: item.id,
      userId: ownerId,
      query: { limit: 20 },
    });
    expect(listed.total).toBe(2);
    expect(listed.checkpoints[0]?.id).toBe(second.checkpoint.id);
    expect(listed.checkpoints[0]?.refs[0]?.changedSince).toBe(true);

    const detail = await service.get({ workItemId: item.id, userId: ownerId });
    expect(detail.workItem.checkpointCount).toBe(2);
    expect(detail.workItem.events.map((event) => event.kind)).toContain('checkpoint_recorded');
  });

  it('starts a run from the newest checkpoint, or from the goal when asked', async () => {
    const item = await createItem('Fortsetzen');
    const recorded = await checkpoints.record({
      workItemId: item.id,
      actor: human(ownerId),
      request: {
        trigger: 'step',
        summary: 'Gliederung steht, Kapitel 2 fehlt.',
        nextStep: 'Kapitel 2 schreiben',
      },
      correlationId,
    });

    const resumed = await service.startRun({
      workItemId: item.id,
      actor: human(ownerId),
      request: { modelSlug: 'other/model' },
      correlationId,
    });
    expect(resumed.checkpointId).toBe(recorded.checkpoint.id);
    const prompt = await promptOf(resumed.run.id);
    expect(prompt).toContain('Gliederung steht, Kapitel 2 fehlt.');
    expect(prompt).toContain('Kapitel 2 schreiben');
    const started = resumed.workItem.events.find((event) => event.kind === 'run_started');
    expect(started?.data.checkpointId).toBe(recorded.checkpoint.id);

    const fresh = await service.startRun({
      workItemId: item.id,
      actor: human(ownerId),
      request: { fromCheckpoint: 'none' },
      correlationId,
    });
    expect(fresh.checkpointId).toBeNull();
    expect(await promptOf(fresh.run.id)).not.toContain('Gliederung steht');

    await expect(
      service.startRun({
        workItemId: item.id,
        actor: human(ownerId),
        request: { fromCheckpoint: 'nosuchcheckpoint' },
        correlationId,
      }),
    ).rejects.toMatchObject({ code: 'work_checkpoint_not_found' });
  });

  it('keeps checkpoints of a closed item and refuses new ones', async () => {
    const item = await createItem('Fertig');
    await checkpoints.record({
      workItemId: item.id,
      actor: human(ownerId),
      request: { trigger: 'step', summary: 'Alles erledigt.' },
      correlationId,
    });
    await service.update({
      workItemId: item.id,
      actor: human(ownerId),
      request: { status: 'done' },
      correlationId,
    });
    await expect(
      checkpoints.record({
        workItemId: item.id,
        actor: human(ownerId),
        request: { trigger: 'step', summary: 'Noch was.' },
        correlationId,
      }),
    ).rejects.toMatchObject({ code: 'work_item_closed' });
    await expect(
      checkpoints.list({ workItemId: item.id, userId: strangerId, query: { limit: 20 } }),
    ).rejects.toBeInstanceOf(AppError);
  });
});

describe('agent profiles (issue #143)', () => {
  it('keeps names unique, one default, and every change in the audit history', async () => {
    const first = await profiles.create({
      workspaceId,
      userId: ownerId,
      request: { name: 'Rechercheur', writeMode: 'read_only', isDefault: true },
      correlationId,
    });
    expect(first.profile).toMatchObject({ writeMode: 'read_only', isDefault: true, revision: 1 });

    await expect(
      profiles.create({
        workspaceId,
        userId: ownerId,
        request: { name: 'Rechercheur' },
        correlationId,
      }),
    ).rejects.toMatchObject({ code: 'agent_profile_name_taken' });

    const second = await profiles.create({
      workspaceId,
      userId: ownerId,
      request: { name: 'Archivar', isDefault: true, toolDomains: ['pages', 'pages'] },
      correlationId,
    });
    // A new profile starts careful, and taking the default moves it.
    expect(second.profile).toMatchObject({ writeMode: 'propose', toolDomains: ['pages'] });
    const list = await profiles.list({ workspaceId, userId: ownerId });
    expect(list.profiles.filter((profile) => profile.isDefault).map((p) => p.name)).toEqual([
      'Archivar',
    ]);

    const updated = await profiles.update({
      profileId: first.profile.id,
      userId: ownerId,
      request: { budgetMicroUsdPerRun: 500 },
      correlationId,
    });
    expect(updated.profile.revision).toBe(2);
    expect(updated.history.map((entry) => entry.action)).toEqual(['updated', 'created']);
    expect(updated.history[0]?.fields).toEqual(['budgetMicroUsdPerRun']);

    const copy = await profiles.duplicate({
      profileId: first.profile.id,
      userId: ownerId,
      request: { name: 'Rechercheur 2' },
      correlationId,
    });
    expect(copy.profile).toMatchObject({
      writeMode: 'read_only',
      budgetMicroUsdPerRun: 500,
      isDefault: false,
    });
  });

  it('lets only an admin write, and never a run of the built-in AI', async () => {
    await expect(
      profiles.create({ workspaceId, userId: guestId, request: { name: 'Gast' }, correlationId }),
    ).rejects.toBeInstanceOf(AuthorizationError);
    await expect(
      runWithRequestContext({ correlationId, aiRunId: 'some-run' }, () =>
        profiles.create({ workspaceId, userId: ownerId, request: { name: 'KI' }, correlationId }),
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      profiles.create({
        workspaceId,
        userId: ownerId,
        request: { name: 'Fremd', ruleDocumentIds: [foreignPageId] },
        correlationId,
      }),
    ).rejects.toMatchObject({ code: 'agent_profile_invalid' });
  });

  it('lets a person choose a profile, a child inherit it and the default fill in', async () => {
    const profile = await profiles.create({
      workspaceId,
      userId: ownerId,
      request: { name: 'Entwickler', reasoningLevel: 'high', budgetMicroUsdPerTask: 1_000 },
      correlationId,
    });

    await expect(
      service.create({
        workspaceId,
        actor: human(ownerId),
        request: { title: 'Ohne Recht', goal: 'x', agentProfileId: profile.profile.id },
        correlationId,
        mayChooseProfile: false,
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });

    const parent = await service.create({
      workspaceId,
      actor: human(ownerId),
      request: { title: 'Mit Profil', goal: 'x', agentProfileId: profile.profile.id },
      correlationId,
      mayChooseProfile: true,
    });
    expect(parent.workItem.agentProfile).toEqual({
      id: profile.profile.id,
      name: 'Entwickler',
      inherited: false,
    });
    // The stricter of no budget and the profile's.
    expect(parent.workItem.effectiveBudgetMicroUsd).toBe(1_000);

    const child = await createItem('Teil', { parentId: parent.workItem.id });
    expect(child.agentProfile?.id).toBe(profile.profile.id);

    const plain = await createItem('Ohne Angabe');
    expect(plain.agentProfile).toMatchObject({ name: 'Archivar', inherited: true });

    await expect(
      service.update({
        workItemId: plain.id,
        actor: human(ownerId),
        request: { agentProfileId: profile.profile.id },
        correlationId,
        mayLoosenWriteMode: false,
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      service.update({
        workItemId: plain.id,
        actor: human(ownerId),
        request: { agentProfileId: 'nonexistentprofile0000' },
        correlationId,
        mayLoosenWriteMode: true,
      }),
    ).rejects.toMatchObject({ code: 'not_found' });

    nextRunCost.value = 1_200;
    await service.startRun({
      workItemId: parent.workItem.id,
      actor: human(ownerId),
      request: {},
      correlationId,
    });
    expect(lastConversationRequest.value).toMatchObject({ reasoningLevel: 'high' });
    await expect(
      service.startRun({
        workItemId: parent.workItem.id,
        actor: human(ownerId),
        request: {},
        correlationId,
      }),
    ).rejects.toMatchObject({ code: 'work_item_budget_exhausted' });
  });

  it('refuses done from a run whose profile leaves closing to a person', async () => {
    const item = await createItem('Abnahme');
    const run = await prisma.aiRun.create({
      data: {
        workspaceId,
        createdById: ownerId,
        provider: 'mock',
        model: 'mock/model',
        messages: [],
        workItemId: item.id,
        status: 'RUNNING',
        agentProfileSnapshot: {
          id: 'profile-under-test',
          name: 'Prüfling',
          revision: 1,
          source: 'work_item',
          writeMode: 'direct',
          approvalPolicy: 'review_before_done',
          toolDomains: null,
          modelSlug: null,
          reasoningLevel: null,
          budgetMicroUsdPerRun: null,
          budgetMicroUsdPerTask: null,
          maxToolIterations: null,
          maxRunSeconds: null,
          confineToWorkspace: true,
        },
      },
    });
    const asRun = <T>(operation: () => Promise<T>) =>
      runWithRequestContext({ correlationId, aiRunId: run.id }, operation);

    await expect(
      asRun(() =>
        service.update({
          workItemId: item.id,
          actor: human(ownerId),
          request: { status: 'done' },
          correlationId,
        }),
      ),
    ).rejects.toMatchObject({ code: 'work_item_review_required' });
    const review = await asRun(() =>
      service.update({
        workItemId: item.id,
        actor: human(ownerId),
        request: { status: 'review' },
        correlationId,
      }),
    );
    expect(review.workItem.status).toBe('review');
    // The person closes it.
    const done = await service.update({
      workItemId: item.id,
      actor: human(ownerId),
      request: { status: 'done' },
      correlationId,
    });
    expect(done.workItem.status).toBe('done');
  });

  it('holds a confined run to its own workspace, through the access service', async () => {
    const confined = new WorkspaceAccessService(prisma, {
      current: () => null,
      workspace: () => workspaceId,
    });
    expect(await confined.findRole(workspaceId, ownerId)).toBe('OWNER');
    expect(await confined.findRole(otherWorkspaceId, ownerId)).toBeNull();
    await expect(confined.requireRole(otherWorkspaceId, ownerId)).rejects.toMatchObject({
      code: 'token_scope_exceeded',
    });
    expect(await confined.findDocumentContext(foreignPageId, ownerId)).toBeNull();
    expect(await confined.findDocumentContext(pageId, ownerId)).not.toBeNull();
    await expect(confined.requireGlobalAdmin(ownerId)).rejects.toMatchObject({
      code: 'token_scope_exceeded',
    });
  });
});
