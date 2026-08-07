import {
  AI_RUN_PICKUP_GRACE_MS,
  deriveAiRunTimeouts,
  type QUEUE_NAMES,
  QUEUE_NAMES as QUEUES,
  type Settings,
} from '@exocortex/contracts';
import { type PrismaClient } from '@exocortex/database';
import { type JobContext, type QueueRegistry, type RedisEventBus } from '@exocortex/queue';
import { type ObjectStorage } from '@exocortex/storage';

import {
  asProseMirrorDocument,
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

export interface MaintenanceDependencies {
  prisma: PrismaClient;
  queues: QueueRegistry;
  storage: ObjectStorage;
  /** Publishes `ai.run.failed` for a run `reap-stale-ai-runs` closes out. */
  bus: RedisEventBus;
  /** Same resolver the AI processor uses, so the reaper agrees with it on the run budget. */
  settings: () => Promise<Settings>;
  /** Snapshots kept per document by `prune-snapshots`. */
  snapshotsToKeep?: number;
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
}

/**
 * Maintenance processor.
 *
 * `dispatch-outbox` is the reliable half of the event system: the API writes
 * outbox rows inside the same transaction as the state change, and this job turns
 * them into follow-up work. Realtime delivery is the fast, best-effort half.
 */
export function createMaintenanceProcessor(dependencies: MaintenanceDependencies) {
  const { prisma, queues, storage, bus } = dependencies;
  const snapshotsToKeep = dependencies.snapshotsToKeep ?? 20;
  const outboxBatchSize = dependencies.outboxBatchSize ?? 100;
  const orphanedCoverGraceMs = dependencies.orphanedCoverGraceMs ?? 60 * 60 * 1000;
  const linkBackfillBatchSize = dependencies.linkBackfillBatchSize ?? 50;

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
            // Record the failure and leave the row unprocessed for a later run;
            // it is never silently dropped.
            await prisma.outboxEvent.update({
              where: { id: event.id },
              data: {
                attempts: { increment: 1 },
                lastError: error instanceof Error ? error.message : String(error),
              },
            });
            logger.error('Failed to dispatch outbox event', error, {
              outboxEventId: event.id,
              type: event.type,
            });
          }
        }
        logger.debug('Outbox dispatched', { dispatched, batch: events.length });
        return;
      }

      case 'prune-snapshots': {
        await reportProgress(10, 'Alte Versionen werden aufgeräumt');
        const documents = await prisma.document.findMany({
          where: payload.workspaceId === null ? {} : { workspaceId: payload.workspaceId },
          select: { id: true },
        });
        let removed = 0;
        for (const document of documents) {
          const keep = await prisma.documentSnapshot.findMany({
            where: { documentId: document.id },
            orderBy: { createdAt: 'desc' },
            take: snapshotsToKeep,
            select: { id: true },
          });
          const result = await prisma.documentSnapshot.deleteMany({
            where: {
              documentId: document.id,
              id: { notIn: keep.map((snapshot) => snapshot.id) },
            },
          });
          removed += result.count;
        }
        await reportProgress(100, 'Versionen aufgeräumt');
        logger.info('Snapshots pruned', { removed, documents: documents.length });
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
