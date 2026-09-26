import { Inject, Injectable } from '@nestjs/common';

import { type AttentionSubject, type SubmitChangesetRequest } from '@exocortex/contracts';
import {
  type AttentionDraft,
  type Prisma,
  type PrismaClient,
  raiseAttentionItems,
} from '@exocortex/database';

import { settleOne, workItemRecipient } from '../attention/attention-sync';
import { AppError } from '../common/app-error';
import { PRISMA } from '../platform/platform.module';
import { RealtimeService } from '../realtime/realtime.service';
import { type WorkItemActor } from '../work-items/work-item-actor';
import { PARTICIPANT_TO_PRISMA } from '../work-items/work-item-mapper';
import { WorkItemQuestionsService } from '../work-items/work-item-questions.service';
import { WorkItemResumeService } from '../work-items/work-item-resume.service';
import { WorkItemsService } from '../work-items/work-items.service';

const REVIEW_SELECT = {
  id: true,
  workspaceId: true,
  title: true,
  message: true,
  workItemId: true,
  contentHash: true,
  attentionItemId: true,
  changes: { select: { status: true, decisionNote: true } },
} satisfies Prisma.ChangesetSelect;

type ReviewRow = Prisma.ChangesetGetPayload<{ select: typeof REVIEW_SELECT }>;

/**
 * The German sentence an agent reads back when its proposal was decided. It
 * goes into the answer, which the resumed run is handed verbatim (ADR-068),
 * so it names the counts and the tool that reads the rest.
 */
export function decisionNote(row: ReviewRow): string {
  const count = (status: string) => row.changes.filter((change) => change.status === status).length;
  const notes = row.changes
    .map((change) => change.decisionNote)
    .filter((note): note is string => note !== null);
  const lines = [
    `Änderungsvorschlag „${row.title}“ entschieden: ${count('APPLIED')} übernommen, ` +
      `${count('REJECTED')} abgelehnt, ${count('STALE')} veraltet (Seite inzwischen geändert).`,
    ...[...new Set(notes)].map((note) => `Begründung: ${note}`),
    `Einzelheiten: exo_changeset_get mit changesetId ${row.id}. Abgelehntes oder Veraltetes ` +
      'kann mit exo_changeset_propose und revisesId neu vorgeschlagen werden.',
  ];
  return lines.join('\n').slice(0, 4_000);
}

/**
 * The person's side of a changeset (issue #141, ADR-070, built on ADR-067 and
 * ADR-068).
 *
 * Handing a set in raises exactly one attention item, because a proposal
 * nobody is told about is a proposal nobody decides. On a work item the
 * default is a review: the work moves into `review`, and the run that handed
 * it in ends its turn. Otherwise it is an approval that stops nothing. The
 * item is bound to the set by its hash.
 *
 * When the last change is decided the item is settled with an account of the
 * decision, and a review sends the work back to `working`, which is what
 * carries the paused run on in its own conversation with that account as the
 * answer. Whether the work is done then is the run's call, or its owner's:
 * applying every change is not the same as the work being finished.
 */
@Injectable()
export class ChangesetReviewService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly realtime: RealtimeService,
    private readonly workItems: WorkItemsService,
    private readonly questions: WorkItemQuestionsService,
    private readonly resume: WorkItemResumeService,
  ) {}

  async raise(input: {
    changesetId: string;
    actor: WorkItemActor;
    request: SubmitChangesetRequest;
    correlationId: string;
  }): Promise<void> {
    const row = await this.load(input.changesetId);
    const subject: AttentionSubject = {
      kind: 'changeset',
      changesetId: row.id,
      hash: row.contentHash ?? '',
    };
    const draft = this.draft(row, input.actor, input.request, subject, await this.recipient(row));

    let attentionItemId: string;
    if (row.workItemId === null) {
      attentionItemId = await this.raiseUnlinked(draft, input.correlationId);
    } else if (input.request.review === false) {
      attentionItemId = await this.questions.raiseRequest({
        workItemId: row.workItemId,
        actor: input.actor,
        draft,
        correlationId: input.correlationId,
      });
    } else {
      attentionItemId = await this.raiseReview(row.workItemId, draft, input);
    }
    await this.prisma.changeset.update({
      where: { id: row.id },
      data: { attentionItemId },
    });
  }

  /**
   * The set is decided: settle what the hand-in raised, and carry the work
   * on. A person who already answered the item in the inbox has settled it;
   * then there is nothing left to do here.
   */
  async settle(input: {
    changesetId: string;
    actor: WorkItemActor;
    correlationId: string;
  }): Promise<void> {
    const row = await this.load(input.changesetId);
    if (row.attentionItemId === null) return;
    const item = await this.prisma.attentionItem.findUnique({
      where: { id: row.attentionItemId },
      select: { id: true, status: true, kind: true, system: true, workItemId: true },
    });
    if (item?.status !== 'OPEN') return;
    const note = decisionNote(row);

    if (item.workItemId !== null && item.system && item.kind === 'REVIEW') {
      await this.workItems.update({
        workItemId: item.workItemId,
        actor: input.actor,
        request: { status: 'working', statusReason: note.slice(0, 1_000) },
        correlationId: input.correlationId,
        resolving: { attentionItemId: item.id, optionId: 'return', note },
      });
    } else if (item.workItemId === null) {
      const settled = await settleOne(this.prisma, {
        attentionItemId: item.id,
        status: 'RESOLVED',
        actor: input.actor,
        resolution: { note },
      });
      if (settled) {
        await this.realtime.emit('attention.changed', row.workspaceId, input.correlationId, {
          attentionItemIds: [item.id],
          action: 'settled',
        });
      }
      return;
    } else {
      await this.questions.settleRequest({
        workItemId: item.workItemId,
        attentionItemId: item.id,
        kind: item.kind,
        status: 'RESOLVED',
        actor: input.actor,
        optionId: undefined,
        note,
        reason: undefined,
        blocking: false,
        correlationId: input.correlationId,
      });
    }
    await this.resume.afterAnswer({
      attentionItemId: item.id,
      actor: input.actor,
      correlationId: input.correlationId,
    });
  }

  /**
   * A review on work an agent asked for has no inbox to land in (ADR-068);
   * the proposal then asks for approval instead, which the agent reads back.
   */
  private async raiseReview(
    workItemId: string,
    draft: AttentionDraft,
    input: { actor: WorkItemActor; correlationId: string },
  ): Promise<string> {
    try {
      return await this.questions.raiseRequest({
        workItemId,
        actor: input.actor,
        draft: { ...draft, kind: 'REVIEW' },
        correlationId: input.correlationId,
      });
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== 'attention_target_invalid') throw error;
      return this.questions.raiseRequest({
        workItemId,
        actor: input.actor,
        draft,
        correlationId: input.correlationId,
      });
    }
  }

  private async raiseUnlinked(draft: AttentionDraft, correlationId: string): Promise<string> {
    const [created] = await raiseAttentionItems(this.prisma, [draft]);
    if (created === undefined) throw AppError.conflict('The approval could not be raised');
    await this.realtime.emit('attention.changed', draft.workspaceId, correlationId, {
      attentionItemIds: [created],
      action: 'raised',
    });
    return created;
  }

  /** An approval that stops nothing, bound to the set; a review rides on the same fields. */
  private draft(
    row: ReviewRow,
    actor: WorkItemActor,
    request: SubmitChangesetRequest,
    subject: AttentionSubject,
    recipientId: string | null,
  ): AttentionDraft {
    return {
      workspaceId: row.workspaceId,
      kind: 'APPROVAL',
      title: row.title,
      reason: row.message,
      urgency: 'NORMAL',
      recipientId,
      raisedByKind: PARTICIPANT_TO_PRISMA[actor.kind],
      raisedById: actor.userId,
      agentLabel: actor.agentLabel,
      system: false,
      workItemId: row.workItemId,
      options: [],
      noteMode: 'OPTIONAL',
      blocking: false,
      context: request.context ?? null,
      // The card words the action from the changeset in the reader's language.
      action: null,
      workState: null,
      subject: subject as unknown as Prisma.InputJsonValue,
      aiRunId: actor.runId ?? null,
      dedupeKey: null,
    };
  }

  /** Whose inbox: the work's requester when there is work, else anybody who manages work. */
  private async recipient(row: ReviewRow): Promise<string | null> {
    if (row.workItemId === null) return null;
    const item = await this.prisma.workItem.findUnique({
      where: { id: row.workItemId },
      select: {
        id: true,
        workspaceId: true,
        title: true,
        priority: true,
        requesterKind: true,
        requesterId: true,
      },
    });
    return item === null ? null : (workItemRecipient(item) ?? null);
  }

  private async load(changesetId: string): Promise<ReviewRow> {
    const row = await this.prisma.changeset.findUnique({
      where: { id: changesetId },
      select: REVIEW_SELECT,
    });
    if (row === null) throw AppError.notFound('Changeset');
    return row;
  }
}
