import { type AutomationJob } from '@exocortex/contracts';
import { type Prisma, type PrismaClient } from '@exocortex/database';

/**
 * The run log, written from one place (issue #50, ADR-024).
 *
 * "Ohne das ist eine Automation ein Gerücht": a rule that runs invisibly cannot
 * be told apart from one that does not run, and the first question anybody asks
 * about an automation is what it did last night.
 *
 * Which producer creates the row is the design here. A manual firing creates it
 * in the API, because a caller is waiting for a handle to it. An event-driven
 * firing does not, because a debounce window collapses many events into one
 * job -- a row per event would fill the log with entries that never get a
 * result. So the job carries a `runId` or it does not, and this is where those
 * two cases become one.
 */

export interface AutomationRuleRecord {
  id: string;
  workspaceId: string;
  name: string;
  enabled: boolean;
  action: 'WEBHOOK' | 'AI_RUN';
  output: 'COMMENT' | 'CHILD_PAGE';
  webhookUrl: string | null;
  secretCiphertext: string | null;
  secretIv: string | null;
  secretAuthTag: string | null;
  secretKeyVersion: number | null;
  prompt: string | null;
  modelSlug: string | null;
  createdById: string | null;
}

export async function loadRule(
  prisma: PrismaClient,
  ruleId: string,
): Promise<AutomationRuleRecord | null> {
  return prisma.automationRule.findUnique({
    where: { id: ruleId },
    select: {
      id: true,
      workspaceId: true,
      name: true,
      enabled: true,
      action: true,
      output: true,
      webhookUrl: true,
      secretCiphertext: true,
      secretIv: true,
      secretAuthTag: true,
      secretKeyVersion: true,
      prompt: true,
      modelSlug: true,
      createdById: true,
    },
  });
}

/** Writes one run's outcome. One instance per job, used exactly once. */
export interface RunRecorder {
  succeed(detail: Record<string, unknown>, durationMs: number): Promise<void>;
  fail(error: string, durationMs: number): Promise<void>;
  /** Nothing was attempted, and why. Not a failure: it does not count a strike. */
  skip(reason: string): Promise<void>;
}

/**
 * Marks the run as started and hands back the three ways it can end.
 *
 * The row is moved to `RUNNING` here rather than at the first action, so a run
 * whose worker dies mid-flight is visibly stuck at `RUNNING` instead of looking
 * like one that was never picked up.
 */
export async function createRunRecorder(
  prisma: PrismaClient,
  payload: AutomationJob,
): Promise<RunRecorder> {
  const startedAt = new Date();
  const runId = await (payload.runId === null
    ? createRow(prisma, payload, startedAt)
    : adoptRow(prisma, payload.runId, startedAt));

  async function finish(data: Prisma.AutomationRunUpdateInput): Promise<void> {
    await prisma.automationRun.updateMany({
      where: { id: runId },
      data: { ...data, finishedAt: new Date() },
    });
  }

  return {
    async succeed(detail, durationMs) {
      await finish({ status: 'SUCCEEDED', detail: detail as Prisma.InputJsonObject, durationMs });
    },
    async fail(error, durationMs) {
      await finish({ status: 'FAILED', error: error.slice(0, 2_000), durationMs });
    },
    async skip(reason) {
      await finish({ status: 'SKIPPED', error: reason.slice(0, 2_000) });
    },
  };
}

async function createRow(
  prisma: PrismaClient,
  payload: AutomationJob,
  startedAt: Date,
): Promise<string> {
  // The title is copied, not joined: a page deleted for good still has to have
  // a name in the log of what was done because of it.
  const page = await prisma.document.findUnique({
    where: { id: payload.documentId },
    select: { title: true },
  });
  const row = await prisma.automationRun.create({
    data: {
      ruleId: payload.ruleId,
      workspaceId: payload.workspaceId,
      documentId: payload.documentId,
      documentTitle: page?.title ?? null,
      trigger: payload.trigger,
      origin: payload.origin,
      status: 'RUNNING',
      depth: payload.depth,
      startedAt,
    },
    select: { id: true },
  });
  return row.id;
}

/**
 * Takes over a row the API created.
 *
 * `updateMany` rather than `update`: the row can have been swept away by the
 * retention job or deleted with its rule while the job sat in the queue, and a
 * run that cannot be marked started is not a reason to fail the job -- the work
 * still has to happen or not happen on its own merits.
 */
async function adoptRow(prisma: PrismaClient, runId: string, startedAt: Date): Promise<string> {
  await prisma.automationRun.updateMany({
    where: { id: runId },
    data: { status: 'RUNNING', startedAt },
  });
  return runId;
}
