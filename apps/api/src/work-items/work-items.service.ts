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
} from '@exocortex/database';

import { ConversationsService } from '../ai/conversations.service';
import { AppError } from '../common/app-error';
import { PRISMA } from '../platform/platform.module';
import { RealtimeService } from '../realtime/realtime.service';

import { type WorkItemActor } from './work-item-actor';
import {
  assigneeColumns,
  assigneeSnapshot,
  planWorkItemUpdate,
  type WorkItemEventDraft,
} from './work-item-changes';
import {
  PARTICIPANT_TO_PRISMA,
  parseCriteria,
  PRIORITY_TO_PRISMA,
  STATUS_TO_PRISMA,
  toWorkItemDetail,
  toWorkItemSummary,
  WORK_ITEM_DETAIL_SELECT,
  WORK_ITEM_SUMMARY_SELECT,
} from './work-item-mapper';
import { buildWorkItemPrompt } from './work-item-prompt';

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

@Injectable()
export class WorkItemsService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly access: WorkspaceAccessService,
    private readonly realtime: RealtimeService,
    private readonly conversations: ConversationsService,
  ) {}

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
    return { workItem: toWorkItemDetail(row) };
  }

  async create(input: {
    workspaceId: string;
    actor: WorkItemActor;
    request: CreateWorkItemRequest;
    correlationId: string;
  }): Promise<WorkItemResponse> {
    const { request, actor } = input;
    const role = await this.access.requireRole(input.workspaceId, actor.userId);
    assertPolicy(canManageWorkItems(role));

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
      await this.writeEvents(tx, created.id, actor, events, input.correlationId);
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
  }): Promise<WorkItemResponse> {
    const { request, actor } = input;
    const existing = await this.loadRow(input.workItemId);
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

    await this.prisma.$transaction(async (tx) => {
      // Written even when only the references changed, so `updatedAt` moves
      // and the item rises in the list like any other change would make it.
      await tx.workItem.update({ where: { id: existing.id }, data: plan.data });
      if (contextIds !== undefined) await this.replaceRefs(tx, existing.id, 'CONTEXT', contextIds);
      if (resultIds !== undefined) await this.replaceRefs(tx, existing.id, 'RESULT', resultIds);
      await this.writeEvents(tx, existing.id, actor, plan.events, input.correlationId);
    });

    await this.announce(existing.workspaceId, existing.id, 'updated', input.correlationId);
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
          ...this.eventActor(existing.id, input.actor, input.correlationId),
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
  }): Promise<DeleteWorkItemResponse> {
    const existing = await this.loadRow(input.workItemId);
    const role = await this.access.requireRole(existing.workspaceId, input.userId);
    assertPolicy(canManageWorkItems(role));
    const isAdmin = role === 'OWNER' || role === 'ADMIN';
    if (!isAdmin && existing.requesterId !== input.userId) {
      throw AppError.forbidden('Only the requester or a workspace admin may delete a work item');
    }

    const detachedChildren = await this.prisma.$transaction(async (tx) => {
      const detached = await tx.workItem.updateMany({
        where: { parentId: existing.id },
        data: { parentId: null },
      });
      await tx.workItem.delete({ where: { id: existing.id } });
      return detached.count;
    });

    await this.announce(existing.workspaceId, existing.id, 'deleted', input.correlationId);
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
  }): Promise<StartWorkItemRunResponse> {
    const row = await this.loadReadable(input.workItemId, input.actor.userId);
    const role = await this.access.requireRole(row.workspaceId, input.actor.userId);
    assertPolicy(canManageWorkItems(role));
    const item = toWorkItemDetail(row);

    if (row.closedAt !== null) {
      throw new AppError('work_item_closed', 'The work item is closed');
    }
    if (item.budgetMicroUsd !== null && item.spentMicroUsd >= item.budgetMicroUsd) {
      throw new AppError('work_item_budget_exhausted', 'The work item has spent its budget');
    }

    const { conversation } = await this.conversations.create({
      userId: input.actor.userId,
      request: {
        workspaceId: row.workspaceId,
        documentId: null,
        title: row.title.slice(0, 60),
        ...(input.request.modelSlug === undefined ? {} : { modelSlug: input.request.modelSlug }),
        ...(input.request.reasoningLevel === undefined
          ? {}
          : { reasoningLevel: input.request.reasoningLevel }),
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
          instructions: input.request.instructions ?? null,
        }),
      },
    });
    const run = posted.run;
    if (run === null) throw AppError.internal('Starting the run produced no run');

    await this.prisma.$transaction(async (tx) => {
      const events: WorkItemEventDraft[] = [{ kind: 'RUN_STARTED', data: { runId: run.id } }];
      const data: Prisma.WorkItemUncheckedUpdateInput = { updatedAt: new Date() };
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
      await this.writeEvents(tx, row.id, input.actor, events, input.correlationId);
    });

    await this.announce(row.workspaceId, row.id, 'updated', input.correlationId);
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
      },
      conversationId: conversation.id,
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

  private async loadRow(workItemId: string) {
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
        result: true,
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

  private async assertMayUpdate(
    existing: { workspaceId: string; assigneeId: string | null },
    userId: string,
    /** True when the change only moves the work along (a note counts). */
    progressOnly: boolean,
  ): Promise<void> {
    const role = await this.access.findRole(existing.workspaceId, userId);
    if (role === null) throw AppError.notFound('Work item');
    if (canManageWorkItems(role).allowed) return;
    if (existing.assigneeId === userId && progressOnly) return;
    assertPolicy(canManageWorkItems(role));
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

  private eventActor(workItemId: string, actor: WorkItemActor, correlationId: string) {
    return {
      workItemId,
      actorKind: PARTICIPANT_TO_PRISMA[actor.kind],
      actorId: actor.userId,
      agentLabel: actor.agentLabel,
      correlationId,
    };
  }

  private async writeEvents(
    tx: PrismaTransactionClient,
    workItemId: string,
    actor: WorkItemActor,
    events: readonly WorkItemEventDraft[],
    correlationId: string,
  ): Promise<void> {
    const base = this.eventActor(workItemId, actor, correlationId);
    const now = Date.now();
    // Explicit timestamps one millisecond apart, so the lines of one change
    // keep the order they were planned in when sorted by time.
    for (const [index, event] of events.entries()) {
      await tx.workItemEvent.create({
        data: { ...base, kind: event.kind, data: event.data, createdAt: new Date(now + index) },
      });
    }
  }

  private async announce(
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
