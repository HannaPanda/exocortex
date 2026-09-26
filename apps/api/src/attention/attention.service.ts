import { Inject, Injectable } from '@nestjs/common';

import { assertPolicy, canManageWorkItems, WorkspaceAccessService } from '@exocortex/auth';
import {
  ATTENTION_KINDS,
  type AttentionItemResponse,
  type AttentionKind,
  type AttentionListResponse,
  type ListAttentionQuery,
  type RequestAttention,
  type ResolveAttention,
  type SystemAttentionOption,
  type WithdrawAttention,
  type WorkItemStatus,
} from '@exocortex/contracts';
import {
  attentionDedupeKeys,
  type AttentionDraft,
  type Prisma,
  type PrismaClient,
  raiseAttentionItems,
} from '@exocortex/database';

import { AppError } from '../common/app-error';
import { PRISMA } from '../platform/platform.module';
import { RealtimeService } from '../realtime/realtime.service';
import { type WorkItemActor } from '../work-items/work-item-actor';
import { PARTICIPANT_TO_PRISMA, PRIORITY_TO_PRISMA } from '../work-items/work-item-mapper';
import { WorkItemQuestionsService } from '../work-items/work-item-questions.service';
import { WorkItemResumeService } from '../work-items/work-item-resume.service';
import { WorkItemsService } from '../work-items/work-items.service';

import {
  ATTENTION_SELECT,
  type AttentionRow,
  KIND_FROM_PRISMA,
  KIND_TO_PRISMA,
  NOTE_MODE_TO_PRISMA,
  parseOptions,
  toAttentionItem,
} from './attention-mapper';
import {
  parseSubject,
  subjectChanged,
  subjectChangesetsFor,
  subjectForRequest,
  subjectPagesFor,
} from './attention-subject';
import { settleOne, workItemRecipient } from './attention-sync';

/**
 * What needs a person (issue #139, ADR-067).
 *
 * Reading spans every workspace the caller belongs to, because the point of
 * the inbox is one place. Answering is the recipient's, or anybody's who may
 * manage work in the workspace; a system item's answer is carried out as the
 * work item change it stands for, through `WorkItemsService`, so the history
 * line, the status and the settled item are one transaction.
 */

/** What each system option does to its work item. */
const SYSTEM_EFFECTS: Record<
  SystemAttentionOption,
  { status: WorkItemStatus; reasonFromNote: boolean } | 'run'
> = {
  accept: { status: 'done', reasonFromNote: false },
  return: { status: 'working', reasonFromNote: true },
  answer: { status: 'queued', reasonFromNote: false },
  unblock: { status: 'queued', reasonFromNote: false },
  retry: 'run',
  give_up: { status: 'failed', reasonFromNote: true },
};

function isSystemOption(id: string): id is SystemAttentionOption {
  return Object.hasOwn(SYSTEM_EFFECTS, id);
}

interface RequestTarget {
  workItem: { id: string; priority: WorkItemPriorityRow } | null;
  recipientId: string | null;
}

type WorkItemPriorityRow = NonNullable<Prisma.AttentionItemCreateManyInput['urgency']>;

/** A request's urgency, or its work item's with urgent softened to high. */
function requestUrgency(request: RequestAttention, target: RequestTarget): WorkItemPriorityRow {
  if (request.urgency !== undefined) return PRIORITY_TO_PRISMA[request.urgency];
  const inherited = target.workItem?.priority ?? 'NORMAL';
  return inherited === 'URGENT' ? 'HIGH' : inherited;
}

/** What makes a request a human checkpoint (issue #140, ADR-068). */
function checkpointColumns(
  actor: WorkItemActor,
  request: RequestAttention,
  target: RequestTarget,
  subject: Prisma.InputJsonValue | undefined,
): Pick<AttentionDraft, 'blocking' | 'context' | 'action' | 'workState' | 'subject' | 'aiRunId'> {
  return {
    // Only work can wait: a question about nothing in particular has nothing
    // to pause and nothing to carry on, and a conflict is about pages rather
    // than about the work going on.
    blocking: target.workItem !== null && request.kind !== 'conflict' && (request.blocking ?? true),
    context: request.context ?? null,
    action: request.action ?? null,
    workState: request.workState ?? null,
    ...(subject === undefined ? {} : { subject }),
    // From the signed service token, never from the body: the run this
    // checkpoint pauses is the one whose tool loop asked.
    aiRunId: actor.runId ?? null,
  };
}

/** The row an explicit request becomes. */
function requestDraft(
  workspaceId: string,
  actor: WorkItemActor,
  request: RequestAttention,
  target: RequestTarget,
  subject: Prisma.InputJsonValue | undefined,
): AttentionDraft {
  const options = request.options ?? [];
  const noteMode = request.noteMode ?? (options.length === 0 ? 'required' : 'optional');
  if (options.length === 0 && noteMode === 'none') {
    throw AppError.validation('A request without options needs an answer in words');
  }
  return {
    workspaceId,
    kind: KIND_TO_PRISMA[request.kind],
    title: request.title,
    reason: request.reason ?? null,
    urgency: requestUrgency(request, target),
    recipientId: target.recipientId,
    raisedByKind: PARTICIPANT_TO_PRISMA[actor.kind],
    raisedById: actor.userId,
    agentLabel: actor.agentLabel,
    system: false,
    workItemId: target.workItem?.id ?? null,
    options,
    noteMode: NOTE_MODE_TO_PRISMA[noteMode],
    ...checkpointColumns(actor, request, target, subject),
    dedupeKey:
      request.key === undefined
        ? null
        : attentionDedupeKeys.request(workspaceId, actor.userId, request.key),
  };
}

@Injectable()
export class AttentionService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly access: WorkspaceAccessService,
    private readonly realtime: RealtimeService,
    private readonly workItems: WorkItemsService,
    private readonly questions: WorkItemQuestionsService,
    private readonly resume: WorkItemResumeService,
  ) {}

  async list(input: { userId: string; query: ListAttentionQuery }): Promise<AttentionListResponse> {
    const { query, userId } = input;
    const scope = await this.scopeFilter(userId, query);
    const where: Prisma.AttentionItemWhereInput = { ...scope };
    if (query.status === 'open') where.status = 'OPEN';
    else if (query.status === 'settled') where.status = { not: 'OPEN' };
    if (query.kind !== undefined && query.kind.length > 0) {
      where.kind = { in: query.kind.map((kind) => KIND_TO_PRISMA[kind]) };
    }
    if (query.conversationId !== undefined) {
      where.aiRun = { conversationId: query.conversationId };
    }

    const [rows, counts] = await Promise.all([
      this.prisma.attentionItem.findMany({
        where,
        select: ATTENTION_SELECT,
        // Open first, and among open ones the urgent before the rest; a
        // settled list reads newest first.
        orderBy:
          query.status === 'open'
            ? [{ urgency: 'desc' }, { createdAt: 'asc' }]
            : [{ settledAt: { sort: 'desc', nulls: 'first' } }, { createdAt: 'desc' }],
        take: query.limit + 1,
      }),
      this.prisma.attentionItem.groupBy({
        by: ['kind'],
        where: { ...scope, status: 'OPEN' },
        _count: { _all: true },
      }),
    ]);

    const openCounts = Object.fromEntries(ATTENTION_KINDS.map((kind) => [kind, 0])) as Record<
      AttentionKind,
      number
    >;
    for (const entry of counts) openCounts[KIND_FROM_PRISMA[entry.kind]] = entry._count._all;
    const shown = rows.slice(0, query.limit);
    const [subjects, changesets] = await Promise.all([
      subjectPagesFor(this.prisma, shown),
      subjectChangesetsFor(this.prisma, shown),
    ]);
    return {
      attentionItems: shown.map((row) =>
        toAttentionItem(row, subjects.get(row.id) ?? null, changesets.get(row.id) ?? null),
      ),
      openCounts,
      truncated: rows.length > query.limit,
    };
  }

  async get(input: { attentionItemId: string; userId: string }): Promise<AttentionItemResponse> {
    const row = await this.loadReadable(input.attentionItemId, input.userId);
    const [subjects, changesets] = await Promise.all([
      subjectPagesFor(this.prisma, [row]),
      subjectChangesetsFor(this.prisma, [row]),
    ]);
    return {
      attentionItem: toAttentionItem(
        row,
        subjects.get(row.id) ?? null,
        changesets.get(row.id) ?? null,
      ),
    };
  }

  async request(input: {
    workspaceId: string;
    actor: WorkItemActor;
    request: RequestAttention;
    correlationId: string;
  }): Promise<AttentionItemResponse> {
    const { request, actor } = input;
    const role = await this.access.requireRole(input.workspaceId, actor.userId);
    const target = await this.requestTarget(input.workspaceId, role, request);
    const subject =
      request.subjectPages === undefined
        ? undefined
        : await subjectForRequest(this.prisma, input.workspaceId, request.subjectPages);
    if (actor.runId !== undefined) await this.assertRunInWorkspace(actor.runId, input.workspaceId);
    const draft = requestDraft(input.workspaceId, actor, request, target, subject);

    const id =
      target.workItem === null
        ? await this.raiseUnlinked(draft, input.correlationId)
        : // The work item owns its history and its status, so it raises the item.
          await this.questions.raiseRequest({
            workItemId: target.workItem.id,
            actor,
            draft,
            correlationId: input.correlationId,
          });
    return this.get({ attentionItemId: id, userId: actor.userId });
  }

  async resolve(input: {
    attentionItemId: string;
    actor: WorkItemActor;
    request: ResolveAttention;
    correlationId: string;
  }): Promise<AttentionItemResponse> {
    const { actor, request } = input;
    const row = await this.loadReadable(input.attentionItemId, actor.userId);
    await this.assertMayAnswer(row, actor.userId);
    if (row.status !== 'OPEN') {
      throw new AppError('attention_item_settled', 'The item is already settled');
    }
    this.validateAnswer(row, request);

    // An approval answered after what it was bound to moved approves nothing
    // (issue #140): the person saw a state that no longer exists. The item is
    // settled as obsolete rather than refused, so the asker hears about it and
    // can ask again about the page as it is now.
    const subject = parseSubject(row.subject);
    if (subject !== null && (await subjectChanged(this.prisma, row.workspaceId, subject))) {
      return this.settleStale(row, actor, input.correlationId);
    }

    const resolving = {
      attentionItemId: row.id,
      optionId: request.optionId,
      note: request.note,
    };
    const workItemId = row.workItem?.id ?? null;

    if (row.system && workItemId !== null && request.optionId !== undefined) {
      const effect = isSystemOption(request.optionId) ? SYSTEM_EFFECTS[request.optionId] : null;
      if (effect === 'run') {
        await this.workItems.startRun({
          workItemId,
          actor,
          request: {},
          correlationId: input.correlationId,
          resolving,
        });
      } else if (effect !== null) {
        await this.workItems.update({
          workItemId,
          actor,
          request: {
            status: effect.status,
            statusReason: effect.reasonFromNote ? (request.note?.slice(0, 1_000) ?? null) : null,
          },
          correlationId: input.correlationId,
          resolving,
        });
      }
    } else if (workItemId !== null) {
      await this.questions.settleRequest({
        workItemId,
        attentionItemId: row.id,
        kind: row.kind,
        status: 'RESOLVED',
        actor,
        optionId: request.optionId,
        note: request.note,
        reason: undefined,
        blocking: row.blocking,
        correlationId: input.correlationId,
      });
    } else {
      const settled = await settleOne(this.prisma, {
        attentionItemId: row.id,
        status: 'RESOLVED',
        actor,
        resolution: {
          ...(request.optionId === undefined ? {} : { optionId: request.optionId }),
          ...(request.note === undefined ? {} : { note: request.note }),
        },
      });
      if (!settled) throw new AppError('attention_item_settled', 'The item is already settled');
      await this.announce(row.workspaceId, [row.id], 'settled', input.correlationId);
    }
    await this.carryOn(row, actor, input.correlationId);
    return this.get({ attentionItemId: row.id, userId: actor.userId });
  }

  /**
   * The answer is in; if it paused a run, the run goes on (issue #140). Only
   * for an item a run raised on a work item: a question from an external
   * agent is read back by that agent, and one about no work has no run.
   */
  private async carryOn(row: AttentionRow, actor: WorkItemActor, correlationId: string) {
    if (row.aiRun === null || row.workItem === null) return;
    await this.resume.afterAnswer({ attentionItemId: row.id, actor, correlationId });
  }

  /**
   * The asker takes the question back: it is obsolete, not answered. A
   * system item cannot be withdrawn, because its work item's state is what
   * raised it; changing that state is the way to end it.
   */
  async withdraw(input: {
    attentionItemId: string;
    actor: WorkItemActor;
    request: WithdrawAttention;
    correlationId: string;
  }): Promise<AttentionItemResponse> {
    const { actor } = input;
    const row = await this.loadReadable(input.attentionItemId, actor.userId);
    if (row.system) {
      throw AppError.forbidden('A system item ends when its work item leaves the state');
    }
    const role = await this.access.requireRole(row.workspaceId, actor.userId);
    const isAdmin = role === 'OWNER' || role === 'ADMIN';
    if (!isAdmin && row.raisedById !== actor.userId) {
      throw AppError.forbidden('Only the asker or a workspace admin may withdraw a request');
    }
    if (row.status !== 'OPEN') {
      throw new AppError('attention_item_settled', 'The item is already settled');
    }

    const workItemId = row.workItem?.id ?? null;
    if (workItemId === null) {
      const settled = await settleOne(this.prisma, {
        attentionItemId: row.id,
        status: 'OBSOLETE',
        actor,
        resolution: {
          reason: 'withdrawn',
          ...(input.request.reason === undefined ? {} : { note: input.request.reason }),
        },
      });
      if (!settled) throw new AppError('attention_item_settled', 'The item is already settled');
      await this.announce(row.workspaceId, [row.id], 'settled', input.correlationId);
    } else {
      await this.questions.settleRequest({
        workItemId,
        attentionItemId: row.id,
        kind: row.kind,
        status: 'OBSOLETE',
        actor,
        optionId: undefined,
        note: undefined,
        reason: input.request.reason,
        blocking: row.blocking,
        correlationId: input.correlationId,
      });
    }
    return this.get({ attentionItemId: row.id, userId: actor.userId });
  }

  /** The approval went stale before it was answered: obsolete, never approved. */
  private async settleStale(
    row: AttentionRow,
    actor: WorkItemActor,
    correlationId: string,
  ): Promise<AttentionItemResponse> {
    const workItemId = row.workItem?.id ?? null;
    if (workItemId === null) {
      const settled = await settleOne(this.prisma, {
        attentionItemId: row.id,
        status: 'OBSOLETE',
        actor,
        resolution: { reason: 'subject_changed' },
      });
      if (!settled) throw new AppError('attention_item_settled', 'The item is already settled');
      await this.announce(row.workspaceId, [row.id], 'settled', correlationId);
    } else {
      await this.questions.settleRequest({
        workItemId,
        attentionItemId: row.id,
        kind: row.kind,
        status: 'OBSOLETE',
        actor,
        optionId: undefined,
        note: undefined,
        reason: undefined,
        obsoleteReason: 'subject_changed',
        blocking: row.blocking,
        correlationId,
      });
      // The run hears that its approval went stale, and asks again or not.
      await this.carryOn(row, actor, correlationId);
    }
    return this.get({ attentionItemId: row.id, userId: actor.userId });
  }

  /**
   * The run a service token names belongs to this workspace. The claim is
   * signed, so this cannot be forged; it catches a run from one workspace
   * asking about another, which would resume in a conversation nobody here
   * can read.
   */
  private async assertRunInWorkspace(runId: string, workspaceId: string): Promise<void> {
    const run = await this.prisma.aiRun.findUnique({
      where: { id: runId },
      select: { workspaceId: true },
    });
    if (run === null || run.workspaceId !== workspaceId) {
      throw new AppError('attention_target_invalid', 'The asking run belongs to another workspace');
    }
  }

  /** The work item a request is about, and whose inbox it lands in. */
  private async requestTarget(
    workspaceId: string,
    role: Awaited<ReturnType<WorkspaceAccessService['requireRole']>>,
    request: RequestAttention,
  ): Promise<RequestTarget> {
    let recipientId = request.recipientId;
    let workItem: RequestTarget['workItem'] = null;
    if (request.workItemId === undefined) {
      // A question about no work in particular needs the standing of somebody
      // who may hand work out; one about a work item is checked by the item.
      assertPolicy(canManageWorkItems(role));
    } else {
      const found = await this.prisma.workItem.findUnique({
        where: { id: request.workItemId },
        select: {
          id: true,
          workspaceId: true,
          title: true,
          priority: true,
          requesterKind: true,
          requesterId: true,
        },
      });
      if (found === null || found.workspaceId !== workspaceId) {
        throw new AppError('attention_target_invalid', 'The work item is not in this workspace');
      }
      workItem = found;
      recipientId ??= workItemRecipient(found) ?? null;
    }
    if (recipientId !== undefined && recipientId !== null) {
      await this.assertMember(workspaceId, recipientId);
    }
    return { workItem, recipientId: recipientId ?? null };
  }

  /** A request about no work item: raised on its own, idempotent by its key. */
  private async raiseUnlinked(draft: AttentionDraft, correlationId: string): Promise<string> {
    const [created] = await raiseAttentionItems(this.prisma, [draft]);
    if (created !== undefined) {
      await this.announce(draft.workspaceId, [created], 'raised', correlationId);
      return created;
    }
    const open = await this.prisma.attentionItem.findFirst({
      where: { dedupeKey: draft.dedupeKey ?? null, status: 'OPEN' },
      select: { id: true },
    });
    if (open === null) throw AppError.conflict('The request could not be raised');
    return open.id;
  }

  /**
   * Which rows a caller's list may contain.
   *
   * Only workspaces the caller is a member of; `for_me` narrows to items
   * addressed to them, plus the unaddressed ones where they may manage work.
   */
  private async scopeFilter(
    userId: string,
    query: ListAttentionQuery,
  ): Promise<Prisma.AttentionItemWhereInput> {
    const memberships = await this.prisma.workspaceMember.findMany({
      where: {
        userId,
        ...(query.workspaceId === undefined ? {} : { workspaceId: query.workspaceId }),
      },
      select: { workspaceId: true, role: true },
    });
    const readable = memberships.map((entry) => entry.workspaceId);
    const managing = memberships
      .filter((entry) => canManageWorkItems(entry.role).allowed)
      .map((entry) => entry.workspaceId);

    const where: Prisma.AttentionItemWhereInput = { workspaceId: { in: readable } };
    if (query.workItemId !== undefined) where.workItemId = query.workItemId;
    if (query.scope === 'for_me') {
      where.OR = [{ recipientId: userId }, { recipientId: null, workspaceId: { in: managing } }];
    } else if (query.scope === 'raised_by_me') {
      where.raisedById = userId;
    }
    return where;
  }

  private async loadReadable(attentionItemId: string, userId: string): Promise<AttentionRow> {
    const row = await this.prisma.attentionItem.findUnique({
      where: { id: attentionItemId },
      select: ATTENTION_SELECT,
    });
    // One answer for "gone" and "not yours", so an id says nothing on its own.
    if (row === null) throw AppError.notFound('Attention item');
    const role = await this.access.findRole(row.workspaceId, userId);
    if (role === null) throw AppError.notFound('Attention item');
    return row;
  }

  private async assertMayAnswer(row: AttentionRow, userId: string): Promise<void> {
    if (row.recipientId === userId) return;
    const role = await this.access.requireRole(row.workspaceId, userId);
    assertPolicy(canManageWorkItems(role));
  }

  private validateAnswer(row: AttentionRow, request: ResolveAttention): void {
    const options = parseOptions(row.options);
    if (options.length > 0) {
      if (request.optionId === undefined || !options.some((o) => o.id === request.optionId)) {
        throw new AppError('attention_option_invalid', 'Choose one of the offered options');
      }
    } else if (request.optionId !== undefined) {
      throw new AppError('attention_option_invalid', 'This item offers no options');
    }
    if (row.noteMode === 'REQUIRED' && request.note === undefined) {
      throw new AppError('attention_note_required', 'This item needs an answer in words');
    }
    if (row.noteMode === 'NONE' && request.note !== undefined) {
      throw AppError.validation('This item takes no note');
    }
  }

  private async assertMember(workspaceId: string, userId: string): Promise<void> {
    const member = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
      select: { user: { select: { disabledAt: true } } },
    });
    if (member === null || member.user.disabledAt !== null) {
      throw new AppError('attention_target_invalid', 'The recipient is not a member here');
    }
  }

  private async announce(
    workspaceId: string,
    ids: string[],
    action: 'raised' | 'settled',
    correlationId: string,
  ): Promise<void> {
    await this.realtime.emit('attention.changed', workspaceId, correlationId, {
      attentionItemIds: ids,
      action,
    });
  }
}
