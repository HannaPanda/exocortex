import { automationScheduleOf, nextAutomationRun, QUEUE_NAMES } from '@exocortex/contracts';
import { createCorrelationId } from '@exocortex/logger';

import { type MaintenanceTask } from './context';

/**
 * Rules fired per run. A minute's worth of due schedules, not a backlog drain:
 * anything past this is picked up sixty seconds later, in order.
 */
const BATCH_SIZE = 100;

/**
 * Fires the automation rules whose schedule has come due (issue #73, ADR-038).
 *
 * The clock's half of ADR-024. The outbox dispatcher turns changes into
 * automation jobs; this turns the time of day into the same jobs, on the same
 * queue, with the same run log and the same refusals underneath. Nothing here
 * decides whether a rule may act -- `automations.enabled`, the owner and the
 * rule's own switch are all judged by the processor, one place, so a scheduled
 * run that was refused says so in the log instead of never appearing.
 *
 * A rule is moved on *before* it is queued. That order is the whole design: a
 * worker that dies between the two loses one firing, while the other order
 * would fire the same rule again every minute until it managed to write.
 *
 * A deployment that was switched off over the weekend catches up **once**. The
 * next run is computed from now rather than from the missed slot, because a
 * daily briefing owes nobody the three briefings it did not write.
 */
export const runDueAutomations: MaintenanceTask = async (context) => {
  const { prisma, queues, payload, logger } = context;
  const now = new Date();

  const due = await prisma.automationRule.findMany({
    where: {
      enabled: true,
      nextRunAt: { lte: now },
      triggers: { has: 'SCHEDULE' },
      ...(payload.workspaceId === null ? {} : { workspaceId: payload.workspaceId }),
    },
    select: {
      id: true,
      workspaceId: true,
      scopeDocumentId: true,
      nextRunAt: true,
      scheduleKind: true,
      scheduleAt: true,
      scheduleTime: true,
      scheduleWeekday: true,
      scheduleDayOfMonth: true,
      scheduleCron: true,
      scheduleTimeZone: true,
    },
    orderBy: { nextRunAt: 'asc' },
    take: BATCH_SIZE,
  });
  if (due.length === 0) return;

  let fired = 0;
  for (const rule of due) {
    // A scheduled rule always names its page -- the contract refuses one that
    // does not -- but a row written before that rule existed would not, and a
    // job without a subject has nothing to act on.
    if (rule.scopeDocumentId === null) {
      logger.warn('A scheduled rule has no page to act on', { ruleId: rule.id });
      await prisma.automationRule.updateMany({
        where: { id: rule.id },
        data: { nextRunAt: null },
      });
      continue;
    }

    const schedule = automationScheduleOf(rule);
    const nextRunAt = schedule === null ? null : nextAutomationRun(schedule, now);

    // The claim. `nextRunAt` in the filter is the version check: two workers
    // that read the same batch both try, and exactly one writes.
    const claimed = await prisma.automationRule.updateMany({
      where: { id: rule.id, nextRunAt: rule.nextRunAt },
      data: { nextRunAt },
    });
    if (claimed.count === 0) continue;

    await queues.enqueue(QUEUE_NAMES.automation, {
      correlationId: createCorrelationId(),
      ruleId: rule.id,
      runId: null,
      workspaceId: rule.workspaceId,
      documentId: rule.scopeDocumentId,
      trigger: 'SCHEDULE',
      origin: 'SCHEDULE',
      depth: 0,
    });
    fired += 1;
  }

  if (fired > 0) {
    logger.info('Scheduled automations fired', { rules: fired, due: due.length });
  }
};
