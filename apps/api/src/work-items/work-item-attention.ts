import { type UpdateWorkItemRequest } from '@exocortex/contracts';
import {
  type PrismaTransactionClient,
  type WorkItemStatus as PrismaStatus,
} from '@exocortex/database';

import {
  type AttentionChanges,
  type AttentionResolving,
  type AttentionWorkItem,
  settleOne,
  syncWorkItemTransition,
} from '../attention/attention-sync';
import { AppError } from '../common/app-error';

import { type WorkItemActor } from './work-item-actor';
import { type ExistingWorkItem, planWorkItemUpdate } from './work-item-changes';
import { eventActor, writeEvents } from './work-item-events';
import { PRIORITY_TO_PRISMA, STATUS_FROM_PRISMA } from './work-item-mapper';

/**
 * Where a work item change meets its attention items (issue #139, ADR-067).
 *
 * Every function runs inside the transaction of the work item change, so a
 * status, its history line and the attention item it raises or settles are
 * one write.
 */

export type AttentionWorkItemRow = ExistingWorkItem &
  Omit<AttentionWorkItem, 'id'> & { id: string };

/** The item as its attention sees it, with a title or priority this change sets. */
export function attentionView(
  row: Omit<AttentionWorkItem, never>,
  request: Pick<UpdateWorkItemRequest, 'title' | 'priority'>,
): AttentionWorkItem {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    title: request.title ?? row.title,
    priority: request.priority === undefined ? row.priority : PRIORITY_TO_PRISMA[request.priority],
    requesterKind: row.requesterKind,
    requesterId: row.requesterId,
  };
}

/** A status move made on the item's behalf, with its history line and its attention. */
export async function transitionWorkItem(
  tx: PrismaTransactionClient,
  input: {
    existing: AttentionWorkItemRow;
    to: PrismaStatus;
    reason: string | null;
    actor: WorkItemActor;
    correlationId: string;
  },
): Promise<AttentionChanges> {
  const { existing, to, reason, actor, correlationId } = input;
  const plan = planWorkItemUpdate({
    existing,
    request: { status: STATUS_FROM_PRISMA[to], statusReason: reason },
    assigneeName: null,
    now: new Date(),
  });
  await tx.workItem.update({ where: { id: existing.id }, data: plan.data });
  await writeEvents(tx, existing.id, actor, plan.events, correlationId);
  return syncWorkItemTransition(tx, {
    item: attentionView(existing, {}),
    from: existing.status,
    to,
    reason,
    actor,
  });
}

/** The answer, in the work item's history, where the agent that asked reads it. */
export async function writeAnswerEvent(
  tx: PrismaTransactionClient,
  input: {
    workItemId: string;
    actor: WorkItemActor;
    resolving: AttentionResolving;
    attentionKind: string;
    correlationId: string;
  },
): Promise<void> {
  const { workItemId, actor, resolving, attentionKind, correlationId } = input;
  await tx.workItem.update({ where: { id: workItemId }, data: { updatedAt: new Date() } });
  await tx.workItemEvent.create({
    data: {
      ...eventActor(workItemId, actor, correlationId),
      kind: 'ATTENTION_RESOLVED',
      data: {
        attentionItemId: resolving.attentionItemId,
        attentionKind,
        ...(resolving.optionId === undefined ? {} : { optionId: resolving.optionId }),
      },
      note: resolving.note ?? null,
    },
  });
}

/**
 * Keeps attention in step with a status change.
 *
 * An answer from the inbox whose change did not move the status (the work
 * was already there) is still settled, so the button a person pressed is
 * never left without an effect.
 */
export async function syncAfterTransition(
  tx: PrismaTransactionClient,
  input: {
    item: AttentionWorkItem;
    from: PrismaStatus;
    to: PrismaStatus;
    reason: string | null;
    actor: WorkItemActor;
    correlationId: string;
    resolving: AttentionResolving | undefined;
  },
): Promise<AttentionChanges> {
  const changes = await syncWorkItemTransition(tx, input);
  const { resolving } = input;
  if (resolving === undefined) return changes;
  if (!changes.settled.includes(resolving.attentionItemId)) {
    const settled = await settleOne(tx, {
      attentionItemId: resolving.attentionItemId,
      status: 'RESOLVED',
      actor: input.actor,
      resolution: {
        workItemStatus: STATUS_FROM_PRISMA[input.to],
        ...(resolving.optionId === undefined ? {} : { optionId: resolving.optionId }),
        ...(resolving.note === undefined ? {} : { note: resolving.note }),
      },
    });
    if (!settled) throw new AppError('attention_item_settled', 'The item is already settled');
    changes.settled.push(resolving.attentionItemId);
  }
  const kind = await tx.attentionItem.findUnique({
    where: { id: resolving.attentionItemId },
    select: { kind: true },
  });
  await writeAnswerEvent(tx, {
    workItemId: input.item.id,
    actor: input.actor,
    resolving,
    attentionKind: kind?.kind.toLowerCase() ?? 'information',
    correlationId: input.correlationId,
  });
  return changes;
}
