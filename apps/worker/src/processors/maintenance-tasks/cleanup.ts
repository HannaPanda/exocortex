import { AI_RUN_PICKUP_GRACE_MS, deriveAiRunTimeouts } from '@exocortex/contracts';
import { type Prisma } from '@exocortex/database';

import {
  DAY_MS,
  type MaintenanceContext,
  type MaintenanceTask,
  memoryWorkspaceIds,
} from './context';

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
        detail: null,
        detailKey: null,
        detailArgs: null,
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
 * One pass per memory area since issue #52, each with its own retention: the
 * memory is a property of a workspace now, not one id in the settings, so a
 * deployment can hold several and they age out on their own schedules.
 *
 * Two more things are kept, both since issue #46. A page carrying a distilled
 * fact survives its own evidence on purpose: a fact was distilled precisely so
 * that it would outlive the notes it came from, and ageing it out on the notes'
 * schedule would undo the whole mechanism. A page with children survives too,
 * which is what protects the `Fakten` page the facts hang under, and anything
 * else somebody has built structure out of down here.
 */
export const pruneMemories: MaintenanceTask = async (context) => {
  const workspaceIds = await memoryWorkspaceIds(context.prisma);
  if (workspaceIds.length === 0) return;

  await context.reportProgress(10, 'Altes Gedächtnis wird aufgeräumt');
  for (const workspaceId of workspaceIds) {
    const settings = await context.settings(workspaceId);
    const retentionDays = settings['memory.retentionDays'];
    if (retentionDays === 0) continue;
    await pruneOneMemory({ context, workspaceId, retentionDays });
  }
  await context.reportProgress(100, 'Gedächtnis aufgeräumt');
};

/** The sweep itself, for one memory area. */
async function pruneOneMemory(input: {
  context: MaintenanceContext;
  workspaceId: string;
  retentionDays: number;
}): Promise<void> {
  const { prisma, payload, logger } = input.context;
  const { workspaceId, retentionDays } = input;
  const cutoff = new Date(Date.now() - retentionDays * DAY_MS);

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

  // The checkpoint receipts age on the same clock as the notes they point at
  // (issue #92). They carry digests rather than evidence, so this is about a
  // list staying about the present rather than about storage: a session whose
  // notes are gone has nothing left to deduplicate against, and Hermes does not
  // resume a conversation weeks later.
  const checkpoints = await prisma.memoryCheckpoint.deleteMany({
    where: { workspaceId, createdAt: { lt: cutoff } },
  });

  logger.info('Memory notes pruned', {
    archived: expiring.length,
    purged: purged.count,
    checkpoints: checkpoints.count,
    retentionDays,
    workspaceId,
  });
}

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
 * Removes messages between agents that have stopped being delivered
 * (issue #51, ADR-047).
 *
 * Unconditional, unlike every other sweep in this file. There is no setting to
 * switch on: a message is written with an `expiresAt`, and a mailbox that kept
 * delivering past it would break the one promise that keeps it from becoming a
 * tip. Read messages are deleted on the same clock rather than immediately,
 * because "what did you tell me last week" is a question worth being able to
 * answer for as long as the message was going to live anyway.
 *
 * A hard delete, and it is the right one: a message is a delivery, not a page,
 * so there is no trash it could pass through and nothing downstream that points
 * at it.
 */
export const pruneAgentMessages: MaintenanceTask = async ({ prisma, logger, reportProgress }) => {
  await reportProgress(10, 'Abgelaufene Nachrichten werden entfernt');
  const removed = await prisma.agentMessage.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  });

  await reportProgress(100, 'Nachrichten aufgeräumt');
  if (removed.count > 0) {
    logger.info('Expired agent messages pruned', { removed: removed.count });
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

/**
 * Ages out the agents' write journal (issue #49, ADR-022).
 *
 * The journal is bookkeeping about writes, never the writes themselves: what a
 * revert actually restores are the snapshots, and those age out on their own,
 * longer schedule. So this deletes the grouping and nothing recoverable -- an
 * old session simply stops being one thing you can take back in one press.
 *
 * Sessions go with their last row rather than on a clock of their own. A
 * session row with no writes left says nothing anybody can act on, and keeping
 * it would turn the list into a graveyard of empty connections; a session still
 * holding one recent write survives, however long ago it started.
 */
export const pruneAgentJournal: MaintenanceTask = async (context) => {
  const { prisma, logger, reportProgress } = context;
  const retentionDays = (await context.settings())['agents.journalRetentionDays'];
  if (retentionDays === 0) return;

  await reportProgress(10, 'Agenten-Journal wird aufgeräumt');
  const cutoff = new Date(Date.now() - retentionDays * DAY_MS);
  const removedWrites = await prisma.agentWriteJournal.deleteMany({
    where: { createdAt: { lt: cutoff } },
  });
  const removedSessions = await prisma.agentSession.deleteMany({
    where: { lastSeenAt: { lt: cutoff }, writes: { none: {} } },
  });

  await reportProgress(100, 'Agenten-Journal aufgeräumt');
  if (removedWrites.count > 0 || removedSessions.count > 0) {
    logger.info('Agent write journal pruned', {
      writes: removedWrites.count,
      sessions: removedSessions.count,
      retentionDays,
    });
  }
};

/**
 * Deletes automation runs older than `automations.runRetentionDays`
 * (issue #50, ADR-024).
 *
 * The rules are never touched. What ages out is the record of what they did, and
 * a rule with no recent runs is a rule that had nothing to do -- which the list
 * shows as `lastTriggeredAt`, a column on the rule itself and not something this
 * sweep can take away.
 *
 * One indexed DELETE that matches nothing on a deployment quieter than its
 * retention window, which is most of them.
 */
export const pruneAutomationRuns: MaintenanceTask = async (context) => {
  const { prisma, logger, reportProgress } = context;
  const retentionDays = (await context.settings())['automations.runRetentionDays'];
  if (retentionDays === 0) return;

  await reportProgress(10, 'Automationsprotokoll wird aufgeräumt');
  const cutoff = new Date(Date.now() - retentionDays * DAY_MS);
  const removed = await prisma.automationRun.deleteMany({ where: { createdAt: { lt: cutoff } } });

  await reportProgress(100, 'Automationsprotokoll aufgeräumt');
  if (removed.count > 0) {
    logger.info('Automation runs pruned', { runs: removed.count, retentionDays });
  }
};

/**
 * Closes out builds whose worker never came back, and deletes old ones
 * (issue #44, ADR-026).
 *
 * One sweep for both because they are the same question asked at two ages: a
 * `RUNNING` job whose heartbeat stopped has lost its container and will never
 * finish, and a finished job older than `render.jobRetentionDays` is a log
 * nobody is going to read. The produced PDFs are not touched -- they are
 * ordinary attachments on the page and deleting them is the page's business.
 */
export const reapRenderJobs: MaintenanceTask = async (context) => {
  const { prisma, logger, reportProgress } = context;
  const settings = await context.settings();

  await reportProgress(10, 'Bau-Protokoll wird aufgeräumt');
  const abandonedBefore = new Date(Date.now() - RENDER_HEARTBEAT_STALE_MS);
  const abandoned = await prisma.renderJob.updateMany({
    where: {
      status: 'RUNNING',
      OR: [
        { heartbeatAt: { lt: abandonedBefore } },
        { heartbeatAt: null, startedAt: { lt: abandonedBefore } },
      ],
    },
    data: { status: 'FAILED', errorCode: 'worker_lost', finishedAt: new Date() },
  });

  const retentionDays = settings['render.jobRetentionDays'];
  const removed =
    retentionDays === 0
      ? { count: 0 }
      : await prisma.renderJob.deleteMany({
          where: {
            createdAt: { lt: new Date(Date.now() - retentionDays * DAY_MS) },
            status: { in: ['COMPLETED', 'FAILED', 'CANCELLED'] },
          },
        });

  await reportProgress(100, 'Bau-Protokoll aufgeräumt');
  if (abandoned.count > 0 || removed.count > 0) {
    logger.info('Render jobs reaped', { abandoned: abandoned.count, removed: removed.count });
  }
};

/**
 * How long a build may go without a sign of life before it counts as lost.
 *
 * Five times the worker's heartbeat interval: a machine under load can miss a
 * couple, and killing a build that is merely slow is the one failure mode this
 * sweep must not have.
 */
const RENDER_HEARTBEAT_STALE_MS = 25_000;

/**
 * The same two sweeps for project builds (issue #43, ADR-027).
 *
 * Separate from `reapRenderJobs` rather than generalised over both tables: the
 * two share a shape and nothing else -- their own settings, their own retention
 * and their own idea of what a lost worker leaves behind -- and a helper taking
 * a table name would have to be told all three anyway.
 */
export const reapProjectBuilds: MaintenanceTask = async (context) => {
  const { prisma, logger, reportProgress } = context;
  const settings = await context.settings();

  await reportProgress(10, 'Projekt-Bauten werden aufgeräumt');
  const abandonedBefore = new Date(Date.now() - RENDER_HEARTBEAT_STALE_MS);
  const abandoned = await prisma.projectBuild.updateMany({
    where: {
      status: 'RUNNING',
      OR: [
        { heartbeatAt: { lt: abandonedBefore } },
        { heartbeatAt: null, startedAt: { lt: abandonedBefore } },
      ],
    },
    data: { status: 'FAILED', errorCode: 'worker_lost', finishedAt: new Date() },
  });

  const retentionDays = settings['projects.buildRetentionDays'];
  const removed =
    retentionDays === 0
      ? { count: 0 }
      : await prisma.projectBuild.deleteMany({
          where: {
            createdAt: { lt: new Date(Date.now() - retentionDays * DAY_MS) },
            status: { in: ['COMPLETED', 'FAILED', 'CANCELLED'] },
          },
        });

  await reportProgress(100, 'Projekt-Bauten aufgeräumt');
  if (abandoned.count > 0 || removed.count > 0) {
    logger.info('Project builds reaped', { abandoned: abandoned.count, removed: removed.count });
  }
};
