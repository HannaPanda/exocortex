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

/** Thins the stored versions of every page down to the configured tiers. */
export const pruneSnapshots: MaintenanceTask = async (context) => {
  const { prisma, payload, logger, reportProgress } = context;
  await reportProgress(10, 'Alte Versionen werden aufgeräumt');
  const settings = await context.settings();
  const fullDays = settings['activity.snapshotRetentionFullDays'];
  const dailyDays = settings['activity.snapshotRetentionDailyDays'];
  const dryRun = settings['activity.snapshotRetentionDryRun'];
  const now = Date.now();
  const cutoffs = {
    fullCutoff: new Date(now - fullDays * DAY_MS),
    dailyCutoff: new Date(now - dailyDays * DAY_MS),
  };

  const documents = await prisma.document.findMany({
    where: payload.workspaceId === null ? {} : { workspaceId: payload.workspaceId },
    select: { id: true },
  });

  let removed = 0;
  let candidates = 0;
  for (const document of documents) {
    // `MANUAL` is exempt from age-based thinning: a deliberately named
    // version is not the "regular checkpoint" this retention tier is
    // about, and pruning it by age alone would defeat the one
    // permanent restore point a person asked for.
    const snapshots = await prisma.documentSnapshot.findMany({
      where: { documentId: document.id, reason: { not: 'MANUAL' } },
      select: { id: true, createdAt: true },
    });
    const toDelete = pruneSnapshotIds(snapshots, cutoffs);
    candidates += toDelete.length;
    if (toDelete.length === 0) continue;
    if (!dryRun) {
      const result = await prisma.documentSnapshot.deleteMany({
        where: { id: { in: toDelete } },
      });
      removed += result.count;
    }
  }
  await reportProgress(100, 'Versionen aufgeräumt');
  logger.info('Snapshots pruned', { removed, candidates, dryRun, documents: documents.length });
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
  // given moment.
  const candidates = await prisma.documentContent.findMany({
    where: {
      yjsUpdatedAt: { gte: activeSince },
      ...(payload.workspaceId === null ? {} : { document: { workspaceId: payload.workspaceId } }),
    },
    select: {
      documentId: true,
      yjsState: true,
      schemaVersion: true,
      yjsUpdatedAt: true,
      document: { select: { updatedById: true } },
    },
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
          createdById: candidate.document.updatedById,
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
