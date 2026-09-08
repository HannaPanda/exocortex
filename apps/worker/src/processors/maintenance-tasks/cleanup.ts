import { AI_RUN_PICKUP_GRACE_MS, deriveAiRunTimeouts } from '@exocortex/contracts';
import { type Prisma } from '@exocortex/database';

import { DAY_MS, type MaintenanceTask } from './context';

/**
 * How long an expired, unredeemed invitation stays in the list before the sweep
 * removes it. Thirty days: long enough that "did I ever invite them?" still has
 * an answer, short enough that the list stays about the present.
 */
const INVITATION_RETENTION_MS = 30 * DAY_MS;

/** Removes cover images that no page points at any more. */
export const collectOrphanedCovers: MaintenanceTask = async (context) => {
  const { prisma, storage, payload, logger, reportProgress } = context;
  await reportProgress(10, 'Ersetzte Titelbilder werden aufgeräumt');
  // Only files uploaded *as* a cover are collected. Replacing a cover
  // leaves the previous image behind with nothing pointing at it, and
  // nothing else ever will: the cover upload route stores its own copy.
  const orphans = await prisma.attachment.findMany({
    where: {
      isCover: true,
      deletedAt: null,
      coverOf: { none: {} },
      createdAt: { lt: new Date(Date.now() - context.orphanedCoverGraceMs) },
      ...(payload.workspaceId === null ? {} : { workspaceId: payload.workspaceId }),
    },
    select: { id: true, storageKey: true, previewKey: true },
  });

  let removed = 0;
  for (const orphan of orphans) {
    // Same order as the attachment delete route: mark the row first, then
    // the object. A failed object delete leaves a row already marked
    // deleted, which is the harmless direction.
    await prisma.attachment.update({ where: { id: orphan.id }, data: { deletedAt: new Date() } });
    // The downscaled copy goes with it; it is derived from a file that is
    // about to stop existing.
    const keys = [orphan.storageKey, orphan.previewKey].filter(
      (key): key is string => key !== null,
    );
    let failed = false;
    for (const key of keys) {
      try {
        await storage.deleteObject({ key });
      } catch (error) {
        failed = true;
        logger.error('Failed to delete an orphaned cover object', error, {
          attachmentId: orphan.id,
          storageKey: key,
        });
      }
    }
    if (!failed) removed += 1;
  }
  await reportProgress(100, 'Titelbilder aufgeräumt');
  logger.info('Orphaned covers collected', { removed, candidates: orphans.length });
};

/**
 * Closes out AI runs whose worker never came back.
 *
 * Second line of defence behind the processor's own guard (`ai-run.ts`, part
 * a): a run whose worker crashed hard enough to never re-enqueue at all is only
 * ever found here.
 */
export const reapStaleAiRuns: MaintenanceTask = async (context) => {
  const { prisma, bus, payload, logger } = context;
  const timeouts = deriveAiRunTimeouts(await context.settings());
  const now = Date.now();
  const abandonedBefore = new Date(now - timeouts.heartbeatStaleMs);
  const budgetBefore = new Date(now - timeouts.reaperDeadlineMs);
  const pendingBefore = new Date(now - AI_RUN_PICKUP_GRACE_MS);

  const candidates = await prisma.aiRun.findMany({
    where: {
      OR: [
        { status: 'RUNNING', heartbeatAt: { lt: abandonedBefore } },
        { status: 'RUNNING', heartbeatAt: null, startedAt: { lt: abandonedBefore } },
        { status: 'RUNNING', startedAt: { lt: budgetBefore } },
        // A row that reached RUNNING without ever recording a start: the
        // status write and the `startedAt` write are one statement now,
        // but rows from before that are out there, and a crash between
        // the two would produce one again. Without this clause it has no
        // timestamp any other clause can compare against, so it would
        // stay RUNNING forever and keep its conversation locked.
        {
          status: 'RUNNING',
          heartbeatAt: null,
          startedAt: null,
          createdAt: { lt: abandonedBefore },
        },
        // Never picked up: the job was lost between creating the row and
        // enqueueing it, or Redis lost it. Without this the conversation
        // stays locked (`ai_conversation_locked`) forever.
        { status: 'PENDING', createdAt: { lt: pendingBefore } },
      ],
    },
    select: { id: true, workspaceId: true, status: true, startedAt: true },
    take: 100,
  });

  let reaped = 0;
  for (const candidate of candidates) {
    const timedOut =
      candidate.status === 'RUNNING' &&
      candidate.startedAt !== null &&
      candidate.startedAt < budgetBefore;
    const errorCode =
      candidate.status === 'PENDING' ? 'ai_run_lost' : timedOut ? 'ai_timeout' : 'ai_run_abandoned';
    const closed = await prisma.aiRun.updateMany({
      where: { id: candidate.id, status: candidate.status },
      data: { status: timedOut ? 'TIMED_OUT' : 'FAILED', errorCode, finishedAt: new Date() },
    });
    if (closed.count === 0) continue; // Ended on its own in the meantime.
    await bus.publish({
      type: 'ai.run.failed',
      workspaceId: candidate.workspaceId,
      correlationId: payload.correlationId,
      emittedAt: new Date().toISOString(),
      payload: {
        runId: candidate.id,
        status: timedOut ? 'timed_out' : 'failed',
        errorCode,
        reason: `Reaped by maintenance: ${errorCode}`,
      },
    });
    reaped += 1;
  }
  logger.info('Stale AI runs reaped', { reaped, candidates: candidates.length });
};

/**
 * Ages out the agents' memory notes.
 *
 * Two stages, one setting. A note that has not been touched for the retention
 * period goes into the trash; a note that has been *in* the trash for another
 * retention period is deleted for good. Nothing in this application has ever
 * destroyed a page outright, and a background sweep is the last place that
 * should start: this way every deletion was visible and recoverable in the
 * trash for a full period first.
 *
 * `parentId: { not: null }` is what keeps the project pages: they are the roots
 * of the memory workspace and hold the notes that are still current.
 *
 * Two more things are kept, both since issue #46. A page carrying a distilled
 * fact survives its own evidence on purpose: a fact was distilled precisely so
 * that it would outlive the notes it came from, and ageing it out on the notes'
 * schedule would undo the whole mechanism. A page with children survives too,
 * which is what protects the `Fakten` page the facts hang under, and anything
 * else somebody has built structure out of down here.
 */
export const pruneMemories: MaintenanceTask = async (context) => {
  const { prisma, payload, logger, reportProgress } = context;
  const settings = await context.settings();
  const retentionDays = settings['memory.retentionDays'];
  const workspaceId = settings['memory.workspaceId'];
  if (retentionDays === 0 || workspaceId === null) return;

  const cutoff = new Date(Date.now() - retentionDays * DAY_MS);
  await reportProgress(10, 'Altes Gedächtnis wird aufgeräumt');

  const expiring = await prisma.document.findMany({
    where: {
      workspaceId,
      parentId: { not: null },
      archivedAt: null,
      updatedAt: { lt: cutoff },
      memoryFact: { is: null },
      children: { none: {} },
    },
    select: { id: true },
  });

  const now = new Date();
  if (expiring.length > 0) {
    await prisma.document.updateMany({
      where: { id: { in: expiring.map((row) => row.id) } },
      data: { archivedAt: now },
    });
    // The search projection has to learn that these left the active
    // tree, or recall keeps answering with notes that are in the trash.
    // Writing outbox rows rather than enqueuing directly keeps this on
    // the same path an archive from the API takes (ADR-010).
    await prisma.outboxEvent.createMany({
      data: expiring.map((row) => ({
        workspaceId,
        type: 'document.archived',
        payload: { documentId: row.id },
        correlationId: payload.correlationId,
      })),
    });
  }

  const purgeable = await prisma.document.findMany({
    where: { workspaceId, parentId: { not: null }, archivedAt: { lt: cutoff } },
    select: { id: true },
  });
  // Cascades take the content, the search projection, the embeddings and
  // the snapshots with them; there is no second sweep to write.
  const purged =
    purgeable.length === 0
      ? { count: 0 }
      : await prisma.document.deleteMany({
          where: { id: { in: purgeable.map((row) => row.id) } },
        });

  await reportProgress(100, 'Gedächtnis aufgeräumt');
  logger.info('Memory notes pruned', {
    archived: expiring.length,
    purged: purged.count,
    retentionDays,
    workspaceId,
  });
};

/**
 * Removes invitations that expired long ago and were never taken up (issue #3).
 *
 * Deletion rather than archival, because an unredeemed invitation is not a
 * record of anything: nobody arrived, nothing points at it. What *is* kept is
 * every accepted one -- `acceptedAt: null` in the filter -- since that row is
 * the answer to "where did this account come from".
 *
 * The grace period exists so an administrator looking at the list a week after
 * an expiry still sees what happened, instead of wondering whether they ever
 * sent it. Withdrawn invitations age out on the same clock: `expiresAt` keeps
 * running whether the invitation was revoked or not.
 */
export const pruneInvitations: MaintenanceTask = async ({ prisma, logger, reportProgress }) => {
  await reportProgress(10, 'Alte Einladungen werden aufgeräumt');
  const cutoff = new Date(Date.now() - INVITATION_RETENTION_MS);
  const removed = await prisma.invitation.deleteMany({
    where: { acceptedAt: null, expiresAt: { lt: cutoff } },
  });

  await reportProgress(100, 'Einladungen aufgeräumt');
  if (removed.count > 0) {
    logger.info('Expired invitations pruned', { removed: removed.count });
  }
};

/**
 * Empties the two fat columns on old AI runs (issue #10).
 *
 * The usage view is meant to answer questions about months, and the only
 * reason keeping months of runs would be expensive is `messages` and
 * `resultText` -- a prompt and an answer, in full, per run. The figures a usage
 * question actually groups over are small integer columns, so this drops the
 * text and keeps the row.
 *
 * Deliberately not a rollup table. A daily rollup would make the history
 * smaller still, but it fixes the breakdowns at the moment it is written: a
 * question nobody thought of when the table was designed can never be asked
 * about the past again. Keeping one thin row per run costs a few dozen bytes
 * and keeps every breakdown open, which is the better trade for a deployment
 * this size.
 *
 * Only finished runs are touched -- a PENDING or RUNNING row still needs its
 * prompt to be executed at all -- and `payloadsPrunedAt` records that the texts
 * were removed, so nothing has to infer it from an empty column.
 */
export const pruneAiRunPayloads: MaintenanceTask = async (context) => {
  const { prisma, logger, reportProgress } = context;
  const retentionDays = (await context.settings())['ai.runPayloadRetentionDays'];
  if (retentionDays === 0) return;

  await reportProgress(10, 'Alte KI-Texte werden aufgeräumt');
  const cutoff = new Date(Date.now() - retentionDays * DAY_MS);
  const pruned = await prisma.aiRun.updateMany({
    where: {
      status: { notIn: ['PENDING', 'RUNNING'] },
      createdAt: { lt: cutoff },
      payloadsPrunedAt: null,
    },
    data: {
      // An empty array rather than JSON null: `messages` is not nullable, and
      // "this run submitted no messages" is at least a shape every reader
      // already handles.
      messages: [] as unknown as Prisma.InputJsonArray,
      resultText: null,
      payloadsPrunedAt: new Date(),
    },
  });

  await reportProgress(100, 'KI-Texte aufgeräumt');
  if (pruned.count > 0) {
    logger.info('AI run payloads pruned', { pruned: pruned.count, retentionDays });
  }
};
