import { Inject, Injectable } from '@nestjs/common';

import {
  type AttentionDraft,
  type AttentionKind as PrismaAttentionKind,
  type PrismaClient,
  raiseAttentionItems,
} from '@exocortex/database';

import {
  emptyChanges,
  mergeChanges,
  QUESTION_KINDS_PRISMA,
  settleOne,
} from '../attention/attention-sync';
import { AppError } from '../common/app-error';
import { PRISMA } from '../platform/platform.module';

import { type WorkItemActor } from './work-item-actor';
import { transitionWorkItem, writeAnswerEvent } from './work-item-attention';
import { writeEvents } from './work-item-events';
import { WorkItemsService } from './work-items.service';

/**
 * Questions asked about a piece of work (issue #139, ADR-067).
 *
 * A question the work waits on is the `waiting_for_human` state's attention
 * item: asking one moves the work there, answering the last one moves it back
 * into the queue. Both halves write the work item's history in the same
 * transaction as the attention item, which is why they live beside the work
 * items rather than in the attention module that calls them.
 */
@Injectable()
export class WorkItemQuestionsService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly workItems: WorkItemsService,
  ) {}

  /**
   * An explicit question put to a person about this work (issue #139).
   *
   * Raised in one transaction with its history line, and a question the work
   * waits on moves an open item to `waiting_for_human` -- the question is
   * then that state's attention item, so the state raises no second one.
   * Returns the id of the open item, the existing one when `dedupeKey` was
   * already open.
   */
  async raiseRequest(input: {
    workItemId: string;
    actor: WorkItemActor;
    draft: AttentionDraft;
    correlationId: string;
  }): Promise<string> {
    const existing = await this.workItems.loadRow(input.workItemId);
    await this.workItems.assertMayUpdate(existing, input.actor.userId, true);
    if (existing.closedAt !== null) {
      throw new AppError('work_item_closed', 'The work item is closed');
    }
    if (input.draft.kind === 'REVIEW') return this.raiseReview(existing, input);
    const waits =
      QUESTION_KINDS_PRISMA.includes(input.draft.kind) && input.draft.blocking !== false;

    const { id, attention } = await this.prisma.$transaction(async (tx) => {
      const changes = emptyChanges();
      const [created] = await raiseAttentionItems(tx, [input.draft]);
      if (created === undefined) {
        // The same question is already open: answer with it, change nothing.
        const open = await tx.attentionItem.findFirst({
          where: { dedupeKey: input.draft.dedupeKey ?? null, status: 'OPEN' },
          select: { id: true },
        });
        if (open === null) throw AppError.conflict('The request could not be raised');
        return { id: open.id, attention: changes };
      }
      changes.raised.push(created);
      await writeEvents(
        tx,
        existing.id,
        input.actor,
        [
          {
            kind: 'ATTENTION_RAISED',
            data: { attentionItemId: created, attentionKind: input.draft.kind.toLowerCase() },
          },
        ],
        input.correlationId,
      );
      if (waits && existing.status !== 'WAITING_FOR_HUMAN') {
        mergeChanges(
          changes,
          await transitionWorkItem(tx, {
            existing,
            to: 'WAITING_FOR_HUMAN',
            reason: input.draft.title.slice(0, 1_000),
            actor: input.actor,
            correlationId: input.correlationId,
          }),
        );
      }
      return { id: created, attention: changes };
    });

    await this.workItems.announce(
      existing.workspaceId,
      existing.id,
      'updated',
      input.correlationId,
    );
    await this.workItems.announceAttention(existing.workspaceId, attention, input.correlationId);
    return id;
  }

  /**
   * A review asked for (issue #140) is the work moving into `review`: the
   * state raises its one review item, and the request's context and working
   * state ride on it. Asking again while the work is already in review answers
   * with the item that is open.
   */
  private async raiseReview(
    existing: Awaited<ReturnType<WorkItemsService['loadRow']>>,
    input: { actor: WorkItemActor; draft: AttentionDraft; correlationId: string },
  ): Promise<string> {
    if (existing.requesterKind === 'AGENT') {
      throw new AppError(
        'attention_target_invalid',
        'An agent asked for this work and reads its state itself; there is no inbox to ask in',
      );
    }
    const { draft } = input;
    const reason = [draft.title, draft.reason].filter((part) => part != null).join('\n\n');
    const attention = await this.prisma.$transaction(async (tx) =>
      existing.status === 'REVIEW'
        ? emptyChanges()
        : transitionWorkItem(tx, {
            existing,
            to: 'REVIEW',
            reason: reason.slice(0, 1_000),
            actor: input.actor,
            correlationId: input.correlationId,
            checkpoint: { context: draft.context ?? null, workState: draft.workState ?? null },
          }),
    );
    await this.workItems.announce(
      existing.workspaceId,
      existing.id,
      'updated',
      input.correlationId,
    );
    await this.workItems.announceAttention(existing.workspaceId, attention, input.correlationId);
    const open = await this.prisma.attentionItem.findFirst({
      where: { workItemId: existing.id, kind: 'REVIEW', status: 'OPEN' },
      select: { id: true },
      orderBy: { createdAt: 'desc' },
    });
    if (open === null) throw AppError.conflict('The review could not be raised');
    return open.id;
  }

  /**
   * An explicit request on this work was answered or withdrawn (issue #139).
   *
   * The answer goes into the item's history, where the agent that asked
   * reads it; and when it was the last open question the work waited on, the
   * work goes back into the queue, ready to be picked up again.
   */
  async settleRequest(input: {
    workItemId: string;
    attentionItemId: string;
    kind: PrismaAttentionKind;
    status: 'RESOLVED' | 'OBSOLETE';
    actor: WorkItemActor;
    optionId: string | undefined;
    note: string | undefined;
    reason: string | undefined;
    /** Why an obsolete item is obsolete; `withdrawn` unless an approval went stale (issue #140). */
    obsoleteReason?: 'withdrawn' | 'subject_changed';
    /** Whether the work waited on this one (issue #140). */
    blocking: boolean;
    correlationId: string;
  }): Promise<void> {
    const existing = await this.workItems.loadRow(input.workItemId);
    const attention = await this.prisma.$transaction(async (tx) => {
      const changes = emptyChanges();
      const settled = await settleOne(tx, {
        attentionItemId: input.attentionItemId,
        status: input.status,
        actor: input.actor,
        resolution:
          input.status === 'OBSOLETE'
            ? {
                reason: input.obsoleteReason ?? 'withdrawn',
                ...(input.reason === undefined ? {} : { note: input.reason }),
              }
            : {
                ...(input.optionId === undefined ? {} : { optionId: input.optionId }),
                ...(input.note === undefined ? {} : { note: input.note }),
              },
      });
      if (!settled) throw new AppError('attention_item_settled', 'The item is already settled');
      changes.settled.push(input.attentionItemId);
      if (input.status === 'RESOLVED') {
        await writeAnswerEvent(tx, {
          workItemId: existing.id,
          actor: input.actor,
          resolving: {
            attentionItemId: input.attentionItemId,
            optionId: input.optionId,
            note: input.note,
          },
          attentionKind: input.kind.toLowerCase(),
          correlationId: input.correlationId,
        });
      } else {
        await tx.workItem.update({ where: { id: existing.id }, data: { updatedAt: new Date() } });
      }
      if (
        existing.status === 'WAITING_FOR_HUMAN' &&
        input.blocking &&
        QUESTION_KINDS_PRISMA.includes(input.kind)
      ) {
        const stillAsked = await tx.attentionItem.count({
          where: {
            workItemId: existing.id,
            status: 'OPEN',
            kind: { in: QUESTION_KINDS_PRISMA },
            blocking: true,
          },
        });
        if (stillAsked === 0) {
          mergeChanges(
            changes,
            await transitionWorkItem(tx, {
              existing,
              to: 'QUEUED',
              reason: null,
              actor: input.actor,
              correlationId: input.correlationId,
            }),
          );
        }
      }
      return changes;
    });

    await this.workItems.announce(
      existing.workspaceId,
      existing.id,
      'updated',
      input.correlationId,
    );
    await this.workItems.announceAttention(existing.workspaceId, attention, input.correlationId);
  }
}
