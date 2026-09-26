import { type PrismaTransactionClient } from '@exocortex/database';

import { type WorkItemActor } from './work-item-actor';
import { type WorkItemEventDraft } from './work-item-changes';
import { PARTICIPANT_TO_PRISMA } from './work-item-mapper';

/**
 * Writing a work item's history (issue #138, ADR-066).
 *
 * Always inside the transaction of the change, so the history never says
 * something happened that was rolled back.
 */

export function eventActor(workItemId: string, actor: WorkItemActor, correlationId: string) {
  return {
    workItemId,
    actorKind: PARTICIPANT_TO_PRISMA[actor.kind],
    actorId: actor.userId,
    agentLabel: actor.agentLabel,
    correlationId,
  };
}

export async function writeEvents(
  tx: PrismaTransactionClient,
  workItemId: string,
  actor: WorkItemActor,
  events: readonly WorkItemEventDraft[],
  correlationId: string,
): Promise<void> {
  const base = eventActor(workItemId, actor, correlationId);
  const now = Date.now();
  // Explicit timestamps one millisecond apart, so the lines of one change
  // keep the order they were planned in when sorted by time.
  for (const [index, event] of events.entries()) {
    await tx.workItemEvent.create({
      data: { ...base, kind: event.kind, data: event.data, createdAt: new Date(now + index) },
    });
  }
}
