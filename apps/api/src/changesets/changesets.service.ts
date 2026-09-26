import { createHash } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import { assertPolicy, canManageWorkItems, WorkspaceAccessService } from '@exocortex/auth';
import {
  type AddChangesetChangeResponse,
  CHANGESET_MAX_CHANGES,
  type ChangesetDecisionOutcome,
  type ChangesetDecisionResponse,
  type ChangesetListResponse,
  type ChangesetResponse,
  changesetStatusOf,
  type CreateChangesetRequest,
  type DecideChangesetRequest,
  type ListChangesetsQuery,
  type ProposeChange,
  type SubmitChangesetRequest,
} from '@exocortex/contracts';
import { type Prisma, type PrismaClient, type PrismaTransactionClient } from '@exocortex/database';

import { AppError } from '../common/app-error';
import { PRISMA } from '../platform/platform.module';
import { RealtimeService } from '../realtime/realtime.service';
import { type WorkItemActor } from '../work-items/work-item-actor';
import { PARTICIPANT_TO_PRISMA } from '../work-items/work-item-mapper';

import { ChangesetApplyService } from './changeset-apply.service';
import {
  CHANGE_STATUS_FROM_PRISMA,
  CHANGESET_DETAIL_SELECT,
  CHANGESET_SUMMARY_SELECT,
  type ChangesetDetailRow,
  KIND_TO_PRISMA,
  pagesNow,
  STATUS_TO_PRISMA,
  toChangesetDetail,
  toChangesetSummary,
} from './changeset-mapper';
import { ChangesetProposalService } from './changeset-proposal.service';
import { ChangesetReviewService } from './changeset-review.service';

type ChangesetAction = 'created' | 'updated' | 'submitted' | 'decided' | 'deleted';

/**
 * Proposed changes (issue #141, ADR-070).
 *
 * A changeset is put together as a draft, handed in, and decided change by
 * change. Only the proposer shapes a draft; once handed in it is frozen, and
 * what happens to it is a person's decision, recorded on each change. Reading
 * is anybody's in the workspace; rejecting is for whoever may manage work
 * there; applying additionally needs the right to write each page, which the
 * write itself checks, because applying is that write.
 */
@Injectable()
export class ChangesetsService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly access: WorkspaceAccessService,
    private readonly realtime: RealtimeService,
    private readonly proposals: ChangesetProposalService,
    private readonly applying: ChangesetApplyService,
    private readonly review: ChangesetReviewService,
  ) {}

  async list(input: {
    workspaceId: string;
    userId: string;
    query: ListChangesetsQuery;
  }): Promise<ChangesetListResponse> {
    await this.access.requireRole(input.workspaceId, input.userId);
    const { query } = input;
    const where: Prisma.ChangesetWhereInput = { workspaceId: input.workspaceId };
    if (query.state === 'open') where.closedAt = null;
    else if (query.state === 'closed') where.closedAt = { not: null };
    if (query.workItemId !== undefined) where.workItemId = query.workItemId;
    if (query.proposedBy === 'me') where.proposedById = input.userId;

    const rows = await this.prisma.changeset.findMany({
      where,
      select: CHANGESET_SUMMARY_SELECT,
      orderBy: { updatedAt: 'desc' },
      take: query.limit + 1,
    });
    return {
      changesets: rows.slice(0, query.limit).map(toChangesetSummary),
      truncated: rows.length > query.limit,
    };
  }

  async get(input: { changesetId: string; userId: string }): Promise<ChangesetResponse> {
    const row = await this.loadReadable(input.changesetId, input.userId);
    return { changeset: await this.detail(row) };
  }

  async create(input: {
    workspaceId: string;
    actor: WorkItemActor;
    request: CreateChangesetRequest;
    correlationId: string;
  }): Promise<AddChangesetChangeResponse | ChangesetResponse> {
    const { actor, request } = input;
    const role = await this.access.requireRole(input.workspaceId, actor.userId);
    assertPolicy(canManageWorkItems(role));
    await this.assertInWorkspace(input.workspaceId, request.workItemId, request.revisesId, actor);

    // Prepared before anything is stored, so a change that cannot be proposed
    // leaves no empty draft behind.
    const first =
      request.change === undefined
        ? null
        : await this.proposals.prepare({
            workspaceId: input.workspaceId,
            userId: actor.userId,
            change: request.change,
            correlationId: input.correlationId,
          });

    const created = await this.prisma.changeset.create({
      data: {
        workspaceId: input.workspaceId,
        title: request.title,
        message: request.message ?? null,
        proposerKind: PARTICIPANT_TO_PRISMA[actor.kind],
        proposedById: actor.userId,
        agentLabel: actor.agentLabel,
        workItemId: request.workItemId ?? null,
        aiRunId: actor.runId ?? null,
        revisesId: request.revisesId ?? null,
        ...(first === null ? {} : { changes: { create: [this.changeData(first, 0)] } }),
      },
      select: { id: true, changes: { select: { id: true } } },
    });
    await this.announce(input.workspaceId, created.id, 'created', input.correlationId);
    const response = await this.get({ changesetId: created.id, userId: actor.userId });
    const changeId = created.changes[0]?.id;
    return changeId === undefined ? response : { ...response, changeId };
  }

  async addChange(input: {
    changesetId: string;
    actor: WorkItemActor;
    change: ProposeChange;
    correlationId: string;
  }): Promise<AddChangesetChangeResponse> {
    const row = await this.loadDraft(input.changesetId, input.actor);
    if (row.changes.length >= CHANGESET_MAX_CHANGES) {
      throw AppError.validation(`A changeset holds at most ${CHANGESET_MAX_CHANGES} changes`);
    }
    const prepared = await this.proposals.prepare({
      workspaceId: row.workspaceId,
      userId: input.actor.userId,
      change: input.change,
      correlationId: input.correlationId,
    });
    const position = row.changes.reduce((max, change) => Math.max(max, change.position + 1), 0);
    const created = await this.prisma.changesetChange.create({
      data: { changesetId: row.id, ...this.changeData(prepared, position) },
      select: { id: true },
    });
    await this.touch(row.id);
    await this.announce(row.workspaceId, row.id, 'updated', input.correlationId);
    const response = await this.get({ changesetId: row.id, userId: input.actor.userId });
    return { ...response, changeId: created.id };
  }

  async removeChange(input: {
    changesetId: string;
    changeId: string;
    actor: WorkItemActor;
    correlationId: string;
  }): Promise<ChangesetResponse> {
    const row = await this.loadDraft(input.changesetId, input.actor);
    if (!row.changes.some((change) => change.id === input.changeId)) {
      throw AppError.notFound('Change');
    }
    await this.prisma.changesetChange.delete({ where: { id: input.changeId } });
    await this.touch(row.id);
    await this.announce(row.workspaceId, row.id, 'updated', input.correlationId);
    return this.get({ changesetId: row.id, userId: input.actor.userId });
  }

  /** A draft thrown away by its proposer. Handed in, it is a record and stays. */
  async discard(input: {
    changesetId: string;
    actor: WorkItemActor;
    correlationId: string;
  }): Promise<{ deleted: true }> {
    const row = await this.loadDraft(input.changesetId, input.actor);
    await this.prisma.changeset.delete({ where: { id: row.id } });
    await this.announce(row.workspaceId, row.id, 'deleted', input.correlationId);
    return { deleted: true };
  }

  async submit(input: {
    changesetId: string;
    actor: WorkItemActor;
    request: SubmitChangesetRequest;
    correlationId: string;
  }): Promise<ChangesetResponse> {
    const row = await this.loadDraft(input.changesetId, input.actor);
    if (row.changes.length === 0) {
      throw new AppError('changeset_empty', 'A changeset without changes cannot be handed in');
    }
    const contentHash = changesetHash(row);
    await this.prisma.changeset.update({
      where: { id: row.id },
      data: { status: 'READY', submittedAt: new Date(), contentHash },
    });
    await this.announce(row.workspaceId, row.id, 'submitted', input.correlationId);
    await this.review.raise({
      changesetId: row.id,
      actor: input.actor,
      request: input.request,
      correlationId: input.correlationId,
    });
    return this.get({ changesetId: row.id, userId: input.actor.userId });
  }

  async apply(input: {
    changesetId: string;
    actor: WorkItemActor;
    request: DecideChangesetRequest;
    correlationId: string;
  }): Promise<ChangesetDecisionResponse> {
    const { row, selected, outcomes } = await this.decidable(input);
    for (const change of selected) {
      outcomes.push(
        await this.applying.applyOne({
          changesetId: row.id,
          workspaceId: row.workspaceId,
          change,
          actor: input.actor,
          note: input.request.note ?? null,
          correlationId: input.correlationId,
        }),
      );
    }
    return this.afterDecision(row, input, outcomes);
  }

  async reject(input: {
    changesetId: string;
    actor: WorkItemActor;
    request: DecideChangesetRequest;
    correlationId: string;
  }): Promise<ChangesetDecisionResponse> {
    const { row, selected, outcomes } = await this.decidable(input);
    const role = await this.access.requireRole(row.workspaceId, input.actor.userId);
    assertPolicy(canManageWorkItems(role));
    if (selected.length > 0) {
      await this.prisma.changesetChange.updateMany({
        where: { id: { in: selected.map((change) => change.id) }, status: 'PENDING' },
        data: {
          status: 'REJECTED',
          ...this.applying.decision(input.actor, input.request.note ?? null),
        },
      });
    }
    for (const change of selected) {
      outcomes.push({ changeId: change.id, outcome: 'rejected', errorCode: null, message: null });
    }
    return this.afterDecision(row, input, outcomes);
  }

  /** The handed-in set, and the pending changes a decision is about. */
  private async decidable(input: {
    changesetId: string;
    actor: WorkItemActor;
    request: DecideChangesetRequest;
  }) {
    const row = await this.loadReadable(input.changesetId, input.actor.userId);
    if (row.submittedAt === null) {
      throw new AppError('changeset_not_draft', 'A draft is decided only once it is handed in', {
        status: 'draft',
      });
    }
    if (row.closedAt !== null) {
      throw new AppError('changeset_closed', 'Every change of this changeset is decided');
    }
    const wanted = input.request.changeIds;
    const outcomes: ChangesetDecisionOutcome[] = [];
    if (wanted !== undefined) {
      const known = new Set(row.changes.map((change) => change.id));
      for (const id of wanted) {
        if (!known.has(id)) throw AppError.notFound('Change');
      }
    }
    const selected = row.changes.filter((change) => {
      const chosen = wanted === undefined || wanted.includes(change.id);
      if (chosen && change.status !== 'PENDING' && wanted !== undefined) {
        outcomes.push({ changeId: change.id, outcome: 'skipped', errorCode: null, message: null });
      }
      return chosen && change.status === 'PENDING';
    });
    return { row, selected, outcomes };
  }

  /**
   * Recomputes the set's status from its changes, closes it when nothing is
   * pending, and hands a closed set to the review, which settles what the
   * hand-in raised and carries the work on.
   */
  private async afterDecision(
    row: ChangesetDetailRow,
    input: { actor: WorkItemActor; correlationId: string },
    outcomes: ChangesetDecisionOutcome[],
  ): Promise<ChangesetDecisionResponse> {
    const closed = await this.prisma.$transaction((tx) => this.recompute(tx, row.id));
    await this.announce(row.workspaceId, row.id, 'decided', input.correlationId);
    if (closed) {
      await this.review.settle({
        changesetId: row.id,
        actor: input.actor,
        correlationId: input.correlationId,
      });
    }
    const { changeset } = await this.get({ changesetId: row.id, userId: input.actor.userId });
    return { changeset, outcomes };
  }

  /** Writes the status the changes add up to; true when this closed the set. */
  private async recompute(tx: PrismaTransactionClient, changesetId: string): Promise<boolean> {
    const current = await tx.changeset.findUniqueOrThrow({
      where: { id: changesetId },
      select: { submittedAt: true, closedAt: true, changes: { select: { status: true } } },
    });
    const statuses = current.changes.map((change) => CHANGE_STATUS_FROM_PRISMA[change.status]);
    const status = changesetStatusOf({ submitted: current.submittedAt !== null, statuses });
    const nowClosed = current.submittedAt !== null && !statuses.includes('pending');
    await tx.changeset.update({
      where: { id: changesetId },
      data: {
        status: STATUS_TO_PRISMA[status],
        ...(nowClosed && current.closedAt === null ? { closedAt: new Date() } : {}),
      },
    });
    return nowClosed && current.closedAt === null;
  }

  private changeData(
    prepared: Awaited<ReturnType<ChangesetProposalService['prepare']>>,
    position: number,
  ) {
    return {
      position,
      kind: KIND_TO_PRISMA[prepared.kind],
      documentId: prepared.documentId,
      parentId: prepared.parentId,
      title: prepared.title,
      message: prepared.message,
      request: prepared.request as Prisma.InputJsonValue,
      baseRevision: prepared.revision,
      expectedRevision: prepared.revision,
      diff: prepared.diff as unknown as Prisma.InputJsonValue,
    };
  }

  private async detail(row: ChangesetDetailRow) {
    const pages = await pagesNow(
      this.prisma,
      row.workspaceId,
      row.changes.map((change) => change.documentId),
    );
    return toChangesetDetail(row, pages);
  }

  private async loadReadable(changesetId: string, userId: string): Promise<ChangesetDetailRow> {
    const row = await this.prisma.changeset.findUnique({
      where: { id: changesetId },
      select: CHANGESET_DETAIL_SELECT,
    });
    // One answer for "gone" and "not yours", so an id says nothing on its own.
    if (row === null) throw AppError.notFound('Changeset');
    const role = await this.access.findRole(row.workspaceId, userId);
    if (role === null) throw AppError.notFound('Changeset');
    await this.access.requireRole(row.workspaceId, userId);
    return row;
  }

  /** A draft, and the one who proposed it asking. */
  private async loadDraft(changesetId: string, actor: WorkItemActor): Promise<ChangesetDetailRow> {
    const row = await this.loadReadable(changesetId, actor.userId);
    if (row.submittedAt !== null) {
      throw new AppError('changeset_not_draft', 'The changeset was already handed in');
    }
    if (row.proposedById !== actor.userId) {
      throw AppError.forbidden('Only the proposer shapes a draft');
    }
    return row;
  }

  private async assertInWorkspace(
    workspaceId: string,
    workItemId: string | undefined,
    revisesId: string | undefined,
    actor: WorkItemActor,
  ): Promise<void> {
    if (workItemId !== undefined) {
      const item = await this.prisma.workItem.findUnique({
        where: { id: workItemId },
        select: { workspaceId: true },
      });
      if (item?.workspaceId !== workspaceId) {
        throw new AppError('changeset_target_invalid', 'The work item is not in this workspace');
      }
    }
    if (revisesId !== undefined) {
      const earlier = await this.prisma.changeset.findUnique({
        where: { id: revisesId },
        select: { workspaceId: true },
      });
      if (earlier?.workspaceId !== workspaceId) {
        throw new AppError('changeset_target_invalid', 'The earlier changeset is not here');
      }
    }
    if (actor.runId !== undefined) {
      const run = await this.prisma.aiRun.findUnique({
        where: { id: actor.runId },
        select: { workspaceId: true },
      });
      if (run?.workspaceId !== workspaceId) {
        throw new AppError('changeset_target_invalid', 'The proposing run is in another workspace');
      }
    }
  }

  private async touch(changesetId: string): Promise<void> {
    await this.prisma.changeset.update({
      where: { id: changesetId },
      data: { updatedAt: new Date() },
    });
  }

  private async announce(
    workspaceId: string,
    changesetId: string,
    action: ChangesetAction,
    correlationId: string,
  ): Promise<void> {
    await this.realtime.emit('changeset.changed', workspaceId, correlationId, {
      changesetId,
      action,
    });
  }
}

/**
 * What a review is bound to: the changes as handed in. Ids, kinds, targets
 * and the requests themselves, in their order.
 */
export function changesetHash(row: {
  changes: readonly {
    id: string;
    kind: string;
    documentId: string | null;
    parentId: string | null;
    title: string | null;
    request: Prisma.JsonValue;
  }[];
}): string {
  const canonical = row.changes.map((change) => [
    change.id,
    change.kind,
    change.documentId,
    change.parentId,
    change.title,
    change.request,
  ]);
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}
