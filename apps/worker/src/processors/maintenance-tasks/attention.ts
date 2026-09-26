import { attentionDedupeKeys, type AttentionDraft, raiseAttentionItems } from '@exocortex/database';

import { DAY_MS, type MaintenanceTask } from './context';

/** How far back a failure still asks for a decision. Older ones were seen or do not matter. */
const LOOKBACK_MS = DAY_MS;
const BATCH = 100;

/**
 * Raises one attention item per failed run behind an open work item (issue
 * #139, ADR-067).
 *
 * The run's status says the attempt ended; the work item's status still says
 * what somebody decided, and ADR-066 keeps it that way. What changes is that
 * somebody is now asked: another attempt, or give up. Only the latest run of
 * an item counts -- an earlier failure that a newer run already followed is
 * history -- and a run that ever had an item never gets a second one, even
 * after the first was settled.
 */
export const raiseRunFailureAttention: MaintenanceTask = async ({
  prisma,
  bus,
  payload,
  logger,
}) => {
  const since = new Date(Date.now() - LOOKBACK_MS);
  const candidates = await prisma.aiRun.findMany({
    where: {
      status: { in: ['FAILED', 'TIMED_OUT'] },
      finishedAt: { gte: since },
      workItem: { closedAt: null },
    },
    select: {
      id: true,
      createdById: true,
      errorCode: true,
      createdAt: true,
      workItem: {
        select: {
          id: true,
          workspaceId: true,
          title: true,
          priority: true,
          requesterKind: true,
          requesterId: true,
          runs: { select: { id: true }, orderBy: { createdAt: 'desc' }, take: 1 },
        },
      },
    },
    orderBy: { finishedAt: 'asc' },
    take: BATCH,
  });

  const latest = candidates.filter(
    (run) => run.workItem !== null && run.workItem.runs[0]?.id === run.id,
  );
  if (latest.length === 0) return;

  const keys = latest.map((run) => attentionDedupeKeys.runFailed(run.id));
  const seen = new Set(
    (
      await prisma.attentionItem.findMany({
        where: { dedupeKey: { in: keys } },
        select: { dedupeKey: true },
      })
    ).map((row) => row.dedupeKey),
  );

  const drafts: AttentionDraft[] = [];
  for (const run of latest) {
    const item = run.workItem;
    const dedupeKey = attentionDedupeKeys.runFailed(run.id);
    if (item === null || seen.has(dedupeKey)) continue;
    drafts.push({
      workspaceId: item.workspaceId,
      kind: 'RUN_FAILED',
      title: item.title,
      reason: run.errorCode,
      urgency: item.priority === 'URGENT' ? 'HIGH' : item.priority,
      // The person who asked for the work, or failing that the one who
      // started the run: an agent-requested item has nobody else to ask.
      recipientId: item.requesterKind === 'AGENT' ? run.createdById : item.requesterId,
      raisedByKind: 'ASSISTANT',
      raisedById: run.createdById,
      agentLabel: null,
      system: true,
      workItemId: item.id,
      aiRunId: run.id,
      options: [
        { id: 'retry', label: null },
        { id: 'give_up', label: null },
      ],
      noteMode: 'OPTIONAL',
      dedupeKey,
    });
  }

  const raised: string[] = [];
  for (const draft of drafts) {
    const ids = await raiseAttentionItems(prisma, [draft]);
    raised.push(...ids);
    if (ids.length === 0) continue;
    await bus.publish({
      type: 'attention.changed',
      workspaceId: draft.workspaceId,
      correlationId: payload.correlationId,
      emittedAt: new Date().toISOString(),
      payload: { attentionItemIds: ids, action: 'raised' },
    });
  }
  logger.info('Run failure attention raised', { raised: raised.length, candidates: latest.length });
};
