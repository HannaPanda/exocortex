import { type AttentionResolution, QUESTION_ATTENTION_KINDS } from '@exocortex/contracts';
import {
  attentionDedupeKeys,
  type AttentionDraft,
  type AttentionKind as PrismaAttentionKind,
  type AttentionNoteMode as PrismaNoteMode,
  type Prisma,
  type PrismaTransactionClient,
  raiseAttentionItems,
  type WorkItemParticipantKind as PrismaParticipantKind,
  type WorkItemPriority as PrismaPriority,
  type WorkItemStatus as PrismaStatus,
} from '@exocortex/database';

import { type WorkItemActor } from '../work-items/work-item-actor';
import { PARTICIPANT_TO_PRISMA, STATUS_FROM_PRISMA } from '../work-items/work-item-mapper';

import { KIND_TO_PRISMA } from './attention-mapper';

/**
 * How a work item's state and its attention items stay in step (issue #139,
 * ADR-067).
 *
 * Every function here takes the transaction of the change it follows, so an
 * item is raised or settled exactly when the state that explains it is
 * written, and never on its own. The rule the whole feature rests on:
 * entering a state that waits on a person raises one item, leaving it settles
 * that item, and closing the work settles everything still open on it.
 */

/** The states that wait on a person, and what each asks for. */
const WAITING_STATES: Partial<
  Record<PrismaStatus, { kind: PrismaAttentionKind; options: string[]; noteMode: PrismaNoteMode }>
> = {
  REVIEW: { kind: 'REVIEW', options: ['accept', 'return'], noteMode: 'OPTIONAL' },
  BLOCKED: { kind: 'BLOCKED', options: ['unblock'], noteMode: 'OPTIONAL' },
  WAITING_FOR_HUMAN: { kind: 'INFORMATION', options: ['answer'], noteMode: 'REQUIRED' },
};

const CLOSED: readonly PrismaStatus[] = ['DONE', 'FAILED', 'CANCELLED'];

export const QUESTION_KINDS_PRISMA: PrismaAttentionKind[] = QUESTION_ATTENTION_KINDS.map(
  (kind) => KIND_TO_PRISMA[kind],
);

/** The work item as far as its attention needs to know. */
export interface AttentionWorkItem {
  id: string;
  workspaceId: string;
  title: string;
  priority: PrismaPriority;
  requesterKind: PrismaParticipantKind;
  requesterId: string | null;
}

/** An answer being given through the inbox, carried into the change it causes. */
export interface AttentionResolving {
  attentionItemId: string;
  optionId: string | undefined;
  note: string | undefined;
}

export interface AttentionChanges {
  raised: string[];
  settled: string[];
}

export function emptyChanges(): AttentionChanges {
  return { raised: [], settled: [] };
}

export function mergeChanges(into: AttentionChanges, from: AttentionChanges): void {
  into.raised.push(...from.raised);
  into.settled.push(...from.settled);
}

/**
 * Who a work item's own questions go to: the person who asked for the work.
 * The assistant's requester id is the person it acted for, so that counts.
 * An agent that delegated work to a person reads the state itself; there is
 * nobody's inbox for it to land in.
 */
export function workItemRecipient(item: AttentionWorkItem): string | null | undefined {
  if (item.requesterKind === 'AGENT') return undefined;
  return item.requesterId;
}

function actorColumns(actor: WorkItemActor) {
  return {
    kind: PARTICIPANT_TO_PRISMA[actor.kind],
    id: actor.userId,
    agentLabel: actor.agentLabel,
  };
}

async function settle(
  tx: PrismaTransactionClient,
  where: Prisma.AttentionItemWhereInput,
  outcome: {
    status: 'RESOLVED' | 'OBSOLETE';
    actor: WorkItemActor;
    resolution: AttentionResolution;
    resolving?: AttentionResolving | undefined;
  },
): Promise<string[]> {
  const actor = actorColumns(outcome.actor);
  const now = new Date();
  const base = {
    status: outcome.status,
    settledAt: now,
    settledByKind: actor.kind,
    settledById: actor.id,
  };
  const settled: string[] = [];
  // The item being answered gets the answer; the others the plain outcome.
  if (outcome.resolving !== undefined) {
    const answered = await tx.attentionItem.updateMany({
      where: { ...where, id: outcome.resolving.attentionItemId, status: 'OPEN' },
      data: {
        ...base,
        status: 'RESOLVED',
        resolution: {
          ...outcome.resolution,
          ...(outcome.resolving.optionId === undefined
            ? {}
            : { optionId: outcome.resolving.optionId }),
          ...(outcome.resolving.note === undefined ? {} : { note: outcome.resolving.note }),
        },
      },
    });
    if (answered.count > 0) settled.push(outcome.resolving.attentionItemId);
  }
  const rest = await tx.attentionItem.updateManyAndReturn({
    where: { ...where, status: 'OPEN' },
    data: { ...base, resolution: outcome.resolution },
    select: { id: true },
  });
  settled.push(...rest.map((row) => row.id));
  return settled;
}

/**
 * What a checkpoint asked for adds to the item a state raises (issue #140):
 * an agent that asks for review hands over its context and where the work
 * stands, and the review item carries them.
 */
export type CheckpointExtras = Pick<AttentionDraft, 'context' | 'workState'>;

function systemDraft(input: {
  item: AttentionWorkItem;
  state: NonNullable<(typeof WAITING_STATES)[PrismaStatus]>;
  status: PrismaStatus;
  reason: string | null;
  actor: WorkItemActor;
  recipientId: string | null;
  checkpoint: CheckpointExtras | undefined;
}): AttentionDraft {
  const { item, state, status, reason, actor, recipientId } = input;
  const columns = actorColumns(actor);
  return {
    ...input.checkpoint,
    // The run that moved the work here is the one an answer carries on.
    aiRunId: actor.runId ?? null,
    workspaceId: item.workspaceId,
    kind: state.kind,
    title: item.title,
    reason,
    urgency: item.priority === 'URGENT' ? 'HIGH' : item.priority,
    recipientId,
    raisedByKind: columns.kind,
    raisedById: columns.id,
    agentLabel: columns.agentLabel,
    system: true,
    workItemId: item.id,
    options: state.options.map((id) => ({ id, label: null })),
    noteMode: state.noteMode,
    dedupeKey: attentionDedupeKeys.workItemState(item.id, STATUS_FROM_PRISMA[status]),
  };
}

/**
 * A work item moved from one status to another.
 *
 * Settles what the old status raised (and, leaving `waiting_for_human`, the
 * questions the work waited on), settles everything when the work closes,
 * and raises the item the new status asks for -- unless the work waits on a
 * question somebody asked explicitly, which already is that item.
 */
export async function syncWorkItemTransition(
  tx: PrismaTransactionClient,
  input: {
    item: AttentionWorkItem;
    from: PrismaStatus;
    to: PrismaStatus;
    reason: string | null;
    actor: WorkItemActor;
    resolving?: AttentionResolving | undefined;
    checkpoint?: CheckpointExtras | undefined;
  },
): Promise<AttentionChanges> {
  const { item, from, to, actor, resolving } = input;
  const changes = emptyChanges();
  if (from === to) return changes;

  const cancelled = to === 'CANCELLED';
  const outcome = {
    status: cancelled ? ('OBSOLETE' as const) : ('RESOLVED' as const),
    actor,
    resolution: cancelled
      ? { workItemStatus: STATUS_FROM_PRISMA[to], reason: 'work_item_cancelled' }
      : { workItemStatus: STATUS_FROM_PRISMA[to] },
    resolving,
  };

  const leaving: Prisma.AttentionItemWhereInput[] = [
    { dedupeKey: attentionDedupeKeys.workItemState(item.id, STATUS_FROM_PRISMA[from]) },
  ];
  // A question that stops nothing (issue #140) outlives the waiting state.
  if (from === 'WAITING_FOR_HUMAN') {
    leaving.push({ kind: { in: QUESTION_KINDS_PRISMA }, blocking: true });
  }
  const where: Prisma.AttentionItemWhereInput = CLOSED.includes(to)
    ? { workItemId: item.id }
    : { workItemId: item.id, OR: leaving };
  changes.settled.push(...(await settle(tx, where, outcome)));

  const state = WAITING_STATES[to];
  const recipientId = workItemRecipient(item);
  if (state === undefined || recipientId === undefined) return changes;
  if (to === 'WAITING_FOR_HUMAN') {
    const asked = await tx.attentionItem.count({
      where: {
        workItemId: item.id,
        status: 'OPEN',
        kind: { in: QUESTION_KINDS_PRISMA },
        blocking: true,
      },
    });
    if (asked > 0) return changes;
  }
  changes.raised.push(
    ...(await raiseAttentionItems(tx, [
      systemDraft({
        item,
        state,
        status: to,
        reason: input.reason,
        actor,
        recipientId,
        checkpoint: input.checkpoint,
      }),
    ])),
  );
  return changes;
}

/** A new run replaces the failed ones before it: nobody has to decide about them any more. */
export async function syncRunStarted(
  tx: PrismaTransactionClient,
  input: {
    workItemId: string;
    runId: string;
    actor: WorkItemActor;
    resolving?: AttentionResolving | undefined;
  },
): Promise<AttentionChanges> {
  const settled = await settle(
    tx,
    { workItemId: input.workItemId, kind: 'RUN_FAILED' },
    {
      status: 'RESOLVED',
      actor: input.actor,
      resolution: { runId: input.runId },
      resolving: input.resolving,
    },
  );
  return { raised: [], settled };
}

/** The work item is about to be deleted: what it asked is moot. */
export async function syncWorkItemDeleted(
  tx: PrismaTransactionClient,
  input: { workItemId: string; actor: WorkItemActor },
): Promise<AttentionChanges> {
  const settled = await settle(
    tx,
    { workItemId: input.workItemId },
    { status: 'OBSOLETE', actor: input.actor, resolution: { reason: 'work_item_deleted' } },
  );
  return { raised: [], settled };
}

/**
 * Settles one item directly: an answer that changes no work item state, or a
 * withdrawal. Returns false when it was no longer open, which the caller turns
 * into `attention_item_settled` -- somebody else was faster.
 */
export async function settleOne(
  tx: PrismaTransactionClient,
  input: {
    attentionItemId: string;
    status: 'RESOLVED' | 'OBSOLETE';
    actor: WorkItemActor;
    resolution: AttentionResolution;
  },
): Promise<boolean> {
  const settled = await settle(
    tx,
    { id: input.attentionItemId },
    { status: input.status, actor: input.actor, resolution: input.resolution },
  );
  return settled.length > 0;
}
