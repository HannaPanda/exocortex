import { DAY_MS, isMissingDocument, type MaintenanceTask, WEEK_MS } from './context';

/** Epoch-day / epoch-week bucket. Not calendar-aware (no ISO week rules) on purpose: a deterministic, testable index is all tiered retention needs. */
function dayBucket(date: Date): number {
  return Math.floor(date.getTime() / DAY_MS);
}
function weekBucket(date: Date): number {
  return Math.floor(date.getTime() / WEEK_MS);
}

/**
 * Tiered snapshot retention (issue #20, point 4).
 *
 * `snapshots` needs no particular order; this sorts newest-first itself.
 * Everything younger than `fullCutoff` is kept outright. Between
 * `fullCutoff` and `dailyCutoff`, at most one snapshot per epoch-day
 * survives (the newest -- the first one encountered once sorted). Older than
 * `dailyCutoff`, at most one per epoch-week survives. A day or week with
 * only one snapshot in it loses nothing: it has no second entry to delete,
 * which is what keeps a lightly edited document from being thinned at all.
 *
 * Exported and pure so the edge cases ("too little data to prune") are unit
 * tests, not database round trips.
 */
export function pruneSnapshotIds(
  snapshots: readonly { id: string; createdAt: Date }[],
  cutoffs: { fullCutoff: Date; dailyCutoff: Date },
): string[] {
  const sorted = [...snapshots].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const toDelete: string[] = [];
  const seenDaily = new Set<number>();
  const seenWeekly = new Set<number>();

  for (const snapshot of sorted) {
    if (snapshot.createdAt >= cutoffs.fullCutoff) continue;

    if (snapshot.createdAt >= cutoffs.dailyCutoff) {
      const key = dayBucket(snapshot.createdAt);
      if (seenDaily.has(key)) {
        toDelete.push(snapshot.id);
      } else {
        seenDaily.add(key);
      }
      continue;
    }

    const key = weekBucket(snapshot.createdAt);
    if (seenWeekly.has(key)) {
      toDelete.push(snapshot.id);
    } else {
      seenWeekly.add(key);
    }
  }

  return toDelete;
}

/**
 * The most snapshots one nightly run deletes (issue #235).
 *
 * Retention had been a dry run since it shipped, so the first real run meets
 * every version a deployment ever kept. Taking that backlog a few hundred at a
 * time means a setting entered wrongly costs a night's worth, which the log
 * line of each page shows the next morning, rather than a year's.
 */
export const SNAPSHOT_PRUNE_MAX_PER_RUN = 200;

/**
 * What to delete of one page's versions: the tiers of `pruneSnapshotIds`,
 * minus the snapshots nothing may take, within what is left of the run's
 * budget. Pure for the same reason as the tiers.
 *
 * A protected snapshot still counts as its bucket's survivor if it is the
 * newest of that day or week; it is only never the one deleted. So a day with
 * a journalled write keeps that state and its newest one, which is one more
 * than the tier asks for and never one less.
 */
export function snapshotsToThin(
  snapshots: readonly { id: string; createdAt: Date }[],
  cutoffs: { fullCutoff: Date; dailyCutoff: Date },
  keep: ReadonlySet<string>,
  budget: number,
): string[] {
  if (budget <= 0) return [];
  return pruneSnapshotIds(snapshots, cutoffs)
    .filter((id) => !keep.has(id))
    .slice(0, budget);
}

/**
 * Thins the stored versions of every page down to the tiers its workspace is
 * configured for (ADR-023: a workspace may keep them for less time than the
 * deployment, never longer).
 */
export const pruneSnapshots: MaintenanceTask = async (context) => {
  const { prisma, payload, logger, reportProgress } = context;
  await reportProgress(10, 'pruningSnapshots');
  // Whether thinning deletes at all is the deployment's decision alone.
  const dryRun = (await context.settings())['activity.snapshotRetentionDryRun'];
  const now = Date.now();

  const workspaces = await prisma.workspace.findMany({
    where: payload.workspaceId === null ? {} : { id: payload.workspaceId },
    select: { id: true },
    orderBy: { id: 'asc' },
  });

  let budget = SNAPSHOT_PRUNE_MAX_PER_RUN;
  let removed = 0;
  let candidates = 0;
  let documentCount = 0;
  for (const workspace of workspaces) {
    if (budget <= 0) break;
    const settings = await context.settings(workspace.id);
    const fullDays = settings['activity.snapshotRetentionFullDays'];
    const dailyDays = settings['activity.snapshotRetentionDailyDays'];
    const cutoffs = {
      fullCutoff: new Date(now - fullDays * DAY_MS),
      dailyCutoff: new Date(now - dailyDays * DAY_MS),
    };

    const documents = await prisma.document.findMany({
      where: { workspaceId: workspace.id },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    documentCount += documents.length;

    for (const document of documents) {
      if (budget <= 0) break;
      // `MANUAL` is exempt from age-based thinning: a deliberately named
      // version is not the "regular checkpoint" this retention tier is
      // about, and pruning it by age alone would defeat the one
      // permanent restore point a person asked for. Nothing younger than
      // the full window is read at all.
      const snapshots = await prisma.documentSnapshot.findMany({
        where: {
          documentId: document.id,
          reason: { not: 'MANUAL' },
          createdAt: { lt: cutoffs.fullCutoff },
        },
        select: { id: true, createdAt: true },
      });
      if (snapshots.length < 2) continue;

      // A snapshot a write journal points at is what taking that write back
      // restores (ADR-022, ADR-094). It ages out with its journal row
      // (`agents.journalRetentionDays`), not before.
      const journalled = await prisma.agentWriteJournal.findMany({
        where: {
          documentId: document.id,
          snapshotBeforeId: { in: snapshots.map((row) => row.id) },
        },
        select: { snapshotBeforeId: true },
      });
      const keep = new Set(journalled.flatMap((row) => row.snapshotBeforeId ?? []));

      const toDelete = snapshotsToThin(snapshots, cutoffs, keep, budget);
      if (toDelete.length === 0) continue;
      candidates += toDelete.length;
      budget -= toDelete.length;
      if (!dryRun) {
        const result = await prisma.documentSnapshot.deleteMany({
          where: { id: { in: toDelete } },
        });
        removed += result.count;
      }
      // One line per page, so what a night thinned can be read back by page.
      logger.info('Thinned the stored versions of a page', {
        documentId: document.id,
        workspaceId: workspace.id,
        thinned: toDelete.length,
        olderThanFullWindow: snapshots.length,
        protectedByJournal: keep.size,
        fullDays,
        dailyDays,
        dryRun,
      });
    }
  }
  await reportProgress(100, 'done');
  logger.info('Snapshots pruned', {
    removed,
    candidates,
    dryRun,
    documents: documentCount,
    workspaces: workspaces.length,
    budgetLeft: budget,
    limitReached: budget <= 0,
  });
};

/** Takes a checkpoint of every page someone is editing right now. */
export const snapshotActiveDocuments: MaintenanceTask = async (context) => {
  const { prisma, payload, logger } = context;
  const settings = await context.settings();
  if (!settings['activity.editSessionSnapshotsEnabled']) return;

  const intervalMs = settings['activity.editSessionSnapshotIntervalMinutes'] * 60_000;
  const activeSince = new Date(Date.now() - intervalMs);

  // A page whose content changed inside the interval is "active"; one
  // whose last edit is older than that is left alone entirely, which is
  // what keeps this cheap -- most pages are not being edited at any
  // given moment. Only typing counts (issue #235): `yjsUpdatedById` is set by
  // a store from somebody's connection and cleared by a write through the
  // API, which already left a version of its own with its own author.
  const candidates = await prisma.documentContent.findMany({
    where: {
      yjsUpdatedAt: { gte: activeSince },
      yjsUpdatedById: { not: null },
      ...(payload.workspaceId === null ? {} : { document: { workspaceId: payload.workspaceId } }),
    },
    select: {
      documentId: true,
      yjsState: true,
      schemaVersion: true,
      yjsUpdatedAt: true,
      yjsUpdatedById: true,
    },
    orderBy: { yjsUpdatedAt: 'desc' },
    take: 200,
  });

  let taken = 0;
  let vanished = 0;
  for (const candidate of candidates) {
    const latest = await prisma.documentSnapshot.findFirst({
      where: { documentId: candidate.documentId },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    // Two independent guards: nothing changed since the last checkpoint
    // (nothing new to capture), or the last checkpoint is too recent
    // (this is what "every N minutes" means, not "every sweep").
    const changedSinceLast = latest === null || latest.createdAt < candidate.yjsUpdatedAt;
    const dueForNext = latest === null || Date.now() - latest.createdAt.getTime() >= intervalMs;
    if (!changedSinceLast || !dueForNext) continue;

    try {
      await prisma.documentSnapshot.create({
        data: {
          documentId: candidate.documentId,
          yjsState: candidate.yjsState,
          schemaVersion: candidate.schemaVersion,
          createdById: candidate.yjsUpdatedById,
          reason: 'SCHEDULED',
        },
      });
      taken += 1;
    } catch (error) {
      // The candidate list is read once and worked through afterwards, so
      // a page can be deleted in between -- and a page being deleted is
      // precisely a page someone was just editing, which is what put it
      // on this list. The write then fails on the foreign key. Skipping
      // it is the whole correction: there is nothing left to snapshot.
      // What must not happen is the throw ending the sweep, because every
      // candidate after it would silently lose its checkpoint too.
      if (!isMissingDocument(error)) throw error;
      vanished += 1;
    }
  }
  logger.debug('Active-document snapshots taken', {
    taken,
    candidates: candidates.length,
    ...(vanished === 0 ? {} : { vanished }),
  });
};
