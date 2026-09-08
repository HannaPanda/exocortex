import { QUEUE_NAMES } from '@exocortex/contracts';

import { DAY_MS, type MaintenanceTask } from './context';

/**
 * Hands each project with unread notes to the consolidation queue (issue #46).
 *
 * The fan-out and nothing else. This sweep has neither an AI provider nor an
 * API client, and it should not: what a note *means* is a model's judgement and
 * belongs in a job that can be retried, timed out and paid for on its own.
 *
 * The acting account is the one that created the project page, which is the
 * account whose agent has been writing there. A fact is then written by the
 * same user a note was, and passes the same permission checks.
 */
export const consolidateMemories: MaintenanceTask = async (context) => {
  const { prisma, queues, payload, logger, reportProgress } = context;
  const settings = await context.settings();
  const workspaceId = settings['memory.workspaceId'];
  if (!settings['memory.enabled'] || !settings['memory.consolidationEnabled']) return;
  if (!settings['ai.enabled'] || workspaceId === null) return;

  await reportProgress(10, 'Projekte mit neuen Notizen werden gesucht');

  // Grouped rather than listed: one project can hold hundreds of unread notes,
  // and all this needs is which projects have any.
  const pending = await prisma.document.groupBy({
    by: ['parentId'],
    where: {
      workspaceId,
      archivedAt: null,
      // A note is a child of a project page, and a project page is a root.
      parent: { parentId: null, archivedAt: null },
      memoryConsolidation: { is: null },
      memoryFact: { is: null },
      children: { none: {} },
    },
    _count: { _all: true },
    // Oldest backlog first, so a project that has been waiting does not stay
    // behind a project that produces a note every day.
    orderBy: { _min: { createdAt: 'asc' } },
    take: settings['memory.consolidationProjectsPerRun'],
  });

  let queued = 0;
  for (const group of pending) {
    if (group.parentId === null) continue;
    const project = await prisma.document.findFirst({
      where: { id: group.parentId, archivedAt: null },
      select: { id: true, title: true, createdById: true },
    });
    if (project === null) continue;

    await queues.enqueue(
      QUEUE_NAMES.memoryConsolidate,
      {
        correlationId: payload.correlationId,
        workspaceId,
        userId: project.createdById,
        projectKey: project.title,
        projectDocumentId: project.id,
      },
      // One attempt, like capture: the work costs a model call and the
      // processor reports its own failures instead of throwing.
      { attempts: 1 },
    );
    queued += 1;
  }

  await reportProgress(100, 'Verdichtung angestoßen');
  logger.info('Memory consolidation fanned out', { workspaceId, projects: queued });
};

/**
 * Turns the volume down on facts nobody confirms any more (issue #46).
 *
 * Decay rather than expiry, and that is the whole point of the task. A note is
 * deleted on its birthday because it records a moment; a fact is not, because
 * it claims something about now. What ages is not the claim but the evidence
 * for it, so what falls is the weight it carries in a recall.
 *
 * One multiplication per nightly run, sized so that `memory.factHalfLifeDays`
 * of silence halves a fact's weight exactly once. A run that is missed only
 * slows the decay down, which is the safe direction to fail in.
 */
export const decayMemoryFacts: MaintenanceTask = async (context) => {
  const { prisma, payload, logger, reportProgress } = context;
  const settings = await context.settings();
  const halfLifeDays = settings['memory.factHalfLifeDays'];
  const floor = settings['memory.factConfidenceFloor'];
  const workspaceId = settings['memory.workspaceId'];
  if (halfLifeDays === 0 || workspaceId === null) return;

  await reportProgress(10, 'Fakten werden gewichtet');

  const factor = Math.pow(0.5, 1 / halfLifeDays);
  // Confirmed within the last day: left alone, so a fact does not lose weight
  // in the same night it gained some.
  const cutoff = new Date(Date.now() - DAY_MS);
  const faded = await prisma.$executeRaw`
    UPDATE "memory_fact"
    SET "confidence" = "confidence" * ${factor}, "updatedAt" = NOW()
    WHERE "workspaceId" = ${workspaceId}
      AND "status" = 'CURRENT'
      AND "lastConfirmedAt" < ${cutoff}
  `;

  await reportProgress(60, 'Verklungene Fakten werden weggeräumt');

  const sunk = await prisma.memoryFact.findMany({
    where: {
      workspaceId,
      status: 'CURRENT',
      confidence: { lt: floor },
      document: { archivedAt: null },
    },
    select: { id: true, documentId: true },
  });

  if (sunk.length > 0) {
    const now = new Date();
    const documentIds = sunk.map((fact) => fact.documentId);
    await prisma.document.updateMany({
      where: { id: { in: documentIds } },
      data: { archivedAt: now },
    });
    // Same path an archive from the API takes, so the search projection learns
    // that these left the tree instead of answering with them for ever
    // (ADR-010).
    await prisma.outboxEvent.createMany({
      data: documentIds.map((documentId) => ({
        workspaceId,
        type: 'document.archived',
        payload: { documentId },
        correlationId: payload.correlationId,
      })),
    });
  }

  await reportProgress(100, 'Fakten gewichtet');
  logger.info('Memory facts decayed', {
    workspaceId,
    faded,
    archived: sunk.length,
    halfLifeDays,
    floor,
  });
};
