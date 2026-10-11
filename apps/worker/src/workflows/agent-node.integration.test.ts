import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { loadDotEnv } from '@exocortex/config';
import {
  parseWorkflowOrigin,
  type Settings,
  settingsSchema,
  WORKFLOW_ORIGIN_HEADER,
  type WorkflowGraphInput,
  workflowGraphSchema,
  type WorkflowJob,
} from '@exocortex/contracts';
import {
  createPrismaClient,
  generateOrderKey,
  Prisma,
  type PrismaClient,
  startWorkflowRun,
} from '@exocortex/database';
import { createLogger } from '@exocortex/logger';
import { type ExocortexApiClient, ExocortexApiError } from '@exocortex/mcp-tools';

import { STALL_AFTER_MS } from './agent-completion';
import { runWorkflowJob, type WorkflowRuntimeDependencies } from './runtime';
import { sweepWorkflowRuns } from './sweep';

/**
 * The agent node against the real database (issue #162, ADR-077).
 *
 * The API is a stand-in that does what the real routes do with the rows
 * this node reads: it creates a work item bound to the attempt the origin
 * header names (and answers with the same item a second time), and starts a
 * run on it. Everything after that -- a person answering, the run handing
 * in, a child costing money -- is written to the rows directly, the way the
 * API would. What is proven:
 *
 * - a run creates one item and one run however often the attempt is
 *   delivered, as the person the run acts for, with the verified origin;
 * - the node waits on the item, not the run, through a question and a
 *   paused run, across a "restart" (a fresh runtime for every job);
 * - it completes on the item's status with checked fields a condition
 *   branches on, and fails cleanly on fields that do not hold;
 * - what the item and its children cost is counted against the run, and
 *   parallel agent nodes cannot both be handed the same remaining budget;
 * - the sweep settles a node whose wake was lost, and a stalled one.
 */
loadDotEnv();

const logger = createLogger({ name: 'workflow-agent-test', level: 'silent' });

let prisma: PrismaClient;
let workspaceId: string;
let ownerId: string;
let pageId: string;

let settingsOverride: Partial<Settings> = {};
function currentSettings(): Settings {
  return { ...settingsSchema.parse({}), 'workflows.enabled': true, ...settingsOverride };
}

let queue: WorkflowJob[] = [];
const queues = {
  async enqueue(_name: string, job: WorkflowJob) {
    queue.push(job);
    return 'job';
  },
};

let clock = new Date('2026-10-11T10:00:00.000Z');
function later(ms: number): void {
  clock = new Date(clock.getTime() + ms);
}

/** What the stand-in API was asked, in order. */
interface ApiCall {
  userId: string;
  method: string;
  path: string;
  body: Record<string, unknown>;
  origin: ReturnType<typeof parseWorkflowOrigin>;
}
let calls: ApiCall[] = [];
let refuseRuns = false;

function fakeApi(userId: string, headers?: Readonly<Record<string, string>>): ExocortexApiClient {
  const origin = parseWorkflowOrigin(headers?.[WORKFLOW_ORIGIN_HEADER]);
  return {
    async request<T>(input: { method: string; path: string; body?: unknown }): Promise<T> {
      const body = (input.body ?? {}) as Record<string, unknown>;
      calls.push({ userId, method: input.method, path: input.path, body, origin });
      if (input.path.endsWith('/work-items')) return (await createItem(body, origin)) as T;
      if (input.path.endsWith('/runs')) {
        if (refuseRuns) {
          throw new ExocortexApiError('ai_disabled', 'AI is switched off', 409, null);
        }
        const workItemId = input.path.split('/')[3]!;
        const run = await prisma.aiRun.create({
          data: {
            workspaceId,
            createdById: userId,
            provider: 'mock',
            model: 'mock/model',
            messages: [],
            workItemId,
            status: 'RUNNING',
          },
        });
        await prisma.workItem.update({ where: { id: workItemId }, data: { status: 'WORKING' } });
        return { run: { id: run.id } } as T;
      }
      throw new Error(`Unexpected call ${input.method} ${input.path}`);
    },
    upload: async () => {
      throw new Error('no uploads');
    },
  };
}

/** What `WorkItemsService.create` does with a verified origin, reduced to the rows. */
async function createItem(
  body: Record<string, unknown>,
  origin: ReturnType<typeof parseWorkflowOrigin>,
): Promise<unknown> {
  const executionId = origin?.executionId ?? null;
  const existing =
    executionId === null
      ? null
      : await prisma.workItem.findUnique({
          where: { workflowExecutionId: executionId },
          include: { runs: { select: { id: true } } },
        });
  const item =
    existing ??
    (await prisma.workItem.create({
      data: {
        workspaceId,
        title: String(body.title),
        goal: String(body.goal),
        requesterKind: 'HUMAN',
        requesterId: ownerId,
        assigneeKind: 'ASSISTANT',
        budgetMicroUsd: (body.budgetMicroUsd as number | undefined) ?? null,
        resultFields: (body.resultFields ?? []) as Prisma.InputJsonValue,
        workflowExecutionId: executionId,
        refs: {
          create: ((body.contextDocumentIds ?? []) as string[]).map((documentId) => ({
            documentId,
            role: 'CONTEXT' as const,
          })),
        },
      },
      include: { runs: { select: { id: true } } },
    }));
  return { workItem: { id: item.id, runs: item.runs } };
}

function runtime(): WorkflowRuntimeDependencies {
  return {
    prisma,
    queues: queues as unknown as WorkflowRuntimeDependencies['queues'],
    settings: async () => currentSettings(),
    logger,
    apiClientFor: fakeApi,
    now: () => clock,
  };
}

/**
 * Runs every queued job, each with a fresh runtime: nothing a job leaves in
 * memory survives into the next, as after a worker restart.
 */
async function drain(limit = 100): Promise<void> {
  let processed = 0;
  while (queue.length > 0 && processed < limit) {
    const job = queue.shift()!;
    await runWorkflowJob(runtime(), job, async () => undefined);
    processed += 1;
  }
}

async function sweep(): Promise<void> {
  const dependencies = runtime();
  await sweepWorkflowRuns({
    ...dependencies,
    triggers: { prisma, queues: queues as never, settings: dependencies.settings, logger },
    workspaceId,
  });
}

/** What the API's wake listener does after a status change. */
async function wake(workItemId: string): Promise<void> {
  const waiting = await prisma.workflowNodeExecution.findMany({
    where: { status: 'WAITING', waitingOn: { path: ['workItemId'], equals: workItemId } },
    select: { id: true, runId: true },
  });
  for (const row of waiting) {
    queue.push({
      kind: 'resume',
      runId: row.runId,
      executionId: row.id,
      wake: { kind: 'work_item', workItemId },
      correlationId: 'test',
    });
  }
}

function edge(id: string, from: string, handle: string, to: string) {
  return { id, kind: 'flow' as const, source: { nodeId: from, handle }, target: { nodeId: to } };
}

function scoreGraph(overrides: Record<string, unknown> = {}): WorkflowGraphInput {
  return {
    schemaVersion: 1,
    nodes: [
      { id: 'start', type: 'trigger.manual' },
      {
        id: 'review',
        type: 'agent',
        label: 'Ideen bewerten',
        goal: 'Bewerte die Ideen auf {{input.documentId}}',
        documentIds: [pageId],
        outputFields: [{ name: 'score', type: 'number' }],
        ...overrides,
      },
      {
        id: 'good',
        type: 'condition',
        source: { nodeId: 'review', field: 'score' },
        operator: 'gte',
        value: 7,
      },
      { id: 'yes', type: 'end', outcome: 'succeeded' },
      { id: 'no', type: 'end', outcome: 'failed' },
    ],
    edges: [
      edge('e1', 'start', 'next', 'review'),
      edge('e2', 'review', 'next', 'good'),
      edge('e3', 'good', 'true', 'yes'),
      edge('e4', 'good', 'false', 'no'),
    ],
    limits: { budgetMicroUsd: 1_000_000 },
  };
}

let counter = 0;
async function publishedWorkflow(graph: WorkflowGraphInput): Promise<string> {
  counter += 1;
  const parsed = workflowGraphSchema.parse(graph);
  const workflow = await prisma.workflow.create({
    data: {
      workspaceId,
      name: `Agent ${String(counter)} ${Date.now().toString(36)}`,
      draftGraph: parsed as Prisma.InputJsonObject,
      createdById: ownerId,
    },
  });
  const version = await prisma.workflowVersion.create({
    data: {
      workflowId: workflow.id,
      version: 1,
      graph: parsed as Prisma.InputJsonObject,
      graphHash: `agent-hash-${String(counter)}`,
      draftRevision: 1,
    },
  });
  await prisma.workflow.update({
    where: { id: workflow.id },
    data: { publishedVersionId: version.id },
  });
  return workflow.id;
}

async function start(
  workflowId: string,
  input?: Record<string, unknown>,
  test?: { writeMode: 'read_only' | 'propose' | 'direct' },
): Promise<string> {
  const started = await startWorkflowRun(prisma, {
    workflowId,
    origin: test === undefined ? 'manual' : 'test',
    ...(test === undefined ? {} : { writeMode: test.writeMode }),
    triggerNodeId: null,
    startedById: ownerId,
    correlationId: 'test',
    chainDepth: 0,
    settings: currentSettings(),
    requireEnabled: false,
    now: clock,
    ...(input === undefined ? {} : { input: input as Prisma.InputJsonObject }),
  });
  if (!started.ok) throw new Error(started.reason);
  queue.push({ kind: 'advance', runId: started.runId, correlationId: 'test' });
  return started.runId;
}

async function readRun(runId: string) {
  return prisma.workflowRun.findUniqueOrThrow({
    where: { id: runId },
    include: { nodeExecutions: { orderBy: [{ queuedAt: 'asc' }, { attempt: 'asc' }] } },
  });
}

function attemptOf(run: Awaited<ReturnType<typeof readRun>>, nodeId: string) {
  return run.nodeExecutions.filter((row) => row.nodeId === nodeId).at(-1);
}

async function itemOf(runId: string) {
  const run = await readRun(runId);
  const attempt = attemptOf(run, 'review');
  return prisma.workItem.findUniqueOrThrow({
    where: { workflowExecutionId: attempt!.id },
    include: { runs: true, refs: true },
  });
}

/** The run hands its work in, the way `exo_work_item_update` would. */
async function handIn(
  workItemId: string,
  status: 'REVIEW' | 'DONE',
  structuredResult: Record<string, unknown> | null,
  costMicroUsd = 0,
): Promise<void> {
  await prisma.aiRun.updateMany({
    where: { workItemId, status: { in: ['PENDING', 'RUNNING'] } },
    data: { status: 'COMPLETED', finishedAt: clock, providerCostMicroUsd: costMicroUsd },
  });
  await prisma.workItem.update({
    where: { id: workItemId },
    data: {
      status,
      result: 'Drei Ideen bewertet.',
      structuredResult:
        structuredResult === null ? undefined : (structuredResult as Prisma.InputJsonObject),
    },
  });
}

beforeAll(async () => {
  prisma = createPrismaClient({ databaseUrl: process.env.DATABASE_URL });
  const suffix = Date.now().toString(36);
  ownerId = (
    await prisma.user.create({
      data: { email: `wf-agent-${suffix}@exocortex.test`, name: 'Owner', emailVerified: true },
    })
  ).id;
  workspaceId = (
    await prisma.workspace.create({
      data: {
        name: `Workflow agents ${suffix}`,
        slug: `workflow-agents-${suffix}`,
        members: { create: { userId: ownerId, role: 'OWNER' } },
      },
    })
  ).id;
  pageId = (
    await prisma.document.create({
      data: {
        workspaceId,
        title: 'Ideen',
        type: 'PAGE',
        orderKey: generateOrderKey(null, null),
        createdById: ownerId,
        updatedById: ownerId,
      },
    })
  ).id;
});

afterAll(async () => {
  await prisma.workflowRun.deleteMany({ where: { workspaceId } });
  await prisma.workflow.updateMany({ where: { workspaceId }, data: { publishedVersionId: null } });
  await prisma.workflow.deleteMany({ where: { workspaceId } });
  await prisma.aiRun.deleteMany({ where: { workspaceId } });
  await prisma.workItem.deleteMany({ where: { workspaceId } });
  await prisma.document.deleteMany({ where: { workspaceId } });
  await prisma.workspace.deleteMany({ where: { id: workspaceId } });
  await prisma.user.deleteMany({ where: { id: ownerId } });
  await prisma.$disconnect();
});

beforeEach(() => {
  queue = [];
  calls = [];
  refuseRuns = false;
  settingsOverride = {};
});

describe('agent node', () => {
  it('hands its goal to one work item, waits on it, and branches on its checked fields', async () => {
    const workflowId = await publishedWorkflow(scoreGraph());
    const runId = await start(workflowId, { documentId: pageId });
    await drain();

    let run = await readRun(runId);
    expect(run.status).toBe('WAITING');
    const attempt = attemptOf(run, 'review')!;
    expect(attempt.status).toBe('WAITING');
    expect(queue).toHaveLength(0);

    // One item and one run, created as the person the run acts for, with
    // the origin naming exactly this attempt.
    expect(calls.map((call) => call.path)).toEqual([
      `/api/workspaces/${workspaceId}/work-items`,
      expect.stringMatching(/^\/api\/work-items\/.+\/runs$/u),
    ]);
    expect(calls.every((call) => call.userId === ownerId)).toBe(true);
    expect(calls[0]!.origin).toEqual({ workflowId, runId, executionId: attempt.id, depth: 0 });
    expect(calls[0]!.body).toMatchObject({
      goal: `Bewerte die Ideen auf ${pageId}`,
      assignee: { kind: 'assistant' },
      contextDocumentIds: [pageId],
      budgetMicroUsd: 1_000_000,
      resultFields: [expect.objectContaining({ name: 'score', type: 'number' })],
    });
    expect(String(calls[0]!.body.title)).toMatch(/: Ideen bewerten$/u);

    const item = await itemOf(runId);
    expect(attempt.workItemId).toBe(item.id);
    expect(attempt.aiRunId).toBe(item.runs[0]!.id);

    await handIn(item.id, 'REVIEW', { score: 8 }, 120_000);
    await wake(item.id);
    await drain();

    run = await readRun(runId);
    expect(run.status).toBe('SUCCEEDED');
    const settled = attemptOf(run, 'review')!;
    expect(settled.output).toMatchObject({
      outcome: 'review',
      fields: { score: 8 },
      workItemId: item.id,
      aiRunId: item.runs[0]!.id,
      contextDocumentIds: [pageId],
      summary: 'Drei Ideen bewertet.',
      spentMicroUsd: 120_000,
    });
    expect(attemptOf(run, 'good')!.firedHandles).toEqual(['true']);
    expect(attemptOf(run, 'no')!.status).toBe('SKIPPED');
    expect(run.spentMicroUsd).toBe(120_000);
  });

  it('holds the node to the write mode of a test run, and leaves an ordinary run alone', async () => {
    const workflowId = await publishedWorkflow(scoreGraph());
    await start(workflowId, undefined, { writeMode: 'propose' });
    await drain();
    expect(calls[0]!.body).toMatchObject({ writeMode: 'propose' });

    calls = [];
    await start(workflowId);
    await drain();
    expect(calls[0]!.body).not.toHaveProperty('writeMode');
  });

  it('starts nothing twice when the attempt is delivered again', async () => {
    const workflowId = await publishedWorkflow(scoreGraph());
    const runId = await start(workflowId);
    await drain();
    const attempt = attemptOf(await readRun(runId), 'review')!;

    // A worker died after starting the work and the sweep queued the attempt
    // again: the item and its run come back, nothing new is created.
    await prisma.workflowNodeExecution.update({
      where: { id: attempt.id },
      data: { status: 'QUEUED', waitingOn: Prisma.DbNull, availableAt: clock },
    });
    queue.push({ kind: 'execute', runId, executionId: attempt.id, correlationId: 'test' });
    await drain();

    const items = await prisma.workItem.findMany({ where: { workflowExecutionId: attempt.id } });
    expect(items).toHaveLength(1);
    const runs = await prisma.aiRun.count({ where: { workItemId: items[0]!.id } });
    expect(runs).toBe(1);
    expect(calls.filter((call) => call.path.endsWith('/runs'))).toHaveLength(1);
    expect(attemptOf(await readRun(runId), 'review')!.status).toBe('WAITING');
  });

  it('waits through a question and a paused run, and only the item decides', async () => {
    const workflowId = await publishedWorkflow(scoreGraph({ completion: 'done' }));
    const runId = await start(workflowId);
    await drain();
    const item = await itemOf(runId);

    // The run asks a person and ends; the item waits for the answer.
    await prisma.aiRun.updateMany({
      where: { workItemId: item.id },
      data: { status: 'COMPLETED', finishedAt: clock },
    });
    await prisma.workItem.update({
      where: { id: item.id },
      data: { status: 'WAITING_FOR_HUMAN' },
    });
    await wake(item.id);
    await drain();
    later(STALL_AFTER_MS * 5);
    await sweep();
    await drain();
    expect(attemptOf(await readRun(runId), 'review')!.status).toBe('WAITING');

    // The answer carries the work on in a new run, which hands it in for
    // review; the node asked for done, so review is a person's turn.
    await prisma.aiRun.create({
      data: {
        workspaceId,
        createdById: ownerId,
        provider: 'mock',
        model: 'mock/model',
        messages: [],
        workItemId: item.id,
        status: 'RUNNING',
      },
    });
    await prisma.workItem.update({ where: { id: item.id }, data: { status: 'WORKING' } });
    await handIn(item.id, 'REVIEW', { score: 3 });
    await wake(item.id);
    await drain();
    expect(attemptOf(await readRun(runId), 'review')!.status).toBe('WAITING');

    // A person accepts it.
    await prisma.workItem.update({ where: { id: item.id }, data: { status: 'DONE' } });
    await wake(item.id);
    await drain();
    const run = await readRun(runId);
    expect(attemptOf(run, 'review')!.output).toMatchObject({
      outcome: 'done',
      fields: { score: 3 },
    });
    expect(attemptOf(run, 'good')!.firedHandles).toEqual(['false']);
    expect(run.status).toBe('FAILED');
  });

  it('fails cleanly when the fields do not hold, the work fails, or it is gone', async () => {
    const invalid = await start(await publishedWorkflow(scoreGraph()));
    await drain();
    const invalidItem = await itemOf(invalid);
    await handIn(invalidItem.id, 'DONE', { score: 'acht' });
    await wake(invalidItem.id);
    await drain();
    let run = await readRun(invalid);
    expect(attemptOf(run, 'review')).toMatchObject({
      status: 'FAILED',
      errorCode: 'workflow_output_invalid',
    });
    expect(run.status).toBe('FAILED');

    const failed = await start(await publishedWorkflow(scoreGraph()));
    await drain();
    const failedItem = await itemOf(failed);
    await prisma.workItem.update({ where: { id: failedItem.id }, data: { status: 'FAILED' } });
    await wake(failedItem.id);
    await drain();
    expect(attemptOf(await readRun(failed), 'review')!.errorCode).toBe('workflow_work_item_failed');

    // Deleted: the column on the attempt goes to null, and the wake from
    // the API finds the attempt by what it waits on; here the sweep does.
    const gone = await start(await publishedWorkflow(scoreGraph()));
    await drain();
    const goneItem = await itemOf(gone);
    await prisma.aiRun.deleteMany({ where: { workItemId: goneItem.id } });
    await prisma.workItem.delete({ where: { id: goneItem.id } });
    await sweep();
    await drain();
    run = await readRun(gone);
    expect(attemptOf(run, 'review')!.errorCode).toBe('workflow_work_item_gone');
  });

  it('refuses honestly when the API refuses to start the run', async () => {
    refuseRuns = true;
    const runId = await start(await publishedWorkflow(scoreGraph()));
    await drain();
    const attempt = attemptOf(await readRun(runId), 'review')!;
    expect(attempt).toMatchObject({ status: 'FAILED', errorCode: 'workflow_agent_refused' });
    expect(attempt.errorMessage).toContain('ai_disabled');
  });

  it('settles from the sweep when a wake was lost, and calls open work with no run stalled', async () => {
    const lost = await start(await publishedWorkflow(scoreGraph()));
    await drain();
    const lostItem = await itemOf(lost);
    await handIn(lostItem.id, 'DONE', { score: 9 });
    // No wake: the API was restarted between commit and enqueue.
    await sweep();
    await drain();
    expect((await readRun(lost)).status).toBe('SUCCEEDED');

    const stalled = await start(await publishedWorkflow(scoreGraph()));
    await drain();
    const stalledItem = await itemOf(stalled);
    await prisma.aiRun.updateMany({
      where: { workItemId: stalledItem.id },
      data: { status: 'FAILED', finishedAt: clock },
    });
    await sweep();
    await drain();
    expect(attemptOf(await readRun(stalled), 'review')!.status).toBe('WAITING');
    later(STALL_AFTER_MS);
    await sweep();
    await drain();
    expect(attemptOf(await readRun(stalled), 'review')!.errorCode).toBe(
      'workflow_work_item_stalled',
    );
  });

  it('counts delegated children against the run, and parallel nodes share the budget', async () => {
    const graph: WorkflowGraphInput = {
      schemaVersion: 1,
      nodes: [
        { id: 'start', type: 'trigger.manual' },
        { id: 'fan', type: 'parallel' },
        { id: 'left', type: 'agent', goal: 'links', budgetMicroUsd: 700_000 },
        { id: 'right', type: 'agent', goal: 'rechts', budgetMicroUsd: 700_000 },
        { id: 'meet', type: 'join', policy: 'all' },
        { id: 'done', type: 'end', outcome: 'succeeded' },
      ],
      edges: [
        edge('e1', 'start', 'next', 'fan'),
        edge('e2', 'fan', 'branch', 'left'),
        edge('e3', 'fan', 'branch', 'right'),
        edge('e4', 'left', 'next', 'meet'),
        edge('e5', 'right', 'next', 'meet'),
        edge('e6', 'meet', 'next', 'done'),
      ],
      limits: { budgetMicroUsd: 1_000_000 },
    };
    const runId = await start(await publishedWorkflow(graph));
    await drain();

    let run = await readRun(runId);
    const budgets = await Promise.all(
      ['left', 'right'].map(async (nodeId) => {
        const attempt = attemptOf(run, nodeId)!;
        const item = await prisma.workItem.findUnique({
          where: { workflowExecutionId: attempt.id },
        });
        return { nodeId, budget: item?.budgetMicroUsd ?? null };
      }),
    );
    // The first gets its 0.70 USD, the second only what is left of the run's 1.00.
    expect(budgets.map((entry) => entry.budget ?? 0).toSorted((a, b) => a - b)).toEqual([
      300_000, 700_000,
    ]);

    // The left item delegates a child that spends money on its own run.
    const left = await prisma.workItem.findUniqueOrThrow({
      where: { workflowExecutionId: attemptOf(run, 'left')!.id },
    });
    const child = await prisma.workItem.create({
      data: {
        workspaceId,
        title: 'Teil',
        goal: 'Teil',
        requesterKind: 'ASSISTANT',
        requesterId: ownerId,
        parentId: left.id,
        status: 'DONE',
      },
    });
    await prisma.aiRun.create({
      data: {
        workspaceId,
        createdById: ownerId,
        provider: 'mock',
        model: 'mock/model',
        messages: [],
        workItemId: child.id,
        status: 'COMPLETED',
        finishedAt: clock,
        providerCostMicroUsd: 50_000,
      },
    });
    await handIn(left.id, 'DONE', null, 100_000);
    await wake(left.id);
    const right = await prisma.workItem.findUniqueOrThrow({
      where: { workflowExecutionId: attemptOf(run, 'right')!.id },
    });
    await handIn(right.id, 'DONE', null, 20_000);
    await wake(right.id);
    await drain();

    run = await readRun(runId);
    expect(run.status).toBe('SUCCEEDED');
    expect(attemptOf(run, 'left')!.output).toMatchObject({ spentMicroUsd: 150_000 });
    expect(run.spentMicroUsd).toBe(170_000);
  });

  it('refuses a node when the run has no budget left', async () => {
    const graph = scoreGraph();
    const runId = await start(await publishedWorkflow(graph));
    await prisma.workflowRun.update({
      where: { id: runId },
      data: { spentMicroUsd: 1_000_000 },
    });
    await drain();
    // The advance stops a run that spent its budget before it queues more,
    // so no work is created at all.
    expect((await readRun(runId)).status).toBe('FAILED');
    expect(calls).toHaveLength(0);
  });
});
