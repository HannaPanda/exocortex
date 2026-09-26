import { recordWorkCheckpoint } from '@exocortex/database';

import { DAY_MS, type MaintenanceContext, type MaintenanceTask } from './context';

/** How far back an ended run still gets its checkpoint. Older ones were picked up or do not matter. */
const LOOKBACK_MS = DAY_MS;
const BATCH = 100;

/**
 * Records where the work stood when a run behind it ended without finishing
 * it (issue #142, ADR-069): failed, timed out, lost its worker, or was
 * cancelled.
 *
 * The run cannot say so itself -- it is gone -- so eXocortex carries the last
 * recorded state forward, marks it `run_interrupted` with the run's error
 * code, and notes the last tool call that came back. A later run, perhaps on
 * another provider because this one ran out of quota, starts from there. Only
 * the latest run of an open item counts, and the partial unique index over
 * interrupted runs makes a second pass over the same run write nothing.
 */
/**
 * The last tool call of the run that came back, as a tool name and a time.
 * Language-neutral on purpose: read by a person in any locale and by the next
 * run alike. Null when the run called no tool, which carries the previous
 * checkpoint's line forward instead.
 */
async function lastToolCall(
  prisma: MaintenanceContext['prisma'],
  runId: string,
  conversationId: string | null,
): Promise<string | null> {
  if (conversationId === null) return null;
  const message = await prisma.aiConversationMessage.findFirst({
    where: { conversationId, runId, role: 'TOOL' },
    select: { toolName: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
  });
  if (message?.toolName == null) return null;
  const at = message.createdAt.toISOString().slice(0, 16).replace('T', ' ');
  return `${message.toolName} · ${at} UTC`;
}

export const checkpointInterruptedRuns: MaintenanceTask = async ({ prisma, payload, logger }) => {
  const since = new Date(Date.now() - LOOKBACK_MS);
  const candidates = await prisma.aiRun.findMany({
    where: {
      status: { in: ['FAILED', 'TIMED_OUT', 'CANCELLED'] },
      finishedAt: { gte: since },
      workItem: { closedAt: null },
      checkpoints: { none: { trigger: 'RUN_INTERRUPTED' } },
    },
    select: {
      id: true,
      status: true,
      errorCode: true,
      createdById: true,
      conversationId: true,
      workItem: {
        select: {
          id: true,
          runs: { select: { id: true }, orderBy: { createdAt: 'desc' }, take: 1 },
        },
      },
    },
    orderBy: { finishedAt: 'asc' },
    take: BATCH,
  });

  let recorded = 0;
  for (const run of candidates) {
    const item = run.workItem;
    if (item === null || item.runs[0]?.id !== run.id) continue;
    const lastAction = await lastToolCall(prisma, run.id, run.conversationId);
    let id: string | null = null;
    try {
      id = await prisma.$transaction((tx) =>
        recordWorkCheckpoint(tx, {
          workItemId: item.id,
          aiRunId: run.id,
          trigger: 'RUN_INTERRUPTED',
          authorKind: 'ASSISTANT',
          authorId: run.createdById,
          agentLabel: null,
          system: true,
          changes: lastAction === null ? {} : { lastAction },
          interruptionCode: run.errorCode ?? run.status.toLowerCase(),
          correlationId: payload.correlationId,
        }),
      );
    } catch (error) {
      // The work item or the run went away between the query and the write
      // (deleted for good while the sweep ran). One vanished row must not
      // cost the others their checkpoint; the next pass will not find it.
      logger.warn('Interrupted run not checkpointed', {
        runId: run.id,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    if (id !== null) recorded += 1;
  }
  logger.info('Interrupted runs checkpointed', { recorded, candidates: candidates.length });
};
