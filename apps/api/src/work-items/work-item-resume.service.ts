import { Inject, Injectable } from '@nestjs/common';

import { attentionResolutionSchema } from '@exocortex/contracts';
import { type Prisma, type PrismaClient } from '@exocortex/database';

import { ConversationsService } from '../ai/conversations.service';
import { AppError } from '../common/app-error';
import { PRISMA } from '../platform/platform.module';

import { type WorkItemActor } from './work-item-actor';
import { ANSWERED_ITEM_SELECT, type AnsweredItem, toResumeAnswers } from './work-item-answers';
import { writeEvents } from './work-item-events';
import { buildResumePrompt } from './work-item-resume-prompt';
import { WorkItemsService } from './work-items.service';

/**
 * Carrying a paused run on with the answer it waited for (issue #140,
 * ADR-068).
 *
 * A blocking checkpoint ended the run that asked; nothing stayed open for the
 * answer. When the last answer the work waits on arrives, this posts it into
 * the paused run's own conversation as the next user message, which starts
 * the next run with the whole transcript still in context. Only work the
 * assistant holds is carried on: a person or an external agent picks its own
 * work up again, and reads the answer where it always did.
 *
 * The answer itself is already committed when this runs. A resume that cannot
 * happen (budget spent, conversation busy) is written into the work item's
 * history and onto the answered item as `resumeError`, and the work stays in
 * the queue for somebody to start; an answer is never lost to a failed resume.
 * A conversation that is gone no longer ends there: the answer starts a new
 * run from the newest working state instead (issue #142, ADR-069).
 */

/** Why no resume happened, as the code the history and the item carry. */
type ResumeRefusal = 'work_item_budget_exhausted' | 'ai_conversation_locked' | (string & {});

type PausedItem = AnsweredItem;

@Injectable()
export class WorkItemResumeService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly workItems: WorkItemsService,
    private readonly conversations: ConversationsService,
  ) {}

  /**
   * Called after an answer settled `attentionItemId`. Does nothing unless that
   * item paused a run of the assistant's work and nothing else still holds
   * the work up.
   */
  async afterAnswer(input: {
    attentionItemId: string;
    actor: WorkItemActor;
    correlationId: string;
  }): Promise<void> {
    const answered = await this.prisma.attentionItem.findUnique({
      where: { id: input.attentionItemId },
      select: {
        workItemId: true,
        kind: true,
        blocking: true,
        system: true,
        aiRun: { select: { id: true, conversationId: true, createdById: true } },
      },
    });
    const run = answered?.aiRun ?? null;
    if (answered?.workItemId == null || run === null) return;
    if (!answered.blocking && !answered.system) return;
    // A failed run's retry starts a run of its own, in a conversation of its own.
    if (answered.kind === 'RUN_FAILED') return;

    const work = await this.workItems.loadRow(answered.workItemId);
    if (work.closedAt !== null || work.assigneeKind !== 'ASSISTANT') return;
    // Still waiting on another answer, or in review: the last answer resumes.
    if (work.status !== 'QUEUED' && work.status !== 'WORKING') return;

    const stillOpen = await this.prisma.attentionItem.count({
      where: { workItemId: work.id, status: 'OPEN', blocking: true, system: false },
    });
    if (stillOpen > 0) return;

    const paused = (
      await this.prisma.attentionItem.findMany({
        where: {
          aiRunId: run.id,
          workItemId: work.id,
          status: { not: 'OPEN' },
          kind: { not: 'RUN_FAILED' },
        },
        select: ANSWERED_ITEM_SELECT,
        orderBy: { createdAt: 'asc' },
      })
    ).filter((item) => (item.blocking || item.system) && !this.alreadyReported(item));
    if (paused.length === 0) return;

    let refusal: ResumeRefusal | null = null;
    let resumedRunId: string | null = null;
    // Without its conversation the paused run cannot be carried on in place;
    // a new run starts from the recorded working state instead (issue #142),
    // and is told the answers as decisions made since. It makes the status
    // move itself, so the record below must not make it again.
    const fresh = run.conversationId === null;
    try {
      resumedRunId =
        run.conversationId === null
          ? (
              await this.workItems.startRun({
                workItemId: work.id,
                actor: input.actor,
                request: { fromCheckpoint: 'latest' },
                correlationId: input.correlationId,
              })
            ).run.id
          : await this.post({
              work,
              conversationId: run.conversationId,
              ownerId: run.createdById,
              paused,
              correlationId: input.correlationId,
            });
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      refusal = error.code;
    }

    await this.record({
      workItemId: work.id,
      wasQueued: !fresh && work.status === 'QUEUED',
      answeredId: input.attentionItemId,
      paused,
      actor: input.actor,
      resumedRunId,
      refusal,
      correlationId: input.correlationId,
    });
    await this.workItems.announce(work.workspaceId, work.id, 'updated', input.correlationId);
  }

  private alreadyReported(item: PausedItem): boolean {
    const parsed = attentionResolutionSchema.safeParse(item.resolution);
    return parsed.success && parsed.data.resumedRunId !== undefined;
  }

  /** Posts the answers into the paused conversation; returns the new run's id. */
  private async post(input: {
    work: Awaited<ReturnType<WorkItemsService['loadRow']>>;
    conversationId: string;
    ownerId: string;
    paused: readonly PausedItem[];
    correlationId: string;
  }): Promise<string> {
    const { work } = input;
    const detail = await this.workItems.get({ workItemId: work.id, userId: input.ownerId });
    const { budgetMicroUsd, spentMicroUsd } = detail.workItem;
    if (budgetMicroUsd !== null && spentMicroUsd >= budgetMicroUsd) {
      throw new AppError('work_item_budget_exhausted', 'The work item has spent its budget');
    }

    const answers = await toResumeAnswers(this.prisma, input.paused);
    const workState =
      [...input.paused].reverse().find((item) => item.workState !== null)?.workState ?? null;

    const posted = await this.conversations.postMessage({
      conversationId: input.conversationId,
      userId: input.ownerId,
      correlationId: input.correlationId,
      workItemId: work.id,
      request: {
        content: buildResumePrompt({
          workItem: { id: work.id, title: work.title },
          answers,
          workState,
        }),
      },
    });
    if (posted.run === null) throw AppError.internal('Resuming produced no run');
    return posted.run.id;
  }

  /**
   * The history line, the work moving on and the answered items marked, in
   * one transaction; or, when nothing could be posted, the refusal.
   */
  private async record(input: {
    workItemId: string;
    wasQueued: boolean;
    answeredId: string;
    paused: readonly PausedItem[];
    actor: WorkItemActor;
    resumedRunId: string | null;
    refusal: ResumeRefusal | null;
    correlationId: string;
  }): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      if (input.resumedRunId === null) {
        await writeEvents(
          tx,
          input.workItemId,
          input.actor,
          [
            {
              kind: 'RESUME_FAILED',
              data: { attentionItemId: input.answeredId, reason: input.refusal ?? 'unknown' },
            },
          ],
          input.correlationId,
        );
        await this.mark(tx, [input.answeredId], { resumeError: input.refusal ?? 'unknown' });
        return;
      }
      const events: Parameters<typeof writeEvents>[3][number][] = [
        {
          kind: 'RUN_RESUMED',
          data: { runId: input.resumedRunId, attentionItemId: input.answeredId },
        },
      ];
      // The same move a started run makes, and the only one (ADR-066).
      if (input.wasQueued) {
        await tx.workItem.update({
          where: { id: input.workItemId },
          data: { status: 'WORKING', statusReason: null },
        });
        events.push({ kind: 'STATUS_CHANGED', data: { from: 'queued', to: 'working' } });
      } else {
        await tx.workItem.update({
          where: { id: input.workItemId },
          data: { updatedAt: new Date() },
        });
      }
      await writeEvents(tx, input.workItemId, input.actor, events, input.correlationId);
      await this.mark(
        tx,
        input.paused.map((item) => item.id),
        { resumedRunId: input.resumedRunId },
      );
    });
  }

  /** Adds facts to settled items' resolutions; the rest of each stays as it was. */
  private async mark(
    tx: Prisma.TransactionClient,
    ids: readonly string[],
    facts: { resumedRunId?: string; resumeError?: string },
  ): Promise<void> {
    const rows = await tx.attentionItem.findMany({
      where: { id: { in: [...ids] } },
      select: { id: true, resolution: true },
    });
    for (const row of rows) {
      const current =
        row.resolution !== null &&
        typeof row.resolution === 'object' &&
        !Array.isArray(row.resolution)
          ? row.resolution
          : {};
      await tx.attentionItem.update({
        where: { id: row.id },
        data: { resolution: { ...current, ...facts } },
      });
    }
  }
}
