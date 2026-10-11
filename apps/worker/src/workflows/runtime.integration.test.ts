import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { loadDotEnv } from '@exocortex/config';
import {
  type Settings,
  settingsSchema,
  type WorkflowGraphInput,
  workflowGraphSchema,
  type WorkflowJob,
} from '@exocortex/contracts';
import {
  createPrismaClient,
  generateOrderKey,
  type Prisma,
  type PrismaClient,
  startWorkflowRun,
  syncWorkflowTriggers,
} from '@exocortex/database';
import { createLogger } from '@exocortex/logger';

import { DEFAULT_NODE_HANDLERS, type NodeHandler, type NodeHandlerRegistry } from './handlers';
import {
  advanceWorkflowRun,
  executeWorkflowNode,
  runWorkflowJob,
  type WorkflowRuntimeDependencies,
} from './runtime';
import { sweepWorkflowRuns } from './sweep';
import { startMatchingWorkflows, startWorkflowFromEvent } from './triggers';

/**
 * The workflow runtime against the real database (issue #161, ADR-076).
 *
 * The queue is a list the test drains by hand, which is what lets it lose a
 * job, deliver one twice, or stop between any two steps -- a worker killed at
 * that point leaves exactly this behind: rows, and jobs that may or may not
 * exist. What is proven:
 *
 * - a run with a fan-out and a join walks the graph and records its path;
 * - every job can be lost after any step and the sweep finishes the run;
 * - a redelivered or concurrent execute runs the handler once;
 * - an expired lease is requeued for an idempotent node, failed otherwise;
 * - a waiting node holds no job and resumes from its timer;
 * - retries are bounded and visible, and never for a non-idempotent node;
 * - node count, parallel branches, lifetime and budget stop a run;
 * - a change starts an event workflow, never from its own write, and the
 *   clock starts a scheduled one exactly once per slot.
 */
loadDotEnv();

const logger = createLogger({ name: 'workflow-runtime-test', level: 'silent' });

let prisma: PrismaClient;
let workspaceId: string;
let ownerId: string;

let settingsOverride: Partial<Settings> = {};
function currentSettings(): Settings {
  return { ...settingsSchema.parse({}), 'workflows.enabled': true, ...settingsOverride };
}

interface QueuedJob {
  job: WorkflowJob;
  delayMs: number;
  jobId: string | null;
}
let queue: QueuedJob[] = [];
let debounced: QueuedJob[] = [];
const queues = {
  async enqueue(_name: string, job: WorkflowJob, options?: { delay?: number; jobId?: string }) {
    queue.push({ job, delayMs: options?.delay ?? 0, jobId: options?.jobId ?? null });
    return 'job';
  },
  async enqueueDebounced(
    _name: string,
    job: WorkflowJob,
    options: { jobId: string; delayMs?: number },
  ) {
    debounced.push({ job, delayMs: options.delayMs ?? 0, jobId: options.jobId });
    return options.jobId;
  },
};

let clock = new Date('2026-10-11T10:00:00.000Z');
function later(ms: number): void {
  clock = new Date(clock.getTime() + ms);
}

/** Side effects of the test handlers, keyed by idempotency key. */
let effects: string[] = [];

function runtime(
  handlers: NodeHandlerRegistry = DEFAULT_NODE_HANDLERS,
): WorkflowRuntimeDependencies {
  return {
    prisma,
    queues: queues as unknown as WorkflowRuntimeDependencies['queues'],
    settings: async () => currentSettings(),
    logger,
    handlers,
    now: () => clock,
  };
}

function triggers() {
  return {
    prisma,
    queues: queues as never,
    settings: async () => currentSettings(),
    logger,
    now: () => clock,
  };
}

/**
 * Runs queued jobs until none is left. A delayed job moves the clock on by
 * its delay first, which is what BullMQ's delay means to the runtime.
 */
async function drain(dependencies: WorkflowRuntimeDependencies, limit = 200): Promise<number> {
  let processed = 0;
  while (queue.length > 0 && processed < limit) {
    const next = queue.shift()!;
    if (next.delayMs > 0) later(next.delayMs);
    await runWorkflowJob(dependencies, next.job, async (job) => {
      await startWorkflowFromEvent(triggers() as never, job);
    });
    processed += 1;
  }
  return processed;
}

/** The sweep, confined to this suite's workspace like a scoped maintenance job. */
async function sweep(dependencies: WorkflowRuntimeDependencies): Promise<void> {
  await sweepWorkflowRuns({ ...dependencies, triggers: triggers(), workspaceId });
}

function edge(id: string, from: string, handle: string, to: string) {
  return { id, kind: 'flow' as const, source: { nodeId: from, handle }, target: { nodeId: to } };
}

/** An agent node as the test handlers see it: the goal says what to do. */
function agent(id: string, goal: string, outputFields: { name: string; type: 'number' }[] = []) {
  return { id, type: 'agent' as const, goal, outputFields };
}

let counter = 0;
async function publishedWorkflow(graph: WorkflowGraphInput, enabled = false) {
  counter += 1;
  const parsed = workflowGraphSchema.parse(graph);
  const workflow = await prisma.workflow.create({
    data: {
      workspaceId,
      name: `Runtime ${String(counter)} ${Date.now().toString(36)}`,
      draftGraph: parsed as Prisma.InputJsonObject,
      createdById: ownerId,
    },
  });
  const version = await prisma.workflowVersion.create({
    data: {
      workflowId: workflow.id,
      version: 1,
      graph: parsed as Prisma.InputJsonObject,
      graphHash: `hash-${String(counter)}`,
      draftRevision: 1,
    },
  });
  await prisma.workflow.update({
    where: { id: workflow.id },
    data: {
      publishedVersionId: version.id,
      enabled,
      enabledById: enabled ? ownerId : null,
    },
  });
  if (enabled) await syncWorkflowTriggers(prisma, workflow.id, clock);
  return { workflowId: workflow.id, versionId: version.id };
}

async function start(workflowId: string, triggerNodeId: string | null = null): Promise<string> {
  const started = await startWorkflowRun(prisma, {
    workflowId,
    origin: 'manual',
    triggerNodeId,
    startedById: ownerId,
    correlationId: 'test',
    chainDepth: 0,
    settings: currentSettings(),
    requireEnabled: false,
    now: clock,
  });
  if (!started.ok) throw new Error(started.reason);
  queue.push({
    job: { kind: 'advance', runId: started.runId, correlationId: 'test' },
    delayMs: 0,
    jobId: null,
  });
  return started.runId;
}

async function readRun(runId: string) {
  return prisma.workflowRun.findUniqueOrThrow({
    where: { id: runId },
    include: {
      nodeExecutions: { orderBy: [{ queuedAt: 'asc' }, { attempt: 'asc' }] },
      events: { orderBy: { sequence: 'asc' } },
    },
  });
}

/**
 * Test handlers in the agent slot, chosen by the node's goal: `record`
 * writes one effect per idempotency key, `score:<n>` answers a number,
 * `flaky:<n>` fails retryably n times, `wait` waits for a timer, `slow`
 * blocks until released, `once` is not idempotent and fails retryably.
 */
let release: (() => void) | null = null;

/** Waits until a `slow` handler is blocked, then returns its release. */
async function blockedSlow(): Promise<() => void> {
  for (;;) {
    const held: (() => void) | null = release;
    if (held !== null) {
      release = null;
      return held;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
const flakyFailures = new Map<string, number>();
const agentHandler: NodeHandler = {
  idempotent: true,
  execute: async ({ node, execution }) => {
    const goal = node.type === 'agent' ? node.goal : '';
    if (goal === 'wait') {
      return {
        status: 'waiting',
        wait: { kind: 'timer', until: new Date(clock.getTime() + 30 * 60_000).toISOString() },
      };
    }
    if (goal === 'slow') {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    }
    if (goal.startsWith('flaky:')) {
      const allowed = Number(goal.slice('flaky:'.length));
      const seen = flakyFailures.get(node.id) ?? 0;
      if (seen < allowed) {
        flakyFailures.set(node.id, seen + 1);
        return { status: 'failed', errorClass: 'retryable', code: 'test_flaky', message: 'flaky' };
      }
    }
    if (!effects.includes(execution.idempotencyKey)) effects.push(execution.idempotencyKey);
    const output = goal.startsWith('score:')
      ? { fields: { score: Number(goal.slice('score:'.length)) } }
      : null;
    return { status: 'succeeded', handles: ['next'], output };
  },
  resume: async ({ execution }) => {
    effects.push(`${execution.idempotencyKey}:resumed`);
    return { status: 'succeeded', handles: ['next'], output: null };
  },
};
const onceHandler: NodeHandler = {
  idempotent: false,
  execute: async ({ execution }) => {
    effects.push(execution.idempotencyKey);
    return { status: 'failed', errorClass: 'retryable', code: 'test_once', message: 'once' };
  },
};
const handlers: NodeHandlerRegistry = { ...DEFAULT_NODE_HANDLERS, agent: agentHandler };

const diamond: WorkflowGraphInput = {
  schemaVersion: 1,
  nodes: [
    { id: 'start', type: 'trigger.manual' },
    { id: 'fan', type: 'parallel' },
    agent('left', 'record'),
    agent('right', 'score:8', [{ name: 'score', type: 'number' }]),
    { id: 'meet', type: 'join', policy: 'all' },
    {
      id: 'good',
      type: 'condition',
      source: { nodeId: 'right', field: 'score' },
      operator: 'gte',
      value: 7,
    },
    { id: 'yes', type: 'end', outcome: 'succeeded' },
    { id: 'no', type: 'end', outcome: 'failed' },
  ],
  edges: [
    edge('e1', 'start', 'next', 'fan'),
    edge('e2', 'fan', 'branch', 'left'),
    edge('e3', 'fan', 'branch', 'right'),
    edge('e4', 'left', 'next', 'meet'),
    edge('e5', 'right', 'next', 'meet'),
    edge('e6', 'meet', 'next', 'good'),
    edge('e7', 'good', 'true', 'yes'),
    edge('e8', 'good', 'false', 'no'),
  ],
};

beforeAll(async () => {
  prisma = createPrismaClient({ databaseUrl: process.env.DATABASE_URL });
  const suffix = Date.now().toString(36);
  ownerId = (
    await prisma.user.create({
      data: { email: `wf-rt-${suffix}@exocortex.test`, name: 'Owner', emailVerified: true },
    })
  ).id;
  workspaceId = (
    await prisma.workspace.create({
      data: {
        name: `Workflow runtime ${suffix}`,
        slug: `workflow-runtime-${suffix}`,
        members: { create: { userId: ownerId, role: 'OWNER' } },
      },
    })
  ).id;
});

afterAll(async () => {
  await prisma.workflowRun.deleteMany({ where: { workspaceId } });
  await prisma.workflow.updateMany({ where: { workspaceId }, data: { publishedVersionId: null } });
  await prisma.workflow.deleteMany({ where: { workspaceId } });
  await prisma.workspace.deleteMany({ where: { id: workspaceId } });
  await prisma.user.deleteMany({ where: { id: ownerId } });
  await prisma.$disconnect();
});

beforeEach(() => {
  queue = [];
  debounced = [];
  effects = [];
  settingsOverride = {};
  flakyFailures.clear();
  release = null;
});

describe('workflow runtime', () => {
  it('walks a fan-out, a join and a condition, and records the path it took', async () => {
    const { workflowId } = await publishedWorkflow(diamond);
    const runId = await start(workflowId);
    await drain(runtime(handlers));

    const run = await readRun(runId);
    expect(run.status).toBe('SUCCEEDED');
    expect(run.finishedAt).not.toBeNull();
    const status = Object.fromEntries(run.nodeExecutions.map((row) => [row.nodeId, row.status]));
    expect(status).toEqual({
      start: 'SUCCEEDED',
      fan: 'SUCCEEDED',
      left: 'SUCCEEDED',
      right: 'SUCCEEDED',
      meet: 'SUCCEEDED',
      good: 'SUCCEEDED',
      yes: 'SUCCEEDED',
      no: 'SKIPPED',
    });
    // The history alone says which way the run went.
    const taken = run.events
      .filter((event) => event.type === 'edge.taken')
      .map((event) => (event.detail as { edgeId: string }).edgeId);
    expect(taken.toSorted()).toEqual(['e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7'].toSorted());
    expect(run.events.at(-1)?.type).toBe('run.finished');
    expect(run.events.map((event) => event.sequence)).toEqual(
      run.events.map((_, index) => index + 1),
    );
    expect(effects.toSorted()).toEqual([`${runId}:left:1`, `${runId}:right:1`]);
  });

  it('finishes a run after losing the next job at every single step', async () => {
    const { workflowId } = await publishedWorkflow(diamond);
    const runId = await start(workflowId);
    const dependencies = runtime(handlers);
    // One job at a time; after each, everything queued is thrown away, as if
    // the worker died right after committing. Only the sweep brings it back.
    for (let step = 0; step < 40; step += 1) {
      const run = await prisma.workflowRun.findUniqueOrThrow({ where: { id: runId } });
      if (run.status === 'SUCCEEDED') break;
      if (queue.length === 0) {
        later(3 * 60_000);
        await sweep(dependencies);
      }
      const next = queue.shift();
      if (next !== undefined) await runWorkflowJob(dependencies, next.job, async () => {});
      queue = [];
    }
    const run = await readRun(runId);
    expect(run.status).toBe('SUCCEEDED');
    expect(effects.toSorted()).toEqual([`${runId}:left:1`, `${runId}:right:1`]);
  });

  it('runs a handler once for a redelivered or concurrently delivered job', async () => {
    const { workflowId } = await publishedWorkflow({
      schemaVersion: 1,
      nodes: [
        { id: 'start', type: 'trigger.manual' },
        agent('work', 'record'),
        { id: 'done', type: 'end', outcome: 'succeeded' },
      ],
      edges: [edge('e1', 'start', 'next', 'work'), edge('e2', 'work', 'next', 'done')],
    });
    const runId = await start(workflowId);
    const dependencies = runtime(handlers);
    await advanceWorkflowRun(dependencies, runId);
    const execute = queue.find((entry) => entry.job.kind === 'execute')!;
    const executionId = (execute.job as Extract<WorkflowJob, { kind: 'execute' }>).executionId;
    queue = [];

    const [first, second] = await Promise.all([
      executeWorkflowNode(dependencies, executionId),
      executeWorkflowNode(dependencies, executionId),
    ]);
    expect([first, second].filter(Boolean)).toHaveLength(1);
    // And once more, long after: the attempt is finished, nothing happens.
    expect(await executeWorkflowNode(dependencies, executionId)).toBe(false);
    expect(effects).toEqual([`${runId}:work:1`]);
    await drain(dependencies);
    expect((await readRun(runId)).status).toBe('SUCCEEDED');
  });

  it('recovers an expired lease: requeued when idempotent, failed when not', async () => {
    const graph = (goal: string): WorkflowGraphInput => ({
      schemaVersion: 1,
      nodes: [
        { id: 'start', type: 'trigger.manual' },
        agent('work', goal),
        { id: 'done', type: 'end', outcome: 'succeeded' },
      ],
      edges: [edge('e1', 'start', 'next', 'work'), edge('e2', 'work', 'next', 'done')],
    });

    // Idempotent and slow: its worker "dies" while the handler runs.
    const idempotent = await publishedWorkflow(graph('slow'));
    const runId = await start(idempotent.workflowId);
    const dependencies = runtime(handlers);
    await advanceWorkflowRun(dependencies, runId);
    const execute = queue.find((entry) => entry.job.kind === 'execute')!;
    queue = [];
    const executionId = (execute.job as Extract<WorkflowJob, { kind: 'execute' }>).executionId;
    const abandoned = executeWorkflowNode(dependencies, executionId);
    const releaseAbandoned = await blockedSlow();
    later(2 * 60_000);
    await sweep(dependencies);
    const requeued = await prisma.workflowNodeExecution.findUniqueOrThrow({
      where: { id: executionId },
    });
    expect(requeued.status).toBe('QUEUED');
    // The abandoned worker comes back after all: its side effect happened,
    // keyed by the attempt, but its result has no lease and is dropped.
    releaseAbandoned();
    await abandoned;
    expect(effects).toEqual([`${runId}:work:1`]);
    expect(
      (await prisma.workflowNodeExecution.findUniqueOrThrow({ where: { id: executionId } })).status,
    ).toBe('QUEUED');
    const rerun = drain(dependencies);
    (await blockedSlow())();
    await rerun;
    await drain(dependencies);
    expect((await readRun(runId)).status).toBe('SUCCEEDED');
    expect(effects).toEqual([`${runId}:work:1`]);

    // Not idempotent: the same situation fails the attempt instead.
    const onceHandlers: NodeHandlerRegistry = {
      ...DEFAULT_NODE_HANDLERS,
      agent: { ...agentHandler, idempotent: false },
    };
    const strict = await publishedWorkflow(graph('slow'));
    const strictRun = await start(strict.workflowId);
    const strictDependencies = runtime(onceHandlers);
    await advanceWorkflowRun(strictDependencies, strictRun);
    const strictJob = queue.find((entry) => entry.job.kind === 'execute')!;
    queue = [];
    const strictAbandoned = executeWorkflowNode(
      strictDependencies,
      (strictJob.job as Extract<WorkflowJob, { kind: 'execute' }>).executionId,
    );
    const releaseStrict = await blockedSlow();
    later(2 * 60_000);
    await sweep(strictDependencies);
    releaseStrict();
    await strictAbandoned;
    await drain(strictDependencies);
    const failed = await readRun(strictRun);
    expect(failed.status).toBe('FAILED');
    expect(failed.errorCode).toBe('workflow_node_failed');
    const work = failed.nodeExecutions.find((row) => row.nodeId === 'work');
    expect(work).toMatchObject({ status: 'FAILED', errorCode: 'workflow_node_interrupted' });
    expect(failed.nodeExecutions.find((row) => row.nodeId === 'done')?.status).toBe('SKIPPED');
  });

  it('waits without a job and resumes from its timer', async () => {
    const { workflowId } = await publishedWorkflow({
      schemaVersion: 1,
      nodes: [
        { id: 'start', type: 'trigger.manual' },
        agent('hold', 'wait'),
        { id: 'done', type: 'end', outcome: 'succeeded' },
      ],
      edges: [edge('e1', 'start', 'next', 'hold'), edge('e2', 'hold', 'next', 'done')],
    });
    const runId = await start(workflowId);
    const dependencies = runtime(handlers);
    await drain(dependencies);
    const waiting = await readRun(runId);
    expect(waiting.status).toBe('WAITING');
    expect(waiting.waitingSince).not.toBeNull();
    expect(queue).toEqual([]);

    // Not yet: the sweep leaves it alone.
    later(10 * 60_000);
    await sweep(dependencies);
    expect(queue.filter((entry) => entry.job.kind === 'resume')).toEqual([]);

    later(25 * 60_000);
    await sweep(dependencies);
    expect(queue.filter((entry) => entry.job.kind === 'resume')).toHaveLength(1);
    await drain(dependencies);
    const done = await readRun(runId);
    expect(done.status).toBe('SUCCEEDED');
    expect(effects).toEqual([`${runId}:hold:1:resumed`]);
    expect(done.events.map((event) => event.type)).toEqual(
      expect.arrayContaining(['node.waiting', 'node.resumed']),
    );
  });

  it('retries a retryable failure, bounded and visible, and never a non-idempotent node', async () => {
    const { workflowId } = await publishedWorkflow({
      schemaVersion: 1,
      nodes: [
        { id: 'start', type: 'trigger.manual' },
        agent('shaky', 'flaky:2'),
        { id: 'done', type: 'end', outcome: 'succeeded' },
      ],
      edges: [edge('e1', 'start', 'next', 'shaky'), edge('e2', 'shaky', 'next', 'done')],
    });
    const runId = await start(workflowId);
    const dependencies = runtime(handlers);
    // Before its backoff has passed the claim refuses the retry.
    await advanceWorkflowRun(dependencies, runId);
    queue = [];
    const first = await prisma.workflowNodeExecution.findFirstOrThrow({
      where: { runId, nodeId: 'shaky' },
    });
    await executeWorkflowNode(dependencies, first.id);
    const retry = await prisma.workflowNodeExecution.findFirstOrThrow({
      where: { runId, nodeId: 'shaky', attempt: 2 },
    });
    expect(retry.availableAt.getTime() - clock.getTime()).toBe(10_000);
    expect(await executeWorkflowNode(dependencies, retry.id)).toBe(false);
    await drain(dependencies);
    const pending = await readRun(runId);
    expect(pending.status).toBe('SUCCEEDED');
    const attempts = pending.nodeExecutions.filter((row) => row.nodeId === 'shaky');
    expect(attempts.map((row) => [row.attempt, row.status])).toEqual([
      [1, 'FAILED'],
      [2, 'FAILED'],
      [3, 'SUCCEEDED'],
    ]);
    expect(pending.events.filter((event) => event.type === 'node.retry_scheduled')).toHaveLength(2);

    const once = await publishedWorkflow({
      schemaVersion: 1,
      nodes: [
        { id: 'start', type: 'trigger.manual' },
        agent('send', 'once'),
        { id: 'done', type: 'end', outcome: 'succeeded' },
      ],
      edges: [edge('e1', 'start', 'next', 'send'), edge('e2', 'send', 'next', 'done')],
    });
    const onceRun = await start(once.workflowId);
    await drain(runtime({ ...DEFAULT_NODE_HANDLERS, agent: onceHandler }));
    const failed = await readRun(onceRun);
    expect(failed.status).toBe('FAILED');
    expect(failed.nodeExecutions.filter((row) => row.nodeId === 'send')).toHaveLength(1);
    expect(effects).toContain(`${onceRun}:send:1`);
  });

  it('stops runaway graphs at their limits', async () => {
    // Node count: twelve agents in a row against a limit of five.
    const chain = Array.from({ length: 12 }, (_, index) => agent(`a${String(index)}`, 'record'));
    const { workflowId } = await publishedWorkflow({
      schemaVersion: 1,
      nodes: [{ id: 'start', type: 'trigger.manual' }, ...chain],
      edges: chain.map((node, index) =>
        edge(`e${String(index)}`, index === 0 ? 'start' : `a${String(index - 1)}`, 'next', node.id),
      ),
      limits: { maxNodeExecutions: 5 },
    });
    const runId = await start(workflowId);
    await drain(runtime(handlers));
    const limited = await readRun(runId);
    expect(limited.status).toBe('FAILED');
    expect(limited.errorCode).toBe('workflow_node_limit');
    expect(limited.nodeExecutionCount).toBe(5);
    expect(limited.events.some((event) => event.type === 'run.limit_reached')).toBe(true);

    // Parallel branches: six branches, at most two in flight at a time.
    const branches = Array.from({ length: 6 }, (_, index) => agent(`b${String(index)}`, 'wait'));
    const wide = await publishedWorkflow({
      schemaVersion: 1,
      nodes: [
        { id: 'start', type: 'trigger.manual' },
        { id: 'fan', type: 'parallel' },
        ...branches,
      ],
      edges: [
        edge('e0', 'start', 'next', 'fan'),
        ...branches.map((node, index) => edge(`f${String(index)}`, 'fan', 'branch', node.id)),
      ],
      limits: { maxParallelBranches: 2 },
    });
    const wideRun = await start(wide.workflowId);
    await drain(runtime(handlers));
    const held = await readRun(wideRun);
    expect(held.nodeExecutions.filter((row) => row.status === 'WAITING')).toHaveLength(2);
    expect(held.status).toBe('WAITING');

    // Lifetime: the waiting run is timed out once its deadline passes.
    later(8 * 24 * 3_600_000);
    await sweep(runtime(handlers));
    await drain(runtime(handlers));
    const expired = await readRun(wideRun);
    expect(expired.status).toBe('TIMED_OUT');
    expect(expired.errorCode).toBe('workflow_lifetime_exceeded');
    expect(expired.nodeExecutions.filter((row) => row.status === 'TIMED_OUT')).toHaveLength(2);

    // Budget: a run that has spent it starts nothing more.
    const spent = await publishedWorkflow(diamond);
    const spentRun = await start(spent.workflowId);
    await prisma.workflowRun.update({
      where: { id: spentRun },
      data: { spentMicroUsd: 2_000_000 },
    });
    await drain(runtime(handlers));
    expect((await readRun(spentRun)).errorCode).toBe('workflow_budget_exhausted');
  });

  it('stops a run in flight when workflows are switched off', async () => {
    const { workflowId } = await publishedWorkflow(diamond);
    const runId = await start(workflowId);
    const dependencies = runtime(handlers);
    await advanceWorkflowRun(dependencies, runId);
    settingsOverride = { 'workflows.enabled': false };
    await drain(dependencies);
    const run = await readRun(runId);
    expect(run.status).toBe('CANCELLED');
    expect(run.errorCode).toBe('workflow_disabled');
    expect(effects).toEqual([]);
  });

  it('starts an event workflow from a change, never from its own write, within the depth', async () => {
    const page = await prisma.document.create({
      data: {
        workspaceId,
        title: 'Auslöser',
        type: 'PAGE',
        orderKey: generateOrderKey(null, null),
        createdById: ownerId,
        updatedById: ownerId,
      },
    });
    const { workflowId } = await publishedWorkflow(
      {
        schemaVersion: 1,
        nodes: [
          {
            id: 'changed',
            type: 'trigger.event',
            events: ['DOCUMENT_UPDATED'],
            scopeDocumentId: null,
          },
          { id: 'done', type: 'end', outcome: 'succeeded' },
        ],
        edges: [edge('e1', 'changed', 'next', 'done')],
      },
      true,
    );
    const event = {
      workspaceId,
      type: 'document.updated',
      payload: { documentId: page.id },
      correlationId: 'event',
      workflowId: null,
      depth: 0,
    };
    expect(await startMatchingWorkflows(triggers() as never, event)).toBe(1);
    expect(await startMatchingWorkflows(triggers() as never, { ...event, workflowId })).toBe(0);
    expect(await startMatchingWorkflows(triggers() as never, { ...event, depth: 3 })).toBe(0);
    expect(
      await startMatchingWorkflows(triggers() as never, { ...event, type: 'document.created' }),
    ).toBe(0);

    expect(debounced).toHaveLength(1);
    expect(debounced[0]?.jobId).toBe(`workflow-${workflowId}-changed-${page.id}`);
    queue.push(debounced[0]!);
    await drain(runtime(handlers));
    const runs = await prisma.workflowRun.findMany({ where: { workflowId } });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      status: 'SUCCEEDED',
      origin: 'EVENT',
      chainDepth: 1,
      startedById: ownerId,
    });
    await prisma.workflowRun.deleteMany({ where: { workflowId } });
    await prisma.document.delete({ where: { id: page.id } });
  });

  it('starts a scheduled workflow once per slot and moves its trigger on', async () => {
    const { workflowId } = await publishedWorkflow(
      {
        schemaVersion: 1,
        nodes: [
          {
            id: 'daily',
            type: 'trigger.schedule',
            schedule: { kind: 'DAILY', time: '07:30', timeZone: 'Europe/Berlin' },
          },
          { id: 'done', type: 'end', outcome: 'succeeded' },
        ],
        edges: [edge('e1', 'daily', 'next', 'done')],
      },
      true,
    );
    const row = await prisma.workflowTrigger.findFirstOrThrow({ where: { workflowId } });
    expect(row.nextRunAt).not.toBeNull();
    clock = new Date(row.nextRunAt!.getTime() + 30_000);
    const dependencies = runtime(handlers);
    await sweep(dependencies);
    await sweep(dependencies);
    await drain(dependencies);
    const runs = await prisma.workflowRun.findMany({ where: { workflowId } });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: 'SUCCEEDED', origin: 'SCHEDULE' });
    const moved = await prisma.workflowTrigger.findFirstOrThrow({ where: { workflowId } });
    expect(moved.nextRunAt!.getTime()).toBeGreaterThan(clock.getTime());
  });
});
