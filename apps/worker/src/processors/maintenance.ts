import { EMBEDDING_BATCH_SIZE } from '@exocortex/ai';
import {
  AI_RUN_PICKUP_GRACE_MS,
  deriveAiRunTimeouts,
  type QUEUE_NAMES,
  QUEUE_NAMES as QUEUES,
  semanticSearchOptions,
  type Settings,
} from '@exocortex/contracts';
import { type HybridSearchAdapter, Prisma, type PrismaClient } from '@exocortex/database';
import { type JobContext, type QueueRegistry, type RedisEventBus } from '@exocortex/queue';
import { type ObjectStorage } from '@exocortex/storage';

import {
  asProseMirrorDocument,
  repairUnresolvedLinks,
  replaceDocumentLinks,
  resolveDocumentLinks,
} from './document-links';

/**
 * Events after which a page may answer to a different title than before, so
 * every reference addressing the old or the new one has to be re-resolved.
 * An edit is deliberately not among them: editing a page changes what it
 * references, and that is rebuilt by materialization itself.
 */
const TITLE_EVENTS = new Set(['document.created', 'document.updated', 'document.moved']);

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

/**
 * How long one `backfill-embeddings` run may keep working. Long enough that a
 * first fill of a large workspace is minutes rather than hours, short enough
 * that the shared maintenance queue is never held for a noticeable time.
 */
const EMBEDDING_BACKFILL_RUN_MS = 30_000;

/**
 * How long an expired, unredeemed invitation stays in the list before the sweep
 * removes it. Thirty days: long enough that "did I ever invite them?" still has
 * an answer, short enough that the list stays about the present.
 */
const INVITATION_RETENTION_MS = 30 * DAY_MS;

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
 * survives (the newest — the first one encountered once sorted). Older than
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

export interface MaintenanceDependencies {
  prisma: PrismaClient;
  queues: QueueRegistry;
  storage: ObjectStorage;
  /**
   * The same adapter the indexing worker writes through, so `backfill-embeddings`
   * produces exactly what ordinary indexing produces -- including the "text has
   * not changed" check that keeps a re-run from paying for the same vector twice.
   */
  search: HybridSearchAdapter;
  /** Publishes `ai.run.failed` for a run `reap-stale-ai-runs` closes out. */
  bus: RedisEventBus;
  /**
   * Same resolver the AI processor uses. `prune-snapshots` and
   * `snapshot-active-documents` also read their tuning from here
   * (`activity.*`, ADR-013) rather than from a constructor option, so an
   * admin can change retention without a redeploy.
   */
  settings: () => Promise<Settings>;
  /** Outbox rows dispatched per run. */
  outboxBatchSize?: number;
  /**
   * How long a cover-only upload is kept after it stops being a cover. The
   * grace period is what makes the sweep safe against a client that uploads
   * first and points the page at the file a moment later.
   */
  orphanedCoverGraceMs?: number;
  /** Content rows the reference backfill extracts per run. */
  linkBackfillBatchSize?: number;
  /** Documents per embedding request inside a backfill run. */
  embeddingBackfillBatchSize?: number;
}

/**
 * True when a write failed because the row it points at is gone. `P2003` is the
 * foreign key violation a delete between reading a candidate and writing its
 * snapshot produces.
 */
function isMissingDocument(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003';
}

/**
 * True when an update found nothing to update. `P2025` is what Prisma reports
 * when the row addressed by `where` no longer exists -- for an outbox row that
 * means its workspace was deleted between the batch being read and the row
 * being marked, which is a race, not a defect.
 */
function isMissingRow(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025';
}

/**
 * Records a failed dispatch and leaves the row unprocessed for a later run; it
 * is never silently dropped.
 *
 * Returns true when the row itself disappeared while its failure was being
 * written: the same race as in the caller, one step later. Anything else is a
 * real fault and stays loud.
 */
async function recordOutboxFailure(
  prisma: PrismaClient,
  outboxEventId: string,
  error: unknown,
): Promise<boolean> {
  try {
    await prisma.outboxEvent.update({
      where: { id: outboxEventId },
      data: {
        attempts: { increment: 1 },
        lastError: error instanceof Error ? error.message : String(error),
      },
    });
    return false;
  } catch (recordingError) {
    if (!isMissingRow(recordingError)) throw recordingError;
    return true;
  }
}

/**
 * Maintenance processor.
 *
 * `dispatch-outbox` is the reliable half of the event system: the API writes
 * outbox rows inside the same transaction as the state change, and this job turns
 * them into follow-up work. Realtime delivery is the fast, best-effort half.
 */
export function createMaintenanceProcessor(dependencies: MaintenanceDependencies) {
  const { prisma, queues, storage, bus, search } = dependencies;
  const outboxBatchSize = dependencies.outboxBatchSize ?? 100;
  const orphanedCoverGraceMs = dependencies.orphanedCoverGraceMs ?? 60 * 60 * 1000;
  const linkBackfillBatchSize = dependencies.linkBackfillBatchSize ?? 50;
  const embeddingBackfillBatchSize = dependencies.embeddingBackfillBatchSize ?? EMBEDDING_BATCH_SIZE;

  return async ({
    payload,
    logger,
    reportProgress,
  }: JobContext<typeof QUEUE_NAMES.maintenance>): Promise<void> => {
    switch (payload.task) {
      case 'dispatch-outbox': {
        const events = await prisma.outboxEvent.findMany({
          where: { processedAt: null },
          orderBy: { createdAt: 'asc' },
          take: outboxBatchSize,
        });
        if (events.length === 0) return;

        let dispatched = 0;
        let vanished = 0;
        for (const event of events) {
          try {
            const documentId = extractDocumentId(event.payload);
            if (documentId !== null && event.type.startsWith('document.')) {
              await queues.enqueue(QUEUES.searchIndexing, {
                correlationId: event.correlationId,
                documentId,
                workspaceId: event.workspaceId,
                reason: reasonFor(event.type),
              });
            }
            // A title-based reference index goes stale when a *target* page
            // appears or is renamed, not when the referencing page is edited,
            // so it has to be refreshed from this side too (issue #19). The
            // API only writes `document.updated` when the title actually
            // changed, which is what keeps this from firing on every save.
            if (documentId !== null && TITLE_EVENTS.has(event.type)) {
              await queues.enqueue(QUEUES.maintenance, {
                correlationId: event.correlationId,
                task: 'resolve-document-links',
                workspaceId: event.workspaceId,
                documentId,
              });
            }
            await prisma.outboxEvent.update({
              where: { id: event.id },
              data: { processedAt: new Date(), attempts: { increment: 1 } },
            });
            dispatched += 1;
          } catch (error) {
            // The batch is read once and worked through afterwards. A workspace
            // deleted in that window takes its outbox rows with it, so the row
            // this iteration is holding may no longer exist -- nothing failed,
            // there is simply nothing left to dispatch or to record against.
            if (isMissingRow(error)) {
              vanished += 1;
              continue;
            }
            logger.error('Failed to dispatch outbox event', error, {
              outboxEventId: event.id,
              type: event.type,
            });
            if (await recordOutboxFailure(prisma, event.id, error)) vanished += 1;
          }
        }
        logger.debug('Outbox dispatched', { dispatched, vanished, batch: events.length });
        return;
      }

      case 'prune-snapshots': {
        await reportProgress(10, 'Alte Versionen werden aufgeräumt');
        const settings = await dependencies.settings();
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
        logger.info('Snapshots pruned', {
          removed,
          candidates,
          dryRun,
          documents: documents.length,
        });
        return;
      }

      case 'snapshot-active-documents': {
        const settings = await dependencies.settings();
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
            ...(payload.workspaceId === null
              ? {}
              : { document: { workspaceId: payload.workspaceId } }),
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
        return;
      }

      case 'collect-orphaned-covers': {
        await reportProgress(10, 'Ersetzte Titelbilder werden aufgeräumt');
        // Only files uploaded *as* a cover are collected. Replacing a cover
        // leaves the previous image behind with nothing pointing at it, and
        // nothing else ever will: the cover upload route stores its own copy.
        const orphans = await prisma.attachment.findMany({
          where: {
            isCover: true,
            deletedAt: null,
            coverOf: { none: {} },
            createdAt: { lt: new Date(Date.now() - orphanedCoverGraceMs) },
            ...(payload.workspaceId === null ? {} : { workspaceId: payload.workspaceId }),
          },
          select: { id: true, storageKey: true, previewKey: true },
        });

        let removed = 0;
        for (const orphan of orphans) {
          // Same order as the attachment delete route: mark the row first, then
          // the object. A failed object delete leaves a row already marked
          // deleted, which is the harmless direction.
          await prisma.attachment.update({
            where: { id: orphan.id },
            data: { deletedAt: new Date() },
          });
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
        return;
      }

      case 'vacuum-search-index': {
        const orphans = await prisma.$executeRaw`
          DELETE FROM "document_search_index"
          WHERE "documentId" NOT IN (SELECT "id" FROM "document")
        `;
        logger.info('Search index vacuumed', { removed: orphans });
        return;
      }

      case 'reap-stale-ai-runs': {
        // Second line of defence behind the processor's own guard
        // (`ai-run.ts`, part a): a run whose worker crashed hard enough to
        // never re-enqueue at all is only ever found here.
        const timeouts = deriveAiRunTimeouts(await dependencies.settings());
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
          const errorCode = candidate.status === 'PENDING'
            ? 'ai_run_lost'
            : timedOut
              ? 'ai_timeout'
              : 'ai_run_abandoned';
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
        return;
      }

      case 'resolve-document-links': {
        if (payload.documentId === null) {
          logger.warn('Skipping link resolution: no document', { task: payload.task });
          return;
        }
        const resolved = await resolveDocumentLinks(prisma, payload.documentId);
        if (resolved === null) {
          logger.debug('Skipping link resolution: document is gone', {
            documentId: payload.documentId,
          });
          return;
        }
        logger.debug('Document links resolved', { documentId: payload.documentId, resolved });
        return;
      }

      case 'repair-document-links': {
        const { repaired, unresolvable } = await repairUnresolvedLinks(
          prisma,
          payload.workspaceId,
        );
        // Logged at info even when it repairs nothing: "how many references
        // point at a title no page carries" is the one number that says
        // whether the reference index is telling the truth, and it is worth
        // having in the log once a day.
        logger.info('Unresolved references swept', {
          repaired,
          unresolvable,
          workspaceId: payload.workspaceId ?? undefined,
        });
        return;
      }

      case 'backfill-document-links': {
        // Pages that existed before the reference index did. Small batches on a
        // slow schedule rather than one sweep, so a deployment with thousands
        // of pages fills in over an hour instead of stalling for a minute.
        const pending = await prisma.documentContent.findMany({
          where: {
            linksIndexedAt: null,
            ...(payload.workspaceId === null
              ? {}
              : { document: { workspaceId: payload.workspaceId } }),
          },
          select: {
            documentId: true,
            proseMirrorJson: true,
            document: { select: { workspaceId: true } },
          },
          take: linkBackfillBatchSize,
        });
        if (pending.length === 0) return;

        await reportProgress(10, 'Verweise werden nachgetragen');
        const now = new Date();
        let indexed = 0;
        for (const row of pending) {
          const document = asProseMirrorDocument(row.proseMirrorJson);
          if (document === null) {
            // Never materialized: mark it so the sweep moves on. The next
            // materialization writes the real references.
            await prisma.documentContent.update({
              where: { documentId: row.documentId },
              data: { linksIndexedAt: now },
            });
            continue;
          }
          await replaceDocumentLinks(prisma, {
            documentId: row.documentId,
            workspaceId: row.document.workspaceId,
            proseMirrorJson: document,
            indexedAt: now,
          });
          indexed += 1;
        }
        await reportProgress(100, 'Verweise nachgetragen');
        logger.info('Document links backfilled', { indexed, batch: pending.length });
        return;
      }

      case 'backfill-embeddings': {
        const settings = await dependencies.settings();
        const semantic = semanticSearchOptions(settings);
        if (semantic === null) return;

        // Pages the vector index has never seen under the model that is
        // currently configured. Newest first: a deployment that has just
        // switched semantic search on gets the pages it is working on today
        // long before the ones it has not touched in a year.
        const scope =
          payload.workspaceId === null
            ? Prisma.empty
            : Prisma.sql`AND index."workspaceId" = ${payload.workspaceId}`;
        const readBatch = async (): Promise<
          {
            documentId: string;
            workspaceId: string;
            title: string;
            plainText: string;
            archivedAt: Date | null;
          }[]
        > =>
          prisma.$queryRaw(Prisma.sql`
            SELECT
              index."documentId"  AS "documentId",
              index."workspaceId" AS "workspaceId",
              index."title"       AS "title",
              index."plainText"   AS "plainText",
              index."archivedAt"  AS "archivedAt"
            FROM "document_search_index" AS index
            LEFT JOIN "document_embedding" AS embedding
              ON embedding."documentId" = index."documentId"
             AND embedding."blockId" IS NULL
             AND embedding."model" = ${semantic.model}
            WHERE embedding."id" IS NULL
              ${scope}
            ORDER BY index."updatedAt" DESC
            LIMIT ${embeddingBackfillBatchSize}
          `);

        /**
         * Several batches per run, bounded by time rather than by count.
         *
         * A first fill is thousands of pages, and one batch every two minutes
         * would take hours; a fixed higher count would instead hold the
         * maintenance queue for however long the provider happens to be slow.
         * The budget keeps both ends honest, and the sweep is a no-op once
         * every page has a vector.
         */
        const deadline = Date.now() + EMBEDDING_BACKFILL_RUN_MS;
        let embedded = 0;
        let seen = 0;
        let progressed = false;
        while (Date.now() < deadline) {
          const pending = await readBatch();
          if (pending.length === 0) break;
          if (!progressed) {
            await reportProgress(10, 'Bedeutungen werden nachgetragen');
            progressed = true;
          }
          seen += pending.length;
          try {
            embedded += await search.writeEmbeddings(pending, semantic.model);
          } catch (error) {
            // A batch the model refuses (a rate limit, a page too long even
            // after truncation) must not fail the job into a retry loop.
            // Nothing was written for it, so the next run sees it again.
            logger.warn('Could not backfill a batch of embeddings', {
              batch: pending.length,
              reason: error instanceof Error ? error.message : String(error),
            });
            break;
          }
        }
        if (!progressed) return;

        await reportProgress(100, 'Bedeutungen nachgetragen');
        logger.info('Embeddings backfilled', {
          embedded,
          seen,
          model: semantic.model,
        });
        return;
      }

      case 'prune-memories': {
        const settings = await dependencies.settings();
        const retentionDays = settings['memory.retentionDays'];
        const workspaceId = settings['memory.workspaceId'];
        if (retentionDays === 0 || workspaceId === null) return;

        const cutoff = new Date(Date.now() - retentionDays * DAY_MS);
        await reportProgress(10, 'Altes Gedächtnis wird aufgeräumt');

        /**
         * Two stages, one setting.
         *
         * A note that has not been touched for the retention period goes into
         * the trash; a note that has been *in* the trash for another retention
         * period is deleted for good. Nothing in this application has ever
         * destroyed a page outright, and a background sweep is the last place
         * that should start: this way every deletion was visible and
         * recoverable in the trash for a full period first.
         *
         * `parentId: { not: null }` is what keeps the project pages: they are
         * the roots of the memory workspace and hold the notes that are still
         * current.
         */
        const expiring = await prisma.document.findMany({
          where: {
            workspaceId,
            parentId: { not: null },
            archivedAt: null,
            updatedAt: { lt: cutoff },
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
          where: {
            workspaceId,
            parentId: { not: null },
            archivedAt: { lt: cutoff },
          },
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
        return;
      }

      case 'prune-invitations': {
        /**
         * Invitations that expired long ago and were never taken up (issue #3).
         *
         * Deletion rather than archival, because an unredeemed invitation is not
         * a record of anything: nobody arrived, nothing points at it. What *is*
         * kept is every accepted one -- `acceptedAt: null` in the filter -- since
         * that row is the answer to "where did this account come from".
         *
         * The grace period exists so an administrator looking at the list a week
         * after an expiry still sees what happened, instead of wondering whether
         * they ever sent it. Withdrawn invitations age out on the same clock:
         * `expiresAt` keeps running whether the invitation was revoked or not.
         */
        await reportProgress(10, 'Alte Einladungen werden aufgeräumt');
        const cutoff = new Date(Date.now() - INVITATION_RETENTION_MS);
        const removed = await prisma.invitation.deleteMany({
          where: { acceptedAt: null, expiresAt: { lt: cutoff } },
        });

        await reportProgress(100, 'Einladungen aufgeräumt');
        if (removed.count > 0) {
          logger.info('Expired invitations pruned', { removed: removed.count });
        }
        return;
      }

      default: {
        // Exhaustiveness guard: a new task must be handled explicitly.
        const unhandled: never = payload.task;
        throw new Error(`Unhandled maintenance task: ${String(unhandled)}`);
      }
    }
  };
}

function extractDocumentId(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const value = (payload as Record<string, unknown>).documentId;
  return typeof value === 'string' ? value : null;
}

function reasonFor(
  eventType: string,
): 'materialized' | 'title_changed' | 'archived' | 'restored' | 'deleted' | 'manual' {
  switch (eventType) {
    case 'document.archived':
      return 'archived';
    case 'document.restored':
      return 'restored';
    case 'document.materialized':
      return 'materialized';
    case 'document.created':
    case 'document.updated':
    case 'document.moved':
      return 'title_changed';
    default:
      return 'manual';
  }
}
