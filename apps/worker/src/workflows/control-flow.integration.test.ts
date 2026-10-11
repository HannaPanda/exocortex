import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { loadDotEnv } from '@exocortex/config';
import {
  type ApplicationEvent,
  type Settings,
  settingsSchema,
  type WorkflowGraphInput,
  workflowGraphSchema,
  type WorkflowJob,
} from '@exocortex/contracts';
import {
  cancelWorkflowRun,
  createPrismaClient,
  Prisma,
  type PrismaClient,
  startWorkflowRun,
} from '@exocortex/database';
import { createLogger } from '@exocortex/logger';

import { createApprovalNodeHandler } from './approval-node';
import { DEFAULT_NODE_HANDLERS, type NodeHandler, type NodeHandlerRegistry } from './handlers';
import { runWorkflowJob, type WorkflowRuntimeDependencies } from './runtime';
import { sweepWorkflowRuns } from './sweep';

/**
 * Control flow in workflow runs against the real database (issue #163).
 *
 * The approval node runs for real: it raises an ordinary attention item and
 * waits on it. A person's answer is written the way the API settles an item
 * without a work item (status, resolution, who), and the wake is a `resume`
 * job, or nothing at all when the test loses it on purpose. What is proven:
 *
 * - an approval asks once however often its attempt is delivered, holds no
 *   job while it waits, survives days, and resumes on the branch chosen;
 * - replaying the answer resumes nothing twice;
 * - a lost wake is found by the sweep;
 * - cancelling or ending a run makes its open approval obsolete;
 * - an end node ends the run at once with its outcome and summary;
 * - a join waiting for any input continues once and tolerates the branch
 *   that failed;
 * - a condition reads an approval's fields and the run's input.
 */
loadDotEnv();

const logger = createLogger({ name: 'workflow-control-test', level: 'silent' });

let prisma: PrismaClient;
let workspaceId: string;
let ownerId: string;

function currentSettings(): Settings {
  return { ...settingsSchema.parse({}), 'workflows.enabled': true };
}

let queue: WorkflowJob[] = [];
const queues = {
  async enqueue(_name: string, job: WorkflowJob) {
    queue.push(job);
    return 'job';
  },
};
const published: ApplicationEvent[] = [];
const bus = {
  publish: async (event: ApplicationEvent) => {
    published.push(event);
  },
};

let clock = new Date('2026-10-11T10:00:00.000Z');

/** Agent slot for tests: `score:<n>` answers a number, `fail` fails for good. */
const agentHandler: NodeHandler = {
  idempotent: true,
  execute: async ({ node }) => {
    const goal = node.type === 'agent' ? node.goal : '';
    if (goal === 'fail') {
      return { status: 'failed', errorClass: 'terminal', code: 'test_failed', message: 'failed' };
    }
    if (goal === 'wait') {
      return {
        status: 'waiting',
        wait: { kind: 'timer', until: new Date(clock.getTime() + 3_600_000).toISOString() },
      };
    }
    const score = goal.startsWith('score:') ? Number(goal.slice('score:'.length)) : null;
    return {
      status: 'succeeded',
      handles: ['next'],
      output: score === null ? null : { fields: { score } },
    };
  },
};

function runtime(): WorkflowRuntimeDependencies {
  const handlers: NodeHandlerRegistry = {
    ...DEFAULT_NODE_HANDLERS,
    agent: agentHandler,
    approval: createApprovalNodeHandler({ prisma, bus }),
  };
  return {
    prisma,
    queues: queues as unknown as WorkflowRuntimeDependencies['queues'],
    settings: async () => currentSettings(),
    logger,
    bus,
    handlers,
    now: () => clock,
  };
}

async function drain(): Promise<number> {
  let processed = 0;
  while (queue.length > 0 && processed < 200) {
    const job = queue.shift()!;
    await runWorkflowJob(runtime(), job, async () => undefined);
    processed += 1;
  }
  return processed;
}

function edge(id: string, from: string, handle: string, to: string) {
  return { id, kind: 'flow' as const, source: { nodeId: from, handle }, target: { nodeId: to } };
}

let counter = 0;
async function publishedWorkflow(graph: WorkflowGraphInput): Promise<string> {
  counter += 1;
  const parsed = workflowGraphSchema.parse(graph);
  const workflow = await prisma.workflow.create({
    data: {
      workspaceId,
      name: `Control ${String(counter)}`,
      draftGraph: parsed as Prisma.InputJsonObject,
      createdById: ownerId,
    },
  });
  const version = await prisma.workflowVersion.create({
    data: {
      workflowId: workflow.id,
      version: 1,
      graph: parsed as Prisma.InputJsonObject,
      graphHash: `control-${String(counter)}`,
      draftRevision: 1,
    },
  });
  await prisma.workflow.update({
    where: { id: workflow.id },
    data: { publishedVersionId: version.id },
  });
  return workflow.id;
}

async function start(workflowId: string, input?: Prisma.InputJsonObject): Promise<string> {
  const started = await startWorkflowRun(prisma, {
    workflowId,
    origin: 'manual',
    triggerNodeId: null,
    ...(input === undefined ? {} : { input }),
    startedById: ownerId,
    correlationId: 'test',
    chainDepth: 0,
    settings: currentSettings(),
    requireEnabled: false,
    now: clock,
  });
  if (!started.ok) throw new Error(started.reason);
  queue.push({ kind: 'advance', runId: started.runId, correlationId: 'test' });
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

async function approvalOf(runId: string, nodeId = 'ask') {
  const execution = await prisma.workflowNodeExecution.findFirstOrThrow({
    where: { runId, nodeId },
    orderBy: { attempt: 'desc' },
  });
  const item = await prisma.attentionItem.findUniqueOrThrow({
    where: { workflowExecutionId: execution.id },
  });
  return { execution, item };
}

/** A person answers in the inbox: what `AttentionService.resolve` writes for an item without work. */
async function answer(attentionItemId: string, optionId: string, note?: string): Promise<void> {
  await prisma.attentionItem.update({
    where: { id: attentionItemId },
    data: {
      status: 'RESOLVED',
      settledAt: clock,
      settledByKind: 'HUMAN',
      settledById: ownerId,
      resolution: { optionId, ...(note === undefined ? {} : { note }) },
    },
  });
}

function wake(runId: string, executionId: string, attentionItemId: string): WorkflowJob {
  return {
    kind: 'resume',
    runId,
    executionId,
    wake: { kind: 'attention_item', attentionItemId },
    correlationId: 'test',
  };
}

function statuses(run: Awaited<ReturnType<typeof readRun>>): Record<string, string> {
  return Object.fromEntries(run.nodeExecutions.map((row) => [row.nodeId, row.status]));
}

const approvalGraph: WorkflowGraphInput = {
  schemaVersion: 1,
  nodes: [
    { id: 'start', type: 'trigger.manual' },
    { id: 'ask', type: 'approval', title: 'Weiter?', question: 'Soll es weitergehen?' },
    {
      id: 'said',
      type: 'condition',
      source: { nodeId: 'ask', field: 'note' },
      operator: 'present',
    },
    { id: 'yes', type: 'end', outcome: 'succeeded', summary: 'Freigegeben' },
    { id: 'quiet', type: 'end', outcome: 'succeeded', summary: 'Ohne Worte freigegeben' },
    { id: 'no', type: 'end', outcome: 'failed', summary: 'Abgelehnt' },
  ],
  edges: [
    edge('e1', 'start', 'next', 'ask'),
    edge('e2', 'ask', 'approved', 'said'),
    edge('e3', 'said', 'true', 'yes'),
    edge('e4', 'said', 'false', 'quiet'),
    edge('e5', 'ask', 'rejected', 'no'),
  ],
};

beforeAll(async () => {
  prisma = createPrismaClient({ databaseUrl: process.env.DATABASE_URL });
  const suffix = Date.now().toString(36);
  ownerId = (
    await prisma.user.create({
      data: { email: `wf-ctl-${suffix}@exocortex.test`, name: 'Owner', emailVerified: true },
    })
  ).id;
  workspaceId = (
    await prisma.workspace.create({
      data: {
        name: `Workflow control ${suffix}`,
        slug: `workflow-control-${suffix}`,
        members: { create: { userId: ownerId, role: 'OWNER' } },
      },
    })
  ).id;
});

beforeEach(() => {
  queue = [];
  published.length = 0;
  clock = new Date('2026-10-11T10:00:00.000Z');
});

afterAll(async () => {
  await prisma.attentionItem.deleteMany({ where: { workspaceId } });
  await prisma.workflowRun.deleteMany({ where: { workspaceId } });
  await prisma.workflow.updateMany({ where: { workspaceId }, data: { publishedVersionId: null } });
  await prisma.workflow.deleteMany({ where: { workspaceId } });
  await prisma.workspace.deleteMany({ where: { id: workspaceId } });
  await prisma.user.deleteMany({ where: { id: ownerId } });
  await prisma.$disconnect();
});

describe('approval node', () => {
  it('asks once, waits for days without a job, and continues on the chosen branch', async () => {
    const runId = await start(await publishedWorkflow(approvalGraph));
    await drain();

    const { execution, item } = await approvalOf(runId);
    expect(item).toMatchObject({
      kind: 'APPROVAL',
      status: 'OPEN',
      title: 'Weiter?',
      reason: 'Soll es weitergehen?',
      system: true,
      raisedById: ownerId,
      options: [
        { id: 'approve', label: null },
        { id: 'reject', label: null },
      ],
    });
    expect(published).toContainEqual(
      expect.objectContaining({
        type: 'attention.changed',
        payload: { attentionItemIds: [item.id], action: 'raised' },
      }),
    );
    expect(execution).toMatchObject({
      status: 'WAITING',
      waitingOn: { kind: 'attention_item', attentionItemId: item.id },
    });
    expect((await readRun(runId)).status).toBe('WAITING');
    expect(queue).toEqual([]);

    // A redelivered execute of the same attempt asks nothing new.
    await prisma.workflowNodeExecution.update({
      where: { id: execution.id },
      data: { status: 'QUEUED', waitingOn: Prisma.DbNull },
    });
    queue.push({ kind: 'execute', runId, executionId: execution.id, correlationId: 'test' });
    await drain();
    expect(await prisma.attentionItem.count({ where: { workflowExecutionId: execution.id } })).toBe(
      1,
    );

    // Three days pass; the sweep leaves an open question alone.
    clock = new Date(clock.getTime() + 3 * 24 * 3_600_000);
    await sweepWorkflowRuns({ ...runtime(), triggers: runtime() as never, workspaceId });
    await drain();
    expect((await approvalOf(runId)).execution.status).toBe('WAITING');

    // A wake for an item that is still open changes nothing.
    queue.push(wake(runId, execution.id, item.id));
    await drain();
    expect((await approvalOf(runId)).execution.status).toBe('WAITING');

    await answer(item.id, 'approve', 'Passt so');
    queue.push(wake(runId, execution.id, item.id));
    await drain();

    const run = await readRun(runId);
    expect(run).toMatchObject({ status: 'SUCCEEDED', summary: 'Freigegeben', endNodeId: 'yes' });
    expect(statuses(run)).toMatchObject({ ask: 'SUCCEEDED', said: 'SUCCEEDED', yes: 'SUCCEEDED' });
    const asked = run.nodeExecutions.find((row) => row.nodeId === 'ask')!;
    expect(asked.firedHandles).toEqual(['approved']);
    expect(asked.output).toMatchObject({
      fields: { approved: true, note: 'Passt so' },
      attentionItemId: item.id,
      answeredById: ownerId,
    });
    expect(run.events.map((event) => event.type)).toContain('edge.taken');
    expect(
      run.events.some(
        (event) =>
          event.type === 'edge.taken' &&
          (event.detail as Record<string, unknown>).handle === 'approved',
      ),
    ).toBe(true);

    // The same answer delivered again resumes nothing.
    const eventCount = run.events.length;
    queue.push(wake(runId, execution.id, item.id));
    await drain();
    expect((await readRun(runId)).events).toHaveLength(eventCount);
  });

  it('takes the rejected branch, and ends the run with what the end node says', async () => {
    const runId = await start(await publishedWorkflow(approvalGraph));
    await drain();
    const { execution, item } = await approvalOf(runId);
    await answer(item.id, 'reject');
    queue.push(wake(runId, execution.id, item.id));
    await drain();
    const run = await readRun(runId);
    expect(run).toMatchObject({
      status: 'FAILED',
      errorCode: 'workflow_end_outcome',
      errorMessage: 'Abgelehnt',
      summary: 'Abgelehnt',
      endNodeId: 'no',
    });
    expect(statuses(run)).toMatchObject({ ask: 'SUCCEEDED', said: 'SKIPPED', no: 'SUCCEEDED' });
  });

  it('is found by the sweep when the wake after the answer is lost', async () => {
    const runId = await start(await publishedWorkflow(approvalGraph));
    await drain();
    const { item } = await approvalOf(runId);
    await answer(item.id, 'approve');
    // No resume job: the API died between the commit and the enqueue.
    await sweepWorkflowRuns({ ...runtime(), triggers: runtime() as never, workspaceId });
    await drain();
    expect(await readRun(runId)).toMatchObject({ status: 'SUCCEEDED', endNodeId: 'quiet' });
  });

  it('becomes obsolete when its run is cancelled', async () => {
    const runId = await start(await publishedWorkflow(approvalGraph));
    await drain();
    const { item } = await approvalOf(runId);
    const cancelled = await cancelWorkflowRun(prisma, {
      runId,
      reason: null,
      byUserId: ownerId,
      now: clock,
    });
    expect(cancelled).toEqual({ ok: true, obsoleteAttentionItemIds: [item.id] });
    const settled = await prisma.attentionItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(settled).toMatchObject({
      status: 'OBSOLETE',
      resolution: { reason: 'workflow_ended' },
    });
  });
});

describe('end node and joins', () => {
  it('ends the run at once and makes an approval on another branch obsolete', async () => {
    const runId = await start(
      await publishedWorkflow({
        schemaVersion: 1,
        nodes: [
          { id: 'start', type: 'trigger.manual' },
          { id: 'fan', type: 'parallel' },
          { id: 'ask', type: 'approval', title: 'Noch was?', question: 'Gibt es noch etwas?' },
          { id: 'work', type: 'agent', goal: 'score:3', outputFields: [] },
          { id: 'stop', type: 'end', outcome: 'cancelled', summary: 'Früh beendet' },
        ],
        edges: [
          edge('e1', 'start', 'next', 'fan'),
          edge('e2', 'fan', 'branch', 'ask'),
          edge('e3', 'fan', 'branch', 'work'),
          edge('e4', 'work', 'next', 'stop'),
        ],
      }),
    );
    await drain();
    const run = await readRun(runId);
    expect(run).toMatchObject({ status: 'CANCELLED', summary: 'Früh beendet', endNodeId: 'stop' });
    expect(statuses(run)).toMatchObject({ ask: 'CANCELLED', stop: 'SUCCEEDED' });
    const { item } = await approvalOf(runId);
    expect(item).toMatchObject({ status: 'OBSOLETE', resolution: { reason: 'workflow_ended' } });
    expect(published).toContainEqual(
      expect.objectContaining({ payload: { attentionItemIds: [item.id], action: 'settled' } }),
    );
  });

  it('continues a join for any input once and does not fail for the branch that failed', async () => {
    const runId = await start(
      await publishedWorkflow({
        schemaVersion: 1,
        nodes: [
          { id: 'start', type: 'trigger.manual' },
          { id: 'fan', type: 'parallel' },
          { id: 'broken', type: 'agent', goal: 'fail', outputFields: [] },
          { id: 'one', type: 'agent', goal: 'score:1', outputFields: [] },
          { id: 'two', type: 'agent', goal: 'score:2', outputFields: [] },
          { id: 'first', type: 'join', policy: 'any' },
          { id: 'after', type: 'agent', goal: 'score:9', outputFields: [] },
        ],
        edges: [
          edge('e1', 'start', 'next', 'fan'),
          edge('e2', 'fan', 'branch', 'broken'),
          edge('e3', 'fan', 'branch', 'one'),
          edge('e4', 'fan', 'branch', 'two'),
          edge('e5', 'broken', 'next', 'first'),
          edge('e6', 'one', 'next', 'first'),
          edge('e7', 'two', 'next', 'first'),
          edge('e8', 'first', 'next', 'after'),
        ],
      }),
    );
    await drain();
    const run = await readRun(runId);
    expect(run.status).toBe('SUCCEEDED');
    expect(run.nodeExecutions.filter((row) => row.nodeId === 'first')).toHaveLength(1);
    expect(run.nodeExecutions.filter((row) => row.nodeId === 'after')).toHaveLength(1);
    expect(statuses(run)).toMatchObject({ broken: 'FAILED', after: 'SUCCEEDED' });
  });

  it('still fails a run whose failed branch no join for any input absorbed', async () => {
    const runId = await start(
      await publishedWorkflow({
        schemaVersion: 1,
        nodes: [
          { id: 'start', type: 'trigger.manual' },
          { id: 'fan', type: 'parallel' },
          { id: 'broken', type: 'agent', goal: 'fail', outputFields: [] },
          { id: 'fine', type: 'agent', goal: 'score:1', outputFields: [] },
          { id: 'both', type: 'join', policy: 'all' },
        ],
        edges: [
          edge('e1', 'start', 'next', 'fan'),
          edge('e2', 'fan', 'branch', 'broken'),
          edge('e3', 'fan', 'branch', 'fine'),
          edge('e4', 'broken', 'next', 'both'),
          edge('e5', 'fine', 'next', 'both'),
        ],
      }),
    );
    await drain();
    expect(await readRun(runId)).toMatchObject({
      status: 'FAILED',
      errorCode: 'workflow_node_failed',
    });
  });

  it('branches on a key of the run input', async () => {
    const workflowId = await publishedWorkflow({
      schemaVersion: 1,
      nodes: [
        { id: 'start', type: 'trigger.manual' },
        {
          id: 'urgent',
          type: 'condition',
          source: { input: 'priority' },
          operator: 'gte',
          value: 3,
        },
        { id: 'fast', type: 'end', outcome: 'succeeded', summary: 'schnell' },
        { id: 'slow', type: 'end', outcome: 'succeeded', summary: 'langsam' },
      ],
      edges: [
        edge('e1', 'start', 'next', 'urgent'),
        edge('e2', 'urgent', 'true', 'fast'),
        edge('e3', 'urgent', 'false', 'slow'),
      ],
    });
    const high = await start(workflowId, { priority: 5 });
    const low = await start(workflowId, { priority: 1 });
    await drain();
    expect((await readRun(high)).summary).toBe('schnell');
    expect((await readRun(low)).summary).toBe('langsam');
    const condition = (await readRun(high)).nodeExecutions.find((row) => row.nodeId === 'urgent')!;
    expect(condition.output).toEqual({ result: true, value: 5 });
  });
});
