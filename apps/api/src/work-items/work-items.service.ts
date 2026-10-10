import { Inject, Injectable } from '@nestjs/common';

import { assertPolicy, canManageWorkItems, WorkspaceAccessService } from '@exocortex/auth';
import {
  type AddWorkItemNoteRequest,
  type CreateWorkItemRequest,
  type DeleteWorkItemResponse,
  type ListWorkItemsQuery,
  type StartWorkItemRunRequest,
  type StartWorkItemRunResponse,
  type UpdateWorkItemRequest,
  type WorkItemAssigneeInput,
  type WorkItemListResponse,
  type WorkItemResponse,
} from '@exocortex/contracts';
import {
  type Prisma,
  type PrismaClient,
  type PrismaTransactionClient,
  type WorkItemRefRole,
  type WorkItemStatus as PrismaStatus,
} from '@exocortex/database';

import { AgentProfilesService } from '../agent-profiles/agent-profiles.service';
import { ConversationsService } from '../ai/conversations.service';
import {
  type AttentionChanges,
  type AttentionResolving,
  emptyChanges,
  mergeChanges,
  syncRunStarted,
  syncWorkItemDeleted,
  syncWorkItemTransition,
} from '../attention/attention-sync';
import { AppError } from '../common/app-error';
import { PRISMA } from '../platform/platform.module';
import { RealtimeService } from '../realtime/realtime.service';

import {
  assertMayChooseProfile,
  assertMayProgress,
  assertRunMayClose,
  assertWriteModeChange,
} from './work-item-access';
import { type WorkItemActor } from './work-item-actor';
import { attentionView, syncAfterTransition, writeAnswerEvent } from './work-item-attention';
import { budgetStanding } from './work-item-budget';
import {
  assigneeColumns,
  assigneeSnapshot,
  planWorkItemUpdate,
  type WorkItemEventDraft,
  writeModeToPrisma,
} from './work-item-changes';
import { WorkItemCheckpointsService } from './work-item-checkpoints.service';
import { eventActor, writeDelegatedEvent, writeEvents } from './work-item-events';
import {
  parseCriteria,
  PARTICIPANT_TO_PRISMA,
  PRIORITY_TO_PRISMA,
  STATUS_TO_PRISMA,
  toWorkItemDetail,
  toWorkItemSummary,
  WORK_ITEM_DETAIL_SELECT,
  WORK_ITEM_SUMMARY_SELECT,
} from './work-item-mapper';
import { profileForNewItem, profilePreferences } from './work-item-profile';
import { buildWorkItemPrompt } from './work-item-prompt';
import { assertChildrenClosed, assertSiblingsAllowRun } from './work-item-siblings';

/**
 * Delegated work (issue #138, ADR-066).
 *
 * Every change writes its history line in the same transaction, so the
 * history never says something happened that was rolled back. The realtime
 * event goes out afterwards and carries only the id: open lists re-read.
 *
 * Authority is the workspace's. A MEMBER may do everything; the account an
 * item is assigned to may, whatever its role, move the item along -- status,
 * reason, criteria, result -- because being asked to do something has to
 * include being able to say it is done.
 */

/** The fields the assignee may change without being a MEMBER. */
const ASSIGNEE_FIELDS = new Set<keyof UpdateWorkItemRequest>([
  'status',
  'statusReason',
  'acceptanceCriteria',
  'result',
  'resultDocumentIds',
]);

/** Deep enough for any real hierarchy, short enough that a corrupt loop ends. */
const MAX_PARENT_DEPTH = 64;

type Action = 'created' | 'updated' | 'deleted';

/**
 * Told when a child's status may have changed what its parent waits for
 * (issue #144). The delegation service registers itself here rather than
 * being a dependency, because it depends on this service.
 */
export type ChildChangeListener = (
  parentId: string,
  actor: WorkItemActor,
  correlationId: string,
) => Promise<void>;

@Injectable()
export class WorkItemsService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly access: WorkspaceAccessService,
    private readonly realtime: RealtimeService,
    private readonly conversations: ConversationsService,
    private readonly checkpoints: WorkItemCheckpointsService,
    private readonly profiles: AgentProfilesService,
  ) {}

  private readonly childListeners: ChildChangeListener[] = [];

  onChildChange(listener: ChildChangeListener): void {
    this.childListeners.push(listener);
  }

  /** After a committed change to a child: whatever waits on it hears about it. */
  async afterChildChange(
    parentId: string | null,
    actor: WorkItemActor,
    correlationId: string,
  ): Promise<void> {
    if (parentId === null) return;
    for (const listener of this.childListeners) await listener(parentId, actor, correlationId);
  }

  async list(input: {
    workspaceId: string;
    userId: string;
    query: ListWorkItemsQuery;
  }): Promise<WorkItemListResponse> {
    await this.access.requireRole(input.workspaceId, input.userId);
    const rows = await this.prisma.workItem.findMany({
      where: this.listFilter(input.workspaceId, input.userId, input.query),
      select: WORK_ITEM_SUMMARY_SELECT,
      // Open work first, then what moved most recently. Priority is shown and
      // filterable, but not the sort: an urgent item from March must not push
      // today's work off the screen.
      orderBy: [{ closedAt: { sort: 'desc', nulls: 'first' } }, { updatedAt: 'desc' }],
      take: input.query.limit + 1,
    });
    const truncated = rows.length > input.query.limit;
    return {
      workItems: rows.slice(0, input.query.limit).map(toWorkItemSummary),
      truncated,
    };
  }

  async get(input: { workItemId: string; userId: string }): Promise<WorkItemResponse> {
    const row = await this.loadReadable(input.workItemId, input.userId);
    return { workItem: toWorkItemDetail(row, await budgetStanding(this.prisma, row.id)) };
  }

  async create(input: {
    workspaceId: string;
    actor: WorkItemActor;
    request: CreateWorkItemRequest;
    correlationId: string;
    /** Whether the credential may choose a profile (issue #143); see the controller. */
    mayChooseProfile?: boolean;
    /** Set by a delegation (issue #144): the parent's history names the child. */
    delegated?: boolean;
  }): Promise<WorkItemResponse> {
    const { request, actor } = input;
    const role = await this.access.requireRole(input.workspaceId, actor.userId);
    assertPolicy(canManageWorkItems(role));
    const agentProfileId = await profileForNewItem(
      { prisma: this.prisma, profiles: this.profiles },
      input.workspaceId,
      actor.userId,
      request,
      input.mayChooseProfile ?? false,
    );

    const assignee = request.assignee ?? null;
    const assigneeName = await this.validateAssignee(input.workspaceId, assignee);
    if (request.parentId !== undefined && request.parentId !== null) {
      await this.validateParent(input.workspaceId, null, request.parentId);
    }
    const contextIds = await this.validateRefs(input.workspaceId, request.contextDocumentIds);

    const id = await this.prisma.$transaction(async (tx) => {
      const created = await tx.workItem.create({
        data: {
          workspaceId: input.workspaceId,
          title: request.title,
          goal: request.goal,
          priority: PRIORITY_TO_PRISMA[request.priority ?? 'normal'],
          requesterKind: PARTICIPANT_TO_PRISMA[actor.kind],
          requesterId: actor.userId,
          ...assigneeColumns(assignee),
          acceptanceCriteria: request.acceptanceCriteria ?? [],
          budgetMicroUsd: request.budgetMicroUsd ?? null,
          writeMode: writeModeToPrisma(request.writeMode ?? null),
          agentProfileId,
          dueAt:
            request.dueAt === undefined || request.dueAt === null ? null : new Date(request.dueAt),
          parentId: request.parentId ?? null,
        },
        select: { id: true },
      });
      await this.replaceRefs(tx, created.id, 'CONTEXT', contextIds ?? []);
      const events: WorkItemEventDraft[] = [{ kind: 'CREATED', data: {} }];
      if (assignee !== null) {
        events.push({
          kind: 'ASSIGNED',
          data: { assignee: assigneeSnapshot(assignee, assigneeName) },
        });
      }
      await writeEvents(tx, created.id, actor, events, input.correlationId);
      if (input.delegated === true && request.parentId != null) {
        await writeDelegatedEvent(tx, {
          parentId: request.parentId,
          childId: created.id,
          actor,
          correlationId: input.correlationId,
          assignee: assignee === null ? null : assigneeSnapshot(assignee, assigneeName),
        });
      }
      return created.id;
    });

    await this.announce(input.workspaceId, id, 'created', input.correlationId);
    return this.get({ workItemId: id, userId: actor.userId });
  }

  async update(input: {
    workItemId: string;
    actor: WorkItemActor;
    request: UpdateWorkItemRequest;
    correlationId: string;
    /** An answer from the inbox that this change carries out (issue #139). */
    resolving?: AttentionResolving;
    /** Whether the credential may loosen the write mode (issue #141); see the controller. */
    mayLoosenWriteMode?: boolean;
  }): Promise<WorkItemResponse> {
    const { request, actor } = input;
    const existing = await this.loadRow(input.workItemId);
    assertWriteModeChange(existing.writeMode, request.writeMode, input.mayLoosenWriteMode ?? false);
    if (request.agentProfileId !== undefined) {
      assertMayChooseProfile(input.mayLoosenWriteMode ?? false);
      if (request.agentProfileId !== null) {
        await this.profiles.assertUsable(existing.workspaceId, request.agentProfileId);
      }
    }
    if (request.status === 'done') {
      await assertRunMayClose(this.prisma, existing.status);
      await assertChildrenClosed(this.prisma, existing.id);
    }
    const progressOnly = Object.keys(request).every((key) =>
      ASSIGNEE_FIELDS.has(key as keyof UpdateWorkItemRequest),
    );
    await this.assertMayUpdate(existing, actor.userId, progressOnly);

    const assigneeName =
      request.assignee === undefined
        ? null
        : await this.validateAssignee(existing.workspaceId, request.assignee);
    if (request.parentId !== undefined && request.parentId !== null) {
      await this.validateParent(existing.workspaceId, existing.id, request.parentId);
    }
    const contextIds = await this.validateRefs(existing.workspaceId, request.contextDocumentIds);
    const resultIds = await this.validateRefs(existing.workspaceId, request.resultDocumentIds);

    const plan = planWorkItemUpdate({ existing, request, assigneeName, now: new Date() });

    const attention = await this.prisma.$transaction(async (tx) => {
      // Written even when only the references changed, so `updatedAt` moves
      // and the item rises in the list like any other change would make it.
      await tx.workItem.update({ where: { id: existing.id }, data: plan.data });
      if (contextIds !== undefined) await this.replaceRefs(tx, existing.id, 'CONTEXT', contextIds);
      if (resultIds !== undefined) await this.replaceRefs(tx, existing.id, 'RESULT', resultIds);
      await writeEvents(tx, existing.id, actor, plan.events, input.correlationId);
      const next = (plan.data.status as PrismaStatus | undefined) ?? existing.status;
      return syncAfterTransition(tx, {
        item: attentionView(existing, request),
        from: existing.status,
        to: next,
        reason: (plan.data.statusReason as string | null | undefined) ?? null,
        actor,
        correlationId: input.correlationId,
        resolving: input.resolving,
      });
    });

    await this.announce(existing.workspaceId, existing.id, 'updated', input.correlationId);
    await this.announceAttention(existing.workspaceId, attention, input.correlationId);
    if (plan.data.status !== undefined) {
      await this.afterChildChange(existing.parentId, actor, input.correlationId);
    }
    return this.get({ workItemId: existing.id, userId: actor.userId });
  }

  async addNote(input: {
    workItemId: string;
    actor: WorkItemActor;
    request: AddWorkItemNoteRequest;
    correlationId: string;
  }): Promise<WorkItemResponse> {
    const existing = await this.loadRow(input.workItemId);
    await this.assertMayUpdate(existing, input.actor.userId, true);

    await this.prisma.$transaction(async (tx) => {
      await tx.workItem.update({ where: { id: existing.id }, data: { updatedAt: new Date() } });
      await tx.workItemEvent.create({
        data: {
          ...eventActor(existing.id, input.actor, input.correlationId),
          kind: 'NOTE',
          note: input.request.note,
        },
      });
    });

    await this.announce(existing.workspaceId, existing.id, 'updated', input.correlationId);
    return this.get({ workItemId: existing.id, userId: input.actor.userId });
  }

  /**
   * Deleting for good. The requester and a workspace ADMIN may; everybody
   * else cancels. Children stay and stand on their own, runs stay in the usage
   * report, and the history goes with the item -- which is why cancelling is
   * the ordinary way to end one.
   */
  async remove(input: {
    workItemId: string;
    userId: string;
    correlationId: string;
    /** Who, for the attention items this settles; a person unless said otherwise. */
    actor?: WorkItemActor;
  }): Promise<DeleteWorkItemResponse> {
    const existing = await this.loadRow(input.workItemId);
    const role = await this.access.requireRole(existing.workspaceId, input.userId);
    assertPolicy(canManageWorkItems(role));
    const isAdmin = role === 'OWNER' || role === 'ADMIN';
    if (!isAdmin && existing.requesterId !== input.userId) {
      throw AppError.forbidden('Only the requester or a workspace admin may delete a work item');
    }

    const actor: WorkItemActor = input.actor ?? {
      kind: 'human',
      userId: input.userId,
      agentLabel: null,
    };
    let attention = emptyChanges();
    const detachedChildren = await this.prisma.$transaction(async (tx) => {
      attention = await syncWorkItemDeleted(tx, { workItemId: existing.id, actor });
      const detached = await tx.workItem.updateMany({
        where: { parentId: existing.id },
        data: { parentId: null },
      });
      await tx.workItem.delete({ where: { id: existing.id } });
      return detached.count;
    });

    await this.announce(existing.workspaceId, existing.id, 'deleted', input.correlationId);
    await this.announceAttention(existing.workspaceId, attention, input.correlationId);
    // A child that is gone cannot be waited for any more.
    await this.afterChildChange(existing.parentId, actor, input.correlationId);
    return { deleted: true, detachedChildren };
  }

  /**
   * An attempt by the built-in AI, in a conversation of its own.
   *
   * Refused on a closed item and on a spent budget, the two cases where
   * starting would be a decision nobody made. An item nobody has taken is
   * given to the assistant, and a queued one starts working; beyond that the
   * run does not touch the status -- how it ended is the run's business, what
   * that means for the work is somebody's decision.
   */
  async startRun(input: {
    workItemId: string;
    actor: WorkItemActor;
    request: StartWorkItemRunRequest;
    correlationId: string;
    /** A retry chosen in the inbox, settled by this run (issue #139). */
    resolving?: AttentionResolving;
  }): Promise<StartWorkItemRunResponse> {
    const row = await this.loadReadable(input.workItemId, input.actor.userId);
    const role = await this.access.requireRole(row.workspaceId, input.actor.userId);
    assertPolicy(canManageWorkItems(role));
    const item = toWorkItemDetail(row, await budgetStanding(this.prisma, row.id));

    if (row.closedAt !== null) {
      throw new AppError('work_item_closed', 'The work item is closed');
    }
    // The stricter of the item's own budget and its profile's (issue #143),
    // over its whole subtree, and every ancestor's the same way (issue #144).
    const budget = item.effectiveBudgetMicroUsd;
    if (item.budgetRemainingMicroUsd !== null && item.budgetRemainingMicroUsd <= 0) {
      throw new AppError('work_item_budget_exhausted', 'The work item has spent its budget');
    }
    await assertSiblingsAllowRun(this.prisma, row);
    // Carried on from where the work stands (issue #142), unless asked not to.
    const resume =
      input.request.fromCheckpoint === 'none'
        ? null
        : await this.checkpoints.resumeSection({
            workItemId: row.id,
            workspaceId: row.workspaceId,
            which: input.request.fromCheckpoint ?? 'latest',
            spentMicroUsd: item.subtreeSpentMicroUsd,
            budgetMicroUsd: budget,
          });

    // The profile's preferences fill in what the request left open (issue
    // #143). The conversation keeps them, so a run that carries on in it
    // keeps them too.
    const preferences = await profilePreferences(this.prisma, item.agentProfile?.id ?? null);
    const modelSlug = input.request.modelSlug ?? preferences.modelSlug;
    const reasoningLevel = input.request.reasoningLevel ?? preferences.reasoningLevel;
    const { conversation } = await this.conversations.create({
      userId: input.actor.userId,
      request: {
        workspaceId: row.workspaceId,
        documentId: null,
        title: row.title.slice(0, 60),
        ...(modelSlug === undefined ? {} : { modelSlug }),
        ...(reasoningLevel === undefined ? {} : { reasoningLevel }),
      },
    });

    const posted = await this.conversations.postMessage({
      conversationId: conversation.id,
      userId: input.actor.userId,
      correlationId: input.correlationId,
      workItemId: row.id,
      request: {
        content: buildWorkItemPrompt({
          id: row.id,
          title: row.title,
          goal: row.goal,
          criteria: parseCriteria(row.acceptanceCriteria),
          contextRefs: item.contextRefs,
          previousResult: row.result,
          checkpoint: resume?.text ?? null,
          instructions: input.request.instructions ?? null,
          parent: row.parent,
        }),
      },
    });
    const run = posted.run;
    if (run === null) throw AppError.internal('Starting the run produced no run');

    const attention = await this.prisma.$transaction(async (tx) => {
      const events: WorkItemEventDraft[] = [
        {
          kind: 'RUN_STARTED',
          data: {
            runId: run.id,
            ...(resume === null ? {} : { checkpointId: resume.checkpointId }),
          },
        },
      ];
      const data: Prisma.WorkItemUncheckedUpdateInput = { updatedAt: new Date() };
      // A new run supersedes a wait for children (issue #144): it is the
      // attempt that would have been carried on.
      if (row.awaitingSince !== null) {
        data.awaitingChildIds = [];
        data.awaitingRunId = null;
        data.awaitingSince = null;
      }
      if (row.assigneeKind === null) {
        data.assigneeKind = 'ASSISTANT';
        events.push({
          kind: 'ASSIGNED',
          data: { assignee: { kind: 'assistant', userId: null, name: null } },
        });
      }
      if (row.status === 'QUEUED') {
        data.status = STATUS_TO_PRISMA.working;
        events.push({ kind: 'STATUS_CHANGED', data: { from: 'queued', to: 'working' } });
      }
      await tx.workItem.update({ where: { id: row.id }, data });
      await writeEvents(tx, row.id, input.actor, events, input.correlationId);
      const changes = await syncRunStarted(tx, {
        workItemId: row.id,
        runId: run.id,
        actor: input.actor,
        resolving: input.resolving,
      });
      if (
        input.resolving !== undefined &&
        changes.settled.includes(input.resolving.attentionItemId)
      ) {
        await writeAnswerEvent(tx, {
          workItemId: row.id,
          actor: input.actor,
          resolving: input.resolving,
          attentionKind: 'run_failed',
          correlationId: input.correlationId,
        });
      }
      mergeChanges(
        changes,
        await syncWorkItemTransition(tx, {
          item: attentionView(row, {}),
          from: row.status,
          to: (data.status as PrismaStatus | undefined) ?? row.status,
          reason: null,
          actor: input.actor,
        }),
      );
      return changes;
    });

    await this.announce(row.workspaceId, row.id, 'updated', input.correlationId);
    await this.announceAttention(row.workspaceId, attention, input.correlationId);
    const updated = await this.get({ workItemId: row.id, userId: input.actor.userId });
    const linked = updated.workItem.runs.find((entry) => entry.id === run.id);
    return {
      run: linked ?? {
        id: run.id,
        status: run.status,
        model: run.model,
        conversationId: conversation.id,
        createdById: input.actor.userId,
        createdAt: run.createdAt,
        finishedAt: null,
        costMicroUsd: null,
        errorCode: null,
        agentProfile: null,
      },
      conversationId: conversation.id,
      checkpointId: resume?.checkpointId ?? null,
      workItem: updated.workItem,
    };
  }

  private listFilter(
    workspaceId: string,
    userId: string,
    query: ListWorkItemsQuery,
  ): Prisma.WorkItemWhereInput {
    const where: Prisma.WorkItemWhereInput = { workspaceId };
    if (query.open !== null) where.closedAt = query.open ? null : { not: null };
    if (query.status !== undefined && query.status.length > 0) {
      where.status = { in: query.status.map((status) => STATUS_TO_PRISMA[status]) };
    }
    if (query.assignee === 'me') where.assigneeId = userId;
    else if (query.assignee === 'assistant') where.assigneeKind = 'ASSISTANT';
    else if (query.assignee === 'nobody') where.assigneeKind = null;
    else if (query.assignee !== undefined) where.assigneeId = query.assignee;
    if (query.requester !== undefined) {
      where.requesterId = query.requester === 'me' ? userId : query.requester;
    }
    if (query.parentId === 'root') where.parentId = null;
    else if (query.parentId !== undefined) where.parentId = query.parentId;
    return where;
  }

  /** Also used by `WorkItemQuestionsService`, which shares this module. */
  async loadRow(workItemId: string) {
    const row = await this.prisma.workItem.findUnique({
      where: { id: workItemId },
      select: {
        id: true,
        workspaceId: true,
        status: true,
        statusReason: true,
        assigneeKind: true,
        assigneeId: true,
        requesterId: true,
        requesterKind: true,
        title: true,
        priority: true,
        result: true,
        writeMode: true,
        parentId: true,
        closedAt: true,
      },
    });
    if (row === null) throw AppError.notFound('Work item');
    return row;
  }

  private async loadReadable(workItemId: string, userId: string) {
    const row = await this.prisma.workItem.findUnique({
      where: { id: workItemId },
      select: WORK_ITEM_DETAIL_SELECT,
    });
    // One answer for "gone" and "not yours", so an id says nothing on its own.
    if (row === null) throw AppError.notFound('Work item');
    const role = await this.access.findRole(row.workspaceId, userId);
    if (role === null) throw AppError.notFound('Work item');
    return row;
  }

  async assertMayUpdate(
    existing: { workspaceId: string; assigneeId: string | null },
    userId: string,
    /** True when the change only moves the work along (a note counts). */
    progressOnly: boolean,
  ): Promise<void> {
    await assertMayProgress(this.access, existing, userId, progressOnly);
  }

  /** Resolves and checks an assignee; returns the name the history should show. */
  private async validateAssignee(
    workspaceId: string,
    assignee: WorkItemAssigneeInput | null,
  ): Promise<string | null> {
    if (assignee === null || assignee.kind === 'assistant') return null;
    const member = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId: assignee.userId } },
      select: { user: { select: { name: true, disabledAt: true } } },
    });
    if (member === null || member.user.disabledAt !== null) {
      throw new AppError('work_item_assignee_invalid', 'The assignee is not a member here');
    }
    return member.user.name;
  }

  /**
   * Same workspace, not the item itself, not below it.
   *
   * Walked upwards from the candidate: if the walk meets the item, the item
   * would become its own ancestor.
   */
  private async validateParent(
    workspaceId: string,
    workItemId: string | null,
    parentId: string,
  ): Promise<void> {
    let cursor: string | null = parentId;
    for (let depth = 0; cursor !== null && depth < MAX_PARENT_DEPTH; depth += 1) {
      if (cursor === workItemId) {
        throw new AppError('work_item_parent_invalid', 'The parent would create a cycle');
      }
      const current: { workspaceId: string; parentId: string | null } | null =
        await this.prisma.workItem.findUnique({
          where: { id: cursor },
          select: { workspaceId: true, parentId: true },
        });
      if (current === null || current.workspaceId !== workspaceId) {
        throw new AppError('work_item_parent_invalid', 'The parent is not in this workspace');
      }
      cursor = current.parentId;
    }
  }

  /** Pages of this workspace only; `undefined` means the list is not being changed. */
  private async validateRefs(
    workspaceId: string,
    documentIds: readonly string[] | undefined,
  ): Promise<string[] | undefined> {
    if (documentIds === undefined) return undefined;
    const unique = [...new Set(documentIds)];
    if (unique.length === 0) return [];
    const found = await this.prisma.document.count({
      where: { id: { in: unique }, workspaceId },
    });
    if (found !== unique.length) {
      throw new AppError('work_item_ref_invalid', 'A referenced page is not in this workspace');
    }
    return unique;
  }

  private async replaceRefs(
    tx: PrismaTransactionClient,
    workItemId: string,
    role: WorkItemRefRole,
    documentIds: readonly string[],
  ): Promise<void> {
    await tx.workItemRef.deleteMany({ where: { workItemId, role } });
    if (documentIds.length === 0) return;
    await tx.workItemRef.createMany({
      data: documentIds.map((documentId) => ({ workItemId, documentId, role })),
    });
  }

  async announceAttention(
    workspaceId: string,
    changes: AttentionChanges,
    correlationId: string,
  ): Promise<void> {
    if (changes.raised.length > 0) {
      await this.realtime.emit('attention.changed', workspaceId, correlationId, {
        attentionItemIds: changes.raised,
        action: 'raised',
      });
    }
    if (changes.settled.length > 0) {
      await this.realtime.emit('attention.changed', workspaceId, correlationId, {
        attentionItemIds: changes.settled,
        action: 'settled',
      });
    }
  }

  async announce(
    workspaceId: string,
    workItemId: string,
    action: Action,
    correlationId: string,
  ): Promise<void> {
    await this.realtime.emit('work-item.changed', workspaceId, correlationId, {
      workItemId,
      action,
    });
  }
}
