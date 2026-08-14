import {
  asProseMirrorDocument,
  repairUnresolvedLinks,
  replaceDocumentLinks,
  resolveDocumentLinks,
} from '../document-links';

import { type MaintenanceTask } from './context';

/** Re-resolves the references pointing at one page, after its title moved. */
export const resolveLinks: MaintenanceTask = async ({ prisma, payload, logger }) => {
  if (payload.documentId === null) {
    logger.warn('Skipping link resolution: no document', { task: payload.task });
    return;
  }
  const resolved = await resolveDocumentLinks(prisma, payload.documentId);
  if (resolved === null) {
    logger.debug('Skipping link resolution: document is gone', { documentId: payload.documentId });
    return;
  }
  logger.debug('Document links resolved', { documentId: payload.documentId, resolved });
};

/** Sweeps every reference that still points at no page at all. */
export const repairLinks: MaintenanceTask = async ({ prisma, payload, logger }) => {
  const { repaired, unresolvable } = await repairUnresolvedLinks(prisma, payload.workspaceId);
  // Logged at info even when it repairs nothing: "how many references
  // point at a title no page carries" is the one number that says
  // whether the reference index is telling the truth, and it is worth
  // having in the log once a day.
  logger.info('Unresolved references swept', {
    repaired,
    unresolvable,
    workspaceId: payload.workspaceId ?? undefined,
  });
};

/** Indexes the references of pages that existed before the reference index did. */
export const backfillLinks: MaintenanceTask = async (context) => {
  const { prisma, payload, logger, reportProgress } = context;
  // Small batches on a slow schedule rather than one sweep, so a deployment
  // with thousands of pages fills in over an hour instead of stalling for a
  // minute.
  const pending = await prisma.documentContent.findMany({
    where: {
      linksIndexedAt: null,
      ...(payload.workspaceId === null ? {} : { document: { workspaceId: payload.workspaceId } }),
    },
    select: {
      documentId: true,
      proseMirrorJson: true,
      document: { select: { workspaceId: true } },
    },
    take: context.linkBackfillBatchSize,
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
};
