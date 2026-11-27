import { QUEUE_NAMES } from '@exocortex/contracts';

import { type MaintenanceTask } from './context';

/** How many files one run hands to the extraction queue to be screened. */
const SCREEN_BACKFILL_BATCH = 50;
/** A screening that could not be made is asked again after this long. */
const FAILED_SCREEN_RETRY_MS = 24 * 60 * 60 * 1000;

/**
 * Screens the files whose text was read before the screening existed, and
 * asks again about the ones whose screening could not be made a day ago
 * (ADR-096).
 *
 * The steady state needs no sweep: every extraction and every correction is
 * screened by the `attachment-text` job that wrote it. Until a row is
 * screened it stays foreign, so this sweep only ever makes a file trusted
 * for its uploader sooner; nothing here can make one less safe.
 */
export const screenAttachments: MaintenanceTask = async ({ prisma, queues, payload, logger }) => {
  const rows = await prisma.attachment.findMany({
    where: {
      deletedAt: null,
      textStatus: 'READY',
      ...(payload.workspaceId === null ? {} : { workspaceId: payload.workspaceId }),
      OR: [
        { screening: null },
        { screening: 'FAILED', screenedAt: { lt: new Date(Date.now() - FAILED_SCREEN_RETRY_MS) } },
      ],
    },
    orderBy: { createdAt: 'asc' },
    take: SCREEN_BACKFILL_BATCH,
    select: { id: true, workspaceId: true },
  });
  for (const row of rows) {
    await queues.enqueue(QUEUE_NAMES.attachmentText, {
      correlationId: payload.correlationId,
      attachmentId: row.id,
      workspaceId: row.workspaceId,
      reason: 'screen',
    });
  }
  if (rows.length > 0) logger.info('Attachments queued for screening', { count: rows.length });
};
