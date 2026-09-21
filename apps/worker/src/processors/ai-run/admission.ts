import { AI_RUN_HEARTBEAT_STALE_MS, type QUEUE_NAMES, type Settings } from '@exocortex/contracts';
import { type AiRun, type PrismaClient } from '@exocortex/database';
import { type JobContext, type RedisEventBus } from '@exocortex/queue';

type AiJob = JobContext<typeof QUEUE_NAMES.ai>;

/**
 * Decides whether this job may execute the run it was handed, and closes out
 * the cases where it may not.
 *
 * Everything here is about not answering twice. A retried job, a resend, a
 * second worker picking up a run whose first worker is still alive: each of
 * them would produce a second answer and, through the tool loop, a second round
 * of writes to whatever it touched. Returns the run only when this worker is
 * the one that should produce the answer.
 */
export async function admitRun(input: {
  prisma: PrismaClient;
  bus: RedisEventBus;
  payload: AiJob['payload'];
  logger: AiJob['logger'];
  settings: (workspaceId?: string) => Promise<Settings>;
}): Promise<{ run: AiRun; settings: Settings } | null> {
  const { prisma, bus, payload, logger } = input;

  const run = await prisma.aiRun.findUnique({ where: { id: payload.runId } });
  if (run === null) {
    logger.warn('Skipping AI run: record not found', { runId: payload.runId });
    return null;
  }
  if (run.status === 'CANCELLED') {
    logger.info('Skipping AI run: cancelled before start', { runId: run.id });
    return null;
  }
  if (run.status === 'RUNNING') {
    await handleRunningRun({ prisma, bus, run, payload, logger });
    return null;
  }
  if (run.status !== 'PENDING') {
    // Idempotency: a retried job must not produce a second answer.
    logger.info('Skipping AI run: already processed', { runId: run.id, status: run.status });
    return null;
  }

  // Resolved only once the run is otherwise admissible: a job that has nothing
  // to do should not go looking for settings first.
  const settings = await input.settings(run.workspaceId);
  if (!settings['ai.enabled']) {
    await failDisabledRun({ prisma, bus, run, payload, logger });
    return null;
  }

  return { run, settings };
}

/**
 * A run already marked RUNNING: either another worker still holds it, or the
 * worker that held it died and left the row behind.
 */
async function handleRunningRun(input: {
  prisma: PrismaClient;
  bus: RedisEventBus;
  run: AiRun;
  payload: AiJob['payload'];
  logger: AiJob['logger'];
}): Promise<void> {
  const { prisma, bus, run, payload, logger } = input;
  const lastSign = run.heartbeatAt ?? run.startedAt ?? run.createdAt;
  if (Date.now() - lastSign.getTime() < AI_RUN_HEARTBEAT_STALE_MS) {
    // Another worker is still holding this run: taking over would
    // produce a second answer and, through the tool loop, a second round
    // of writes to whatever it touched.
    logger.warn('Skipping AI run: another worker still holds it', { runId: run.id });
    return;
  }
  // The heartbeat went stale: the previous worker died mid-run (crash,
  // deploy restart, stalled job) without a chance to close this out
  // itself. Closing it here, rather than resuming it, is what keeps a
  // resend from ever answering twice or writing twice (docs/adr/ADR-017).
  const closed = await prisma.aiRun.updateMany({
    where: { id: run.id, status: 'RUNNING' },
    data: { status: 'FAILED', errorCode: 'ai_run_abandoned', finishedAt: new Date() },
  });
  if (closed.count === 1) {
    await bus.publish({
      type: 'ai.run.failed',
      workspaceId: run.workspaceId,
      correlationId: payload.correlationId,
      emittedAt: new Date().toISOString(),
      payload: {
        runId: run.id,
        status: 'failed',
        errorCode: 'ai_run_abandoned',
        reason: 'The previous execution of this run stopped without finishing',
        detail: null,
      },
    });
  }
  logger.warn('Closed out an abandoned AI run', { runId: run.id });
}

/** Ends a run that was enqueued before AI was switched off. */
async function failDisabledRun(input: {
  prisma: PrismaClient;
  bus: RedisEventBus;
  run: AiRun;
  payload: AiJob['payload'];
  logger: AiJob['logger'];
}): Promise<void> {
  const { prisma, bus, run, payload, logger } = input;
  await prisma.aiRun.update({
    where: { id: run.id },
    data: { status: 'FAILED', errorCode: 'ai_provider_unavailable', finishedAt: new Date() },
  });
  await bus.publish({
    type: 'ai.run.failed',
    workspaceId: run.workspaceId,
    correlationId: payload.correlationId,
    emittedAt: new Date().toISOString(),
    payload: {
      runId: run.id,
      status: 'failed',
      errorCode: 'ai_provider_unavailable',
      reason: 'AI is disabled via the ai.enabled setting',
      detail: null,
    },
  });
  logger.warn('AI run failed: AI is disabled', { runId: run.id });
}
