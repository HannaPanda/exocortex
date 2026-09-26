import { Inject, Injectable } from '@nestjs/common';

import { attentionResolutionSchema } from '@exocortex/contracts';
import { type Prisma, type PrismaClient } from '@exocortex/database';

import { ConversationsService } from '../ai/conversations.service';
import { KIND_FROM_PRISMA, parseOptions } from '../attention/attention-mapper';
import { parseSubject } from '../attention/attention-subject';
import { AppError } from '../common/app-error';
import { PRISMA } from '../platform/platform.module';

import { type WorkItemActor } from './work-item-actor';
import { writeEvents } from './work-item-events';
import { buildResumePrompt, type ResumeAnswer } from './work-item-resume-prompt';
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
 * happen (budget spent, conversation busy or gone) is written into the work
 * item's history and onto the answered item as `resumeError`, and the work
 * stays in the queue for somebody to start; an answer is never lost to a
 * failed resume.
 */

/** Why no resume happened, as the code the history and the item carry. */
type ResumeRefusal =
  'work_item_budget_exhausted' | 'conversation_missing' | 'ai_conversation_locked' | (string & {});

const PAUSED_ITEM_SELECT = {
  id: true,
  workspaceId: true,
  kind: true,
  status: true,
  title: true,
  options: true,
  resolution: true,
  action: true,
  subject: true,
  workState: true,
  blocking: true,
  system: true,
  settledBy: { select: { name: true } },
} satisfies Prisma.AttentionItemSelect;

type PausedItem = Prisma.AttentionItemGetPayload<{ select: typeof PAUSED_ITEM_SELECT }>;

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
        select: PAUSED_ITEM_SELECT,
        orderBy: { createdAt: 'asc' },
      })
    ).filter((item) => (item.blocking || item.system) && !this.alreadyReported(item));
    if (paused.length === 0) return;

    let refusal: ResumeRefusal | null = null;
    let resumedRunId: string | null = null;
    if (run.conversationId === null) {
      refusal = 'conversation_missing';
    } else {
      try {
        resumedRunId = await this.post({
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
    }

    await this.record({
      workItemId: work.id,
      wasQueued: work.status === 'QUEUED',
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

    const titles = await this.subjectTitles(input.paused);
    const answers = input.paused.map((item) => this.answerOf(item, titles));
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

  private answerOf(item: PausedItem, titles: ReadonlyMap<string, string>): ResumeAnswer {
    const resolution = attentionResolutionSchema.safeParse(item.resolution);
    const facts = resolution.success ? resolution.data : {};
    const option = parseOptions(item.options).find((entry) => entry.id === facts.optionId);
    return {
      attentionItemId: item.id,
      kind: KIND_FROM_PRISMA[item.kind],
      title: item.title,
      status: item.status === 'OBSOLETE' ? 'obsolete' : 'resolved',
      optionId: facts.optionId ?? null,
      optionLabel: option?.label ?? null,
      note: facts.note ?? null,
      obsoleteReason: facts.reason ?? null,
      answeredBy: item.settledBy?.name ?? null,
      action: item.action,
      // A stale approval hands no revision on: there is nothing it approves.
      subject: item.status === 'OBSOLETE' ? null : parseSubject(item.subject),
      subjectTitles: titles,
    };
  }

  private async subjectTitles(paused: readonly PausedItem[]): Promise<Map<string, string>> {
    const ids = paused.flatMap(
      (item) => parseSubject(item.subject)?.pages.map((page) => page.documentId) ?? [],
    );
    if (ids.length === 0) return new Map();
    const rows = await this.prisma.document.findMany({
      where: { id: { in: ids }, workspaceId: paused[0]!.workspaceId },
      select: { id: true, title: true },
    });
    return new Map(rows.map((row) => [row.id, row.title]));
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
