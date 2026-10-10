import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';

import { assertPolicy, canManageWorkItems, WorkspaceAccessService } from '@exocortex/auth';
import {
  type AiWriteMode,
  type AwaitChildrenRequest,
  type AwaitChildrenResponse,
  CHILD_RESULT_DEFAULT_CHARS,
  type ChildResultsQuery,
  type ChildResultsResponse,
  type DelegateWorkRequest,
  type DelegateWorkResponse,
  toolDomainSchema,
  WORK_ITEM_MAX_CHILDREN,
  type WorkItemChildResult,
  type WorkItemDetail,
} from '@exocortex/contracts';
import { type PrismaClient } from '@exocortex/database';
import { type Logger } from '@exocortex/logger';

import { ConversationsService } from '../ai/conversations.service';
import { AppError } from '../common/app-error';
import { LOGGER } from '../common/logger.provider';
import { PRISMA } from '../platform/platform.module';

import { type WorkItemActor } from './work-item-actor';
import { budgetStanding } from './work-item-budget';
import { buildChildrenReturnedPrompt, perChildChars } from './work-item-children-prompt';
import {
  childCreateRequest,
  cutText,
  hasReturned,
  type ProfileLimits,
  profileNoLooser,
} from './work-item-delegation-rules';
import { writeEvents } from './work-item-events';
import { PARTICIPANT_FROM_PRISMA, runCost, STATUS_FROM_PRISMA } from './work-item-mapper';
import { WorkItemsService } from './work-items.service';

/**
 * Delegation (issue #144, ADR-072).
 *
 * A part of the work is handed on as an ordinary child work item: its own
 * context, profile, budget, runs, status, result and questions. This service
 * adds the three moves a parent makes with its children, and the one thing
 * eXocortex does by itself: when every child a parent waits for has come
 * back, the parent's paused run is carried on in its own conversation with
 * the children's distilled results -- the same way an answer carries on a run
 * that asked a person (ADR-068). The status of neither is derived from a run
 * (ADR-066): a child has come back because somebody set it to review or
 * closed it.
 */

/** How often a resume is retried while the paused run is still finishing its turn. */
const RESUME_RETRIES = 12;
const RESUME_RETRY_MS = 5_000;

const PROFILE_LIMITS_SELECT = {
  toolDomains: true,
  writeMode: true,
  approvalPolicy: true,
  budgetMicroUsdPerRun: true,
  budgetMicroUsdPerTask: true,
  maxToolIterations: true,
  maxRunSeconds: true,
  confineToWorkspace: true,
} as const;

const CHILD_RESULT_SELECT = {
  id: true,
  title: true,
  status: true,
  statusReason: true,
  assigneeKind: true,
  assigneeId: true,
  assignee: { select: { name: true } },
  result: true,
  acceptanceCriteria: true,
  closedAt: true,
  createdAt: true,
  refs: {
    where: { role: 'RESULT' },
    select: { document: { select: { id: true, title: true } } },
    orderBy: { createdAt: 'asc' },
  },
  runs: {
    select: {
      id: true,
      status: true,
      errorCode: true,
      providerCostMicroUsd: true,
      estimatedCostMicroUsd: true,
    },
    orderBy: { createdAt: 'desc' },
  },
} as const;

@Injectable()
export class WorkItemDelegationService implements OnModuleInit {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(LOGGER) private readonly logger: Logger,
    private readonly access: WorkspaceAccessService,
    private readonly workItems: WorkItemsService,
    private readonly conversations: ConversationsService,
  ) {}

  onModuleInit(): void {
    this.workItems.onChildChange((parentId, actor, correlationId) =>
      this.childChanged(parentId, actor, correlationId, 0),
    );
  }

  /**
   * Hands a part of the work on. The child is created by the ordinary create,
   * so every rule of a work item holds for it; what this adds is the budget
   * carved out of the parent's remainder, the write mode held to the
   * parent's and the caller's, a profile choice that may narrow but never
   * loosen, the line in the parent's history, and an optional start.
   */
  async delegate(input: {
    parentId: string;
    actor: WorkItemActor;
    request: DelegateWorkRequest;
    correlationId: string;
    /** A person, or a token that may write (ADR-070, ADR-071). */
    mayLoosen: boolean;
    /** What the caller may itself write: the mode its own credential is held to. */
    callerWriteCeiling: AiWriteMode;
  }): Promise<DelegateWorkResponse> {
    const { request, actor } = input;
    const parent = await this.loadDelegatingParent(input.parentId, actor.userId);
    const assignee = request.assignee ?? { kind: 'assistant' as const };
    const start = request.start ?? assignee.kind === 'assistant';
    if (start && assignee.kind !== 'assistant') {
      throw new AppError(
        'work_item_start_needs_assistant',
        'Only a child the built-in AI holds can be started when it is handed on',
      );
    }

    const standing = await budgetStanding(this.prisma, parent.id);
    const remaining = standing.budgetRemainingMicroUsd;
    if (remaining !== null && remaining <= 0) {
      throw new AppError('work_item_budget_exhausted', 'The work item has spent its budget');
    }

    const mayChooseProfile =
      request.agentProfileId === undefined ||
      input.mayLoosen ||
      (await this.profileNarrows(parent, request.agentProfileId));
    const created = await this.workItems.create({
      workspaceId: parent.workspaceId,
      actor,
      correlationId: input.correlationId,
      mayChooseProfile,
      delegated: true,
      request: childCreateRequest({
        request,
        assignee,
        parent,
        remaining,
        callerWriteCeiling: input.callerWriteCeiling,
      }),
    });
    await this.workItems.announce(parent.workspaceId, parent.id, 'updated', input.correlationId);
    if (!start) return { workItem: created.workItem, run: null, startRefused: null };
    return this.startChild(created.workItem, actor, request, input.correlationId);
  }

  /** The parent of a delegation, readable, manageable, open and not full. */
  private async loadDelegatingParent(parentId: string, userId: string) {
    const parent = await this.prisma.workItem.findUnique({
      where: { id: parentId },
      select: {
        id: true,
        workspaceId: true,
        closedAt: true,
        writeMode: true,
        agentProfileId: true,
        _count: { select: { children: true } },
      },
    });
    if (parent === null) throw AppError.notFound('Work item');
    const role = await this.access.findRole(parent.workspaceId, userId);
    if (role === null) throw AppError.notFound('Work item');
    assertPolicy(canManageWorkItems(role));
    if (parent.closedAt !== null) {
      throw new AppError('work_item_closed', 'The work item is closed');
    }
    if (parent._count.children >= WORK_ITEM_MAX_CHILDREN) {
      throw new AppError(
        'work_item_children_limit',
        'The work item has as many children as it may',
      );
    }
    return parent;
  }

  /** Starts the child's first run; a refusal is reported, the child stays. */
  private async startChild(
    child: WorkItemDetail,
    actor: WorkItemActor,
    request: DelegateWorkRequest,
    correlationId: string,
  ): Promise<DelegateWorkResponse> {
    try {
      const started = await this.workItems.startRun({
        workItemId: child.id,
        actor,
        correlationId,
        request: {
          fromCheckpoint: 'none',
          ...(request.instructions === undefined ? {} : { instructions: request.instructions }),
          ...(request.modelSlug === undefined ? {} : { modelSlug: request.modelSlug }),
          ...(request.reasoningLevel === undefined
            ? {}
            : { reasoningLevel: request.reasoningLevel }),
        },
      });
      return { workItem: started.workItem, run: started.run, startRefused: null };
    } catch (error) {
      // The child exists either way; the parent may start it later.
      if (!(error instanceof AppError)) throw error;
      return { workItem: child, run: null, startRefused: error.code };
    }
  }

  /** What the children brought back, cut to a budget per child. */
  async childResults(input: {
    workItemId: string;
    userId: string;
    query: ChildResultsQuery;
  }): Promise<ChildResultsResponse> {
    const parent = await this.loadParent(input.workItemId, input.userId);
    const children = await this.readResults(
      parent.id,
      input.query.childIds,
      input.query.maxChars ?? CHILD_RESULT_DEFAULT_CHARS,
    );
    const detail = await this.workItems.get({ workItemId: parent.id, userId: input.userId });
    return { workItemId: parent.id, children, awaiting: detail.workItem.awaiting };
  }

  /**
   * Waits for children. Nothing to wait for answers at once with the
   * results; otherwise the wait is recorded with the run that asked, from
   * the signed claim of its token, and that run ends after this call.
   */
  async awaitChildren(input: {
    workItemId: string;
    actor: WorkItemActor;
    request: AwaitChildrenRequest;
    correlationId: string;
  }): Promise<AwaitChildrenResponse> {
    const parent = await this.workItems.loadRow(input.workItemId);
    await this.workItems.assertMayUpdate(parent, input.actor.userId, true);
    if (parent.closedAt !== null) {
      throw new AppError('work_item_closed', 'The work item is closed');
    }
    const children = await this.prisma.workItem.findMany({
      where: { parentId: parent.id },
      select: { id: true, status: true },
    });
    const known = new Map(children.map((child) => [child.id, child.status]));
    const named = input.request.childIds ?? [];
    if (named.some((id) => !known.has(id))) {
      throw new AppError('work_item_child_invalid', 'A named item is not a child of this one');
    }
    const ids =
      input.request.childIds === undefined
        ? children.filter((child) => !hasReturned(child.status)).map((child) => child.id)
        : [...new Set(named)];
    const pending = ids.filter((id) => !hasReturned(known.get(id) ?? 'DONE'));

    if (pending.length === 0) {
      const results = await this.readResults(
        parent.id,
        ids.length === 0 ? undefined : ids,
        perChildChars(ids.length || children.length, CHILD_RESULT_DEFAULT_CHARS),
      );
      return { waiting: false, awaiting: null, results };
    }

    const since = new Date();
    await this.prisma.$transaction(async (tx) => {
      await tx.workItem.update({
        where: { id: parent.id },
        data: {
          awaitingChildIds: ids,
          awaitingRunId: input.actor.runId ?? null,
          awaitingSince: since,
        },
      });
      await writeEvents(
        tx,
        parent.id,
        input.actor,
        [
          {
            kind: 'CHILDREN_AWAITED',
            data: {
              childIds: ids,
              ...(input.actor.runId === undefined ? {} : { runId: input.actor.runId }),
            },
          },
        ],
        input.correlationId,
      );
    });
    await this.workItems.announce(parent.workspaceId, parent.id, 'updated', input.correlationId);
    // A child may have come back between the read above and the write.
    void this.childChanged(parent.id, input.actor, input.correlationId, 0);
    return {
      waiting: true,
      awaiting: {
        childIds: ids,
        pendingChildIds: pending,
        runId: input.actor.runId ?? null,
        since: since.toISOString(),
      },
      results: [],
    };
  }

  private async loadParent(workItemId: string, userId: string) {
    const row = await this.prisma.workItem.findUnique({
      where: { id: workItemId },
      select: { id: true, workspaceId: true },
    });
    if (row === null) throw AppError.notFound('Work item');
    const role = await this.access.findRole(row.workspaceId, userId);
    if (role === null) throw AppError.notFound('Work item');
    return row;
  }

  private async readResults(
    parentId: string,
    childIds: readonly string[] | undefined,
    maxChars: number,
  ): Promise<WorkItemChildResult[]> {
    const rows = await this.prisma.workItem.findMany({
      where: {
        parentId,
        ...(childIds === undefined ? {} : { id: { in: [...childIds] } }),
      },
      select: CHILD_RESULT_SELECT,
      orderBy: { createdAt: 'asc' },
    });
    if (childIds !== undefined && rows.length !== new Set(childIds).size) {
      throw new AppError('work_item_child_invalid', 'A named item is not a child of this one');
    }
    return rows.map((row) => {
      const criteria = Array.isArray(row.acceptanceCriteria) ? row.acceptanceCriteria : [];
      const met = criteria.filter(
        (entry) =>
          typeof entry === 'object' && entry !== null && 'met' in entry && entry.met === true,
      ).length;
      const result = row.result === null ? null : cutText(row.result, maxChars);
      const latest = row.runs[0];
      return {
        id: row.id,
        title: row.title,
        status: STATUS_FROM_PRISMA[row.status],
        statusReason: row.statusReason,
        assignee:
          row.assigneeKind === null
            ? null
            : {
                kind: PARTICIPANT_FROM_PRISMA[row.assigneeKind],
                userId: row.assigneeId,
                name: row.assignee?.name ?? null,
              },
        returned: hasReturned(row.status),
        result: result?.text ?? null,
        resultTruncated: result?.truncated ?? false,
        resultRefs: row.refs.map((ref) => ({
          documentId: ref.document.id,
          title: ref.document.title,
        })),
        criteriaMet: met,
        criteriaTotal: criteria.length,
        spentMicroUsd: row.runs.reduce((sum, run) => sum + (runCost(run) ?? 0), 0),
        latestRun:
          latest === undefined
            ? null
            : { id: latest.id, status: latest.status.toLowerCase(), errorCode: latest.errorCode },
        closedAt: row.closedAt?.toISOString() ?? null,
      };
    });
  }

  /**
   * Whether a profile is no looser than the one the parent works under (its
   * own, or the workspace's default), so that anybody who may delegate may
   * pick it for a child.
   */
  private async profileNarrows(
    parent: { workspaceId: string; agentProfileId: string | null },
    candidateId: string,
  ): Promise<boolean> {
    const candidate = await this.prisma.agentProfile.findUnique({
      where: { id: candidateId },
      select: { workspaceId: true, ...PROFILE_LIMITS_SELECT },
    });
    if (candidate === null || candidate.workspaceId !== parent.workspaceId) return false;
    const current =
      parent.agentProfileId === null
        ? await this.prisma.agentProfile.findFirst({
            where: { workspaceId: parent.workspaceId, isDefault: true },
            select: PROFILE_LIMITS_SELECT,
          })
        : await this.prisma.agentProfile.findUnique({
            where: { id: parent.agentProfileId },
            select: PROFILE_LIMITS_SELECT,
          });
    return profileNoLooser(limitsOf(candidate), current === null ? null : limitsOf(current));
  }

  /**
   * A child may have come back. When every child the parent waits for has,
   * whoever clears the wait first carries the parent on: the paused run's
   * conversation gets the results as its next message, or, without one, a
   * new run starts from the newest working state. A failure here is logged
   * and written into the parent's history, never thrown into the child's
   * change that caused it.
   */
  private async childChanged(
    parentId: string,
    actor: WorkItemActor,
    correlationId: string,
    attempt: number,
  ): Promise<void> {
    try {
      await this.resumeIfBack(parentId, actor, correlationId, attempt);
    } catch (error) {
      this.logger.error('Carrying a parent on after its children failed', {
        workItemId: parentId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async resumeIfBack(
    parentId: string,
    actor: WorkItemActor,
    correlationId: string,
    attempt: number,
  ): Promise<void> {
    const parent = await this.prisma.workItem.findUnique({
      where: { id: parentId },
      select: {
        id: true,
        title: true,
        workspaceId: true,
        status: true,
        closedAt: true,
        assigneeKind: true,
        awaitingChildIds: true,
        awaitingRunId: true,
        awaitingSince: true,
      },
    });
    if (parent?.awaitingSince == null) return;
    // A child deleted or moved elsewhere counts as back: it can no longer come.
    const waitingOn = await this.prisma.workItem.count({
      where: {
        id: { in: parent.awaitingChildIds },
        parentId: parent.id,
        status: { notIn: ['REVIEW', 'DONE', 'FAILED', 'CANCELLED'] },
      },
    });
    if (waitingOn > 0) return;

    const run =
      parent.awaitingRunId === null
        ? null
        : await this.prisma.aiRun.findUnique({
            where: { id: parent.awaitingRunId },
            select: { id: true, status: true, conversationId: true, createdById: true },
          });
    // The run that waits is still finishing the turn that asked; its
    // conversation is locked until it has.
    if (run !== null && (run.status === 'PENDING' || run.status === 'RUNNING')) {
      if (attempt < RESUME_RETRIES) {
        setTimeout(
          () => void this.childChanged(parentId, actor, correlationId, attempt + 1),
          RESUME_RETRY_MS,
        ).unref();
      }
      return;
    }

    const claimed = await this.prisma.workItem.updateMany({
      where: { id: parent.id, awaitingSince: parent.awaitingSince },
      data: { awaitingChildIds: [], awaitingRunId: null, awaitingSince: null },
    });
    if (claimed.count === 0) return;

    const childIds = parent.awaitingChildIds;
    const carriesOn =
      parent.closedAt === null &&
      parent.assigneeKind === 'ASSISTANT' &&
      (parent.status === 'QUEUED' || parent.status === 'WORKING');
    let resumedRunId: string | null = null;
    let refusal: string | null = null;
    let startedFresh = false;
    if (carriesOn) {
      // The person the paused run acted for, so the next run acts for them too.
      const as: WorkItemActor =
        run === null ? actor : { kind: 'assistant', userId: run.createdById, agentLabel: null };
      try {
        if (run?.conversationId == null) {
          startedFresh = true;
          resumedRunId = (
            await this.workItems.startRun({
              workItemId: parent.id,
              actor: as,
              correlationId,
              request: {
                fromCheckpoint: 'latest',
                instructions:
                  'Die Teilaufträge, auf die dieser Auftrag gewartet hat, sind zurück. Lies ihre ' +
                  'Ergebnisse mit exo_work_item_child_results und entscheide über jeden.',
              },
            })
          ).run.id;
        } else {
          resumedRunId = await this.post(
            parent,
            run.conversationId,
            run.createdById,
            childIds,
            correlationId,
          );
        }
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
        refusal = error.code;
      }
    }

    await this.prisma.$transaction(async (tx) => {
      const events: Parameters<typeof writeEvents>[3][number][] = [
        {
          kind: 'CHILDREN_RETURNED',
          data: { childIds, ...(resumedRunId === null ? {} : { runId: resumedRunId }) },
        },
      ];
      if (refusal !== null) events.push({ kind: 'RESUME_FAILED', data: { reason: refusal } });
      // The same move a started run makes (ADR-066); a fresh start made it already.
      if (resumedRunId !== null && !startedFresh && parent.status === 'QUEUED') {
        await tx.workItem.update({
          where: { id: parent.id },
          data: { status: 'WORKING', statusReason: null },
        });
        events.push({ kind: 'STATUS_CHANGED', data: { from: 'queued', to: 'working' } });
      } else {
        await tx.workItem.update({ where: { id: parent.id }, data: { updatedAt: new Date() } });
      }
      await writeEvents(tx, parent.id, actor, events, correlationId);
    });
    await this.workItems.announce(parent.workspaceId, parent.id, 'updated', correlationId);
  }

  /** Posts the results into the paused conversation; returns the new run's id. */
  private async post(
    parent: { id: string; title: string },
    conversationId: string,
    ownerId: string,
    childIds: readonly string[],
    correlationId: string,
  ): Promise<string> {
    const standing = await budgetStanding(this.prisma, parent.id);
    if (standing.budgetRemainingMicroUsd !== null && standing.budgetRemainingMicroUsd <= 0) {
      throw new AppError('work_item_budget_exhausted', 'The work item has spent its budget');
    }
    const present = await this.prisma.workItem.findMany({
      where: { id: { in: [...childIds] }, parentId: parent.id },
      select: { id: true },
    });
    const children = await this.readResults(
      parent.id,
      present.map((row) => row.id),
      perChildChars(present.length, CHILD_RESULT_DEFAULT_CHARS),
    );
    const posted = await this.conversations.postMessage({
      conversationId,
      userId: ownerId,
      correlationId,
      workItemId: parent.id,
      request: { content: buildChildrenReturnedPrompt({ workItem: parent, children }) },
    });
    if (posted.run === null) throw AppError.internal('Carrying the work on produced no run');
    return posted.run.id;
  }
}

function limitsOf(row: {
  toolDomains: unknown;
  writeMode: 'READ_ONLY' | 'PROPOSE' | 'DIRECT';
  approvalPolicy: 'NONE' | 'REVIEW_BEFORE_DONE';
  budgetMicroUsdPerRun: number | null;
  budgetMicroUsdPerTask: number | null;
  maxToolIterations: number | null;
  maxRunSeconds: number | null;
  confineToWorkspace: boolean;
}): ProfileLimits {
  const domains = toolDomainSchema.array().safeParse(row.toolDomains);
  return {
    // A list that does not parse narrows to nothing rather than opening everything.
    toolDomains: row.toolDomains === null ? null : domains.success ? domains.data : [],
    writeMode: row.writeMode.toLowerCase() as AiWriteMode,
    approvalPolicy: row.approvalPolicy === 'REVIEW_BEFORE_DONE' ? 'review_before_done' : 'none',
    budgetMicroUsdPerRun: row.budgetMicroUsdPerRun,
    budgetMicroUsdPerTask: row.budgetMicroUsdPerTask,
    maxToolIterations: row.maxToolIterations,
    maxRunSeconds: row.maxRunSeconds,
    confineToWorkspace: row.confineToWorkspace,
  };
}
