import { Inject, Injectable } from '@nestjs/common';

import { WorkspaceAccessService } from '@exocortex/auth';
import {
  type ListWorkCheckpointsQuery,
  type RecordWorkCheckpointRequest,
  type WorkCheckpointListResponse,
  type WorkCheckpointResponse,
} from '@exocortex/contracts';
import { type PrismaClient, recordWorkCheckpoint } from '@exocortex/database';

import { KIND_FROM_PRISMA } from '../attention/attention-mapper';
import { AppError } from '../common/app-error';
import { PRISMA } from '../platform/platform.module';
import { RealtimeService } from '../realtime/realtime.service';

import { assertMayProgress } from './work-item-access';
import { type WorkItemActor } from './work-item-actor';
import { ANSWERED_ITEM_SELECT, toResumeAnswers } from './work-item-answers';
import {
  CHECKPOINT_SELECT,
  type CheckpointRow,
  toCheckpoints,
  TRIGGER_TO_PRISMA,
} from './work-item-checkpoint-mapper';
import { buildCheckpointSection } from './work-item-checkpoint-prompt';
import { PARTICIPANT_TO_PRISMA } from './work-item-mapper';

/**
 * Working states of delegated work (issue #142, ADR-069).
 *
 * Whoever does the work records where it stands; eXocortex records it too at
 * the points where work stops without the worker deciding so (a question that
 * pauses it, a run that ends unfinished). A later run is started from the
 * newest one and told what was decided since, which is what lets it be another
 * model, in a conversation of its own, without the old transcript.
 */

/** How many decisions since a checkpoint a resumed run is told; older ones are history. */
const MAX_ANSWERS_SINCE = 20;

@Injectable()
export class WorkItemCheckpointsService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly access: WorkspaceAccessService,
    private readonly realtime: RealtimeService,
  ) {}

  async list(input: {
    workItemId: string;
    userId: string;
    query: ListWorkCheckpointsQuery;
  }): Promise<WorkCheckpointListResponse> {
    const item = await this.loadItem(input.workItemId);
    if ((await this.access.findRole(item.workspaceId, input.userId)) === null) {
      throw AppError.notFound('Work item');
    }
    const [rows, total] = await Promise.all([
      this.prisma.workItemCheckpoint.findMany({
        where: { workItemId: item.id },
        select: CHECKPOINT_SELECT,
        orderBy: { createdAt: 'desc' },
        take: input.query.limit,
      }),
      this.prisma.workItemCheckpoint.count({ where: { workItemId: item.id } }),
    ]);
    return { checkpoints: await toCheckpoints(this.prisma, item.workspaceId, rows), total };
  }

  /**
   * Records where the work stands. Fields left out are carried forward from
   * the previous checkpoint, so only the first one needs a summary.
   */
  async record(input: {
    workItemId: string;
    actor: WorkItemActor;
    request: RecordWorkCheckpointRequest;
    correlationId: string;
  }): Promise<WorkCheckpointResponse> {
    const { request, actor } = input;
    const item = await this.loadItem(input.workItemId);
    await assertMayProgress(this.access, item, actor.userId, true);
    if (item.closedAt !== null) throw new AppError('work_item_closed', 'The work item is closed');
    if (request.summary === undefined && item._count.checkpoints === 0) {
      throw new AppError(
        'work_checkpoint_summary_required',
        'The first checkpoint of a work item needs a summary',
      );
    }
    await this.assertPagesHere(item.workspaceId, [
      ...(request.artifactDocumentIds ?? []),
      ...(request.sourceDocumentIds ?? []),
    ]);

    const id = await this.prisma.$transaction(async (tx) =>
      recordWorkCheckpoint(tx, {
        workItemId: item.id,
        aiRunId: actor.runId ?? null,
        trigger: TRIGGER_TO_PRISMA[request.trigger],
        authorKind: PARTICIPANT_TO_PRISMA[actor.kind],
        authorId: actor.userId,
        agentLabel: actor.agentLabel,
        system: false,
        changes: {
          summary: request.summary,
          plan: request.plan,
          assumptions: request.assumptions,
          findings: request.findings,
          lastAction: request.lastAction,
          nextStep: request.nextStep,
        },
        artifactDocumentIds: request.artifactDocumentIds,
        sourceDocumentIds: request.sourceDocumentIds,
        correlationId: input.correlationId,
      }),
    );
    if (id === null) throw AppError.internal('The checkpoint was not recorded');

    await this.realtime.emit('work-item.changed', item.workspaceId, input.correlationId, {
      workItemId: item.id,
      action: 'updated',
    });
    const row = await this.prisma.workItemCheckpoint.findUniqueOrThrow({
      where: { id },
      select: CHECKPOINT_SELECT,
    });
    const [checkpoint] = await toCheckpoints(this.prisma, item.workspaceId, [row]);
    return { checkpoint: checkpoint! };
  }

  /**
   * The words a new run is started with when it carries the work on (issue
   * #142): the checkpoint, every decision made since, what is still open, and
   * the budget now. Null when the work has no checkpoint and none was named.
   */
  async resumeSection(input: {
    workItemId: string;
    workspaceId: string;
    which: 'latest' | (string & {});
    spentMicroUsd: number;
    budgetMicroUsd: number | null;
  }): Promise<{ checkpointId: string; text: string } | null> {
    const row = await this.prisma.workItemCheckpoint.findFirst({
      where: {
        workItemId: input.workItemId,
        ...(input.which === 'latest' ? {} : { id: input.which }),
      },
      select: CHECKPOINT_SELECT,
      orderBy: { createdAt: 'desc' },
    });
    if (row === null) {
      if (input.which === 'latest') return null;
      throw new AppError('work_checkpoint_not_found', 'No such checkpoint on this work item');
    }
    const [checkpoint] = await toCheckpoints(this.prisma, input.workspaceId, [row]);
    const { answersSince, stillOpen } = await this.decisionsSince(row);
    return {
      checkpointId: row.id,
      text: buildCheckpointSection({
        checkpoint: checkpoint!,
        answersSince,
        stillOpen,
        spentMicroUsd: input.spentMicroUsd,
        budgetMicroUsd: input.budgetMicroUsd,
      }),
    };
  }

  /**
   * What people decided about the work after the checkpoint, and what it
   * still waits on. A failed run's retry is left out: it is the start of the
   * very run being told this.
   */
  private async decisionsSince(row: CheckpointRow) {
    const [settled, open] = await Promise.all([
      this.prisma.attentionItem.findMany({
        where: {
          workItemId: row.workItemId,
          status: { not: 'OPEN' },
          settledAt: { gt: row.createdAt },
          kind: { not: 'RUN_FAILED' },
        },
        select: ANSWERED_ITEM_SELECT,
        orderBy: { settledAt: 'desc' },
        take: MAX_ANSWERS_SINCE,
      }),
      this.prisma.attentionItem.findMany({
        where: { workItemId: row.workItemId, status: 'OPEN', kind: { not: 'RUN_FAILED' } },
        select: { id: true, title: true, kind: true },
        orderBy: { createdAt: 'asc' },
      }),
    ]);
    return {
      answersSince: await toResumeAnswers(this.prisma, settled.reverse()),
      stillOpen: open.map((item) => ({
        attentionItemId: item.id,
        title: item.title,
        kind: KIND_FROM_PRISMA[item.kind],
      })),
    };
  }

  private async loadItem(workItemId: string) {
    const item = await this.prisma.workItem.findUnique({
      where: { id: workItemId },
      select: {
        id: true,
        workspaceId: true,
        assigneeId: true,
        closedAt: true,
        _count: { select: { checkpoints: true } },
      },
    });
    if (item === null) throw AppError.notFound('Work item');
    return item;
  }

  private async assertPagesHere(workspaceId: string, documentIds: readonly string[]) {
    const unique = [...new Set(documentIds)];
    if (unique.length === 0) return;
    const found = await this.prisma.document.count({
      where: { id: { in: unique }, workspaceId },
    });
    if (found !== unique.length) {
      throw new AppError('work_item_ref_invalid', 'A referenced page is not in this workspace');
    }
  }
}
