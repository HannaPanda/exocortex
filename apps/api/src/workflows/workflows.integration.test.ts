import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AuthorizationError, WorkspaceAccessService } from '@exocortex/auth';
import { loadDotEnv } from '@exocortex/config';
import {
  type Settings,
  settingsSchema,
  type WorkflowGraphInput,
  workflowGraphSchema,
} from '@exocortex/contracts';
import { createPrismaClient, type PrismaClient, startWorkflowRun } from '@exocortex/database';
import { createLogger } from '@exocortex/logger';
import { type QueueRegistry } from '@exocortex/queue';

import { AppError } from '../common/app-error';
import { runWithRequestContext } from '../common/correlation';
import { OutboxService } from '../common/outbox.service';
import { type SettingsService } from '../platform/settings.service';
import { type RealtimeService } from '../realtime/realtime.service';

import { WorkflowRunsService } from './workflow-runs.service';
import { WorkflowsService } from './workflows.service';

/**
 * Agent workflow definitions, versions and runs against the real database
 * (issue #160, ADR-075).
 *
 * What is proven: a graph is validated at the boundary and against the
 * workspace; publishing freezes it; editing or publishing again never changes
 * what an existing run reads; the version row refuses an update even from
 * SQL; and a run plus its node executions is plain persisted state that a
 * fresh service instance (a restarted process) reads back the same.
 *
 * Since issue #161: starting by hand freezes the limits and queues the first
 * step, the workspace switch refuses it, cancelling ends everything in
 * flight, and switching on or publishing rebuilds the trigger projection.
 */
loadDotEnv();

const correlationId = 'test-correlation';
const logger = createLogger({ name: 'api-test', level: 'silent' });

let prisma: PrismaClient;
let service: WorkflowsService;
let runs: WorkflowRunsService;
let workspaceId: string;
let otherWorkspaceId: string;
let ownerId: string;
let adminId: string;
let memberId: string;
let foreignProfileId: string;

let settingsOverride: Partial<Settings> = {};
const settingsStub = {
  getForWorkspace: async () => ({
    ...settingsSchema.parse({}),
    'workflows.enabled': true,
    ...settingsOverride,
  }),
} as unknown as SettingsService;
const enqueued: { queue: string; payload: unknown }[] = [];
const queueStub = {
  async enqueue(queue: string, payload: unknown): Promise<string> {
    enqueued.push({ queue, payload });
    return 'queued';
  },
} as unknown as QueueRegistry;

function runsService(client: PrismaClient): WorkflowRunsService {
  return new WorkflowRunsService(
    client,
    new WorkspaceAccessService(client),
    settingsStub,
    queueStub,
    new OutboxService(client, logger),
    { emit: async () => undefined } as unknown as RealtimeService,
  );
}

function edge(id: string, from: string, handle: string, to: string) {
  return { id, kind: 'flow' as const, source: { nodeId: from, handle }, target: { nodeId: to } };
}

function reviewGraph(goal = 'Review the open ideas'): WorkflowGraphInput {
  return {
    schemaVersion: 1,
    nodes: [
      { id: 'start', type: 'trigger.manual' },
      {
        id: 'review',
        type: 'agent',
        goal,
        outputFields: [{ name: 'score', type: 'number' }],
      },
      {
        id: 'decide',
        type: 'condition',
        source: { nodeId: 'review', field: 'score' },
        operator: 'gte',
        value: 5,
      },
      { id: 'done', type: 'end', outcome: 'succeeded' },
    ],
    edges: [
      edge('e1', 'start', 'next', 'review'),
      edge('e2', 'review', 'next', 'decide'),
      edge('e3', 'decide', 'true', 'done'),
    ],
  };
}

beforeAll(async () => {
  prisma = createPrismaClient({ databaseUrl: process.env.DATABASE_URL });
  const access = new WorkspaceAccessService(prisma);
  service = new WorkflowsService(prisma, access, new OutboxService(prisma, logger), settingsStub);
  runs = runsService(prisma);

  const suffix = Date.now().toString(36);
  const user = (label: string) =>
    prisma.user.create({
      data: { email: `wf-${label}-${suffix}@exocortex.test`, name: label, emailVerified: true },
    });
  ownerId = (await user('owner')).id;
  adminId = (await user('admin')).id;
  memberId = (await user('member')).id;

  workspaceId = (
    await prisma.workspace.create({
      data: {
        name: `Workflows ${suffix}`,
        slug: `workflows-${suffix}`,
        members: {
          create: [
            { userId: ownerId, role: 'OWNER' },
            { userId: adminId, role: 'ADMIN' },
            { userId: memberId, role: 'MEMBER' },
          ],
        },
      },
    })
  ).id;
  otherWorkspaceId = (
    await prisma.workspace.create({
      data: {
        name: `Workflows other ${suffix}`,
        slug: `workflows-other-${suffix}`,
        members: { create: { userId: ownerId, role: 'OWNER' } },
      },
    })
  ).id;
  foreignProfileId = (
    await prisma.agentProfile.create({
      data: { workspaceId: otherWorkspaceId, name: 'Fremd' },
    })
  ).id;
});

afterAll(async () => {
  await prisma.workflowRun.deleteMany({ where: { workspaceId } });
  await prisma.workflow.updateMany({ where: { workspaceId }, data: { publishedVersionId: null } });
  await prisma.workspace.deleteMany({ where: { id: { in: [workspaceId, otherWorkspaceId] } } });
  await prisma.user.deleteMany({ where: { id: { in: [ownerId, adminId, memberId] } } });
  await prisma.$disconnect();
});

async function createWorkflow(name: string, graph: WorkflowGraphInput = reviewGraph()) {
  return service.create({
    workspaceId,
    userId: adminId,
    request: { name, graph: workflowGraphSchema.parse(graph) },
    correlationId,
  });
}

describe('WorkflowsService', () => {
  it('creates a draft with one manual trigger when no graph is given', async () => {
    const created = await service.create({
      workspaceId,
      userId: adminId,
      request: { name: 'Leer' },
      correlationId,
    });
    expect(created.draft.nodes.map((node) => node.type)).toEqual(['trigger.manual']);
    expect(created.workflow).toMatchObject({
      enabled: false,
      draftRevision: 1,
      draftValid: true,
      publishedVersion: null,
      hasUnpublishedChanges: true,
    });
  });

  it('saves an incomplete draft but names what blocks publishing', async () => {
    const created = await createWorkflow('Halb', reviewGraph(''));
    expect(created.workflow.draftValid).toBe(false);
    expect(created.problems).toContainEqual(
      expect.objectContaining({ code: 'field_required', nodeId: 'review' }),
    );
    await expect(
      service.publish({
        workflowId: created.workflow.id,
        userId: adminId,
        request: {},
        correlationId,
      }),
    ).rejects.toMatchObject({ code: 'workflow_invalid' });
  });

  it('reports a profile of another workspace as a reference problem', async () => {
    const graph = reviewGraph();
    Object.assign(graph.nodes[1]!, { agentProfileId: foreignProfileId });
    const created = await createWorkflow('Fremdes Profil', graph);
    expect(created.problems).toEqual([
      expect.objectContaining({ code: 'reference_not_found', nodeId: 'review' }),
    ]);
  });

  it('refuses a duplicate name, a member, and a run of the built-in AI', async () => {
    await createWorkflow('Doppelt');
    await expect(createWorkflow('Doppelt')).rejects.toMatchObject({
      code: 'workflow_name_taken',
    });
    await expect(
      service.create({ workspaceId, userId: memberId, request: { name: 'X' }, correlationId }),
    ).rejects.toBeInstanceOf(AuthorizationError);
    await expect(
      runWithRequestContext({ correlationId, aiRunId: 'run-1' }, () =>
        service.create({ workspaceId, userId: adminId, request: { name: 'KI' }, correlationId }),
      ),
    ).rejects.toBeInstanceOf(AppError);
  });

  it('moves the revision only when the graph changes, and refuses a stale editor', async () => {
    const created = await createWorkflow('Revision');
    const workflowId = created.workflow.id;
    const renamed = await service.update({
      workflowId,
      userId: adminId,
      request: { name: 'Revision umbenannt', graph: created.draft },
      correlationId,
    });
    expect(renamed.workflow.draftRevision).toBe(1);
    const changed = await service.update({
      workflowId,
      userId: adminId,
      request: { graph: workflowGraphSchema.parse(reviewGraph('Anders')), expectedRevision: 1 },
      correlationId,
    });
    expect(changed.workflow.draftRevision).toBe(2);
    await expect(
      service.update({
        workflowId,
        userId: adminId,
        request: { graph: workflowGraphSchema.parse(reviewGraph('Veraltet')), expectedRevision: 1 },
        correlationId,
      }),
    ).rejects.toMatchObject({ code: 'workflow_revision_conflict' });
  });

  it('validates a sent graph without storing it, naming the broken element', async () => {
    const created = await createWorkflow('Prüfen');
    const result = await service.validate({
      workflowId: created.workflow.id,
      userId: memberId,
      graph: { ...reviewGraph(), edges: [edge('bad', 'start', 'nope', 'review')] },
    });
    expect(result.valid).toBe(false);
    expect(result.problems).toContainEqual(
      expect.objectContaining({ code: 'edge_invalid_handle', edgeId: 'bad' }),
    );
    const unchanged = await service.get({ workflowId: created.workflow.id, userId: memberId });
    expect(unchanged.draft.edges).toHaveLength(3);
  });
});

describe('publishing, versions and runs', () => {
  it('freezes the graph a run started on, whatever happens to the draft', async () => {
    const created = await createWorkflow('Unveränderlich');
    const workflowId = created.workflow.id;
    const first = await service.publish({
      workflowId,
      userId: adminId,
      request: { expectedRevision: 1 },
      correlationId,
    });
    expect(first.version.version).toBe(1);
    expect(first.workflow.hasUnpublishedChanges).toBe(false);

    // Publishing the same draft again publishes nothing new.
    const again = await service.publish({
      workflowId,
      userId: adminId,
      request: {},
      correlationId,
    });
    expect(again.version.id).toBe(first.version.id);

    const runId = (
      await runs.start({
        workflowId,
        userId: adminId,
        request: { triggerNodeId: 'start' },
        correlationId,
      })
    ).run.id;

    await service.update({
      workflowId,
      userId: adminId,
      request: { graph: workflowGraphSchema.parse(reviewGraph('Version zwei')) },
      correlationId,
    });
    const second = await service.publish({
      workflowId,
      userId: adminId,
      request: {},
      correlationId,
    });
    expect(second.version.version).toBe(2);

    const run = await runs.get({ runId, userId: memberId });
    expect(run.run.version).toBe(1);
    const review = run.graph.nodes.find((node) => node.id === 'review');
    expect(review).toMatchObject({ goal: 'Review the open ideas' });

    const versions = await service.listVersions({ workflowId, userId: memberId });
    expect(versions.versions.map((version) => version.version)).toEqual([2, 1]);
  });

  it('refuses any update of a published version, even from SQL', async () => {
    const created = await createWorkflow('Trigger');
    const published = await service.publish({
      workflowId: created.workflow.id,
      userId: adminId,
      request: {},
      correlationId,
    });
    await expect(
      prisma.workflowVersion.update({
        where: { id: published.version.id },
        data: { graph: { schemaVersion: 1, nodes: [], edges: [] } },
      }),
    ).rejects.toThrow(/immutable/);
  });

  it('keeps a run and its node executions as state a fresh process reads back', async () => {
    const created = await createWorkflow('Neustart');
    const workflowId = created.workflow.id;
    await service.publish({ workflowId, userId: adminId, request: {}, correlationId });
    enqueued.length = 0;
    const runId = (
      await runs.start({
        workflowId,
        userId: adminId,
        request: { input: { reason: 'test' } },
        correlationId,
      })
    ).run.id;
    expect(enqueued).toEqual([
      { queue: 'workflow', payload: { kind: 'advance', runId, correlationId } },
    ]);

    const started = await runs.get({ runId, userId: adminId });
    expect(started.run).toMatchObject({
      status: 'queued',
      origin: 'manual',
      nodeExecutionCount: 1,
      chainDepth: 0,
      limits: {
        maxNodeExecutions: 200,
        maxParallelBranches: 5,
        maxLifetimeSeconds: 7 * 24 * 3_600,
        budgetMicroUsd: 2_000_000,
      },
    });
    expect(started.events.map((event) => event.type)).toEqual([
      'run.started',
      'node.succeeded',
      'edge.taken',
    ]);
    expect(started.nodeExecutions).toEqual([
      expect.objectContaining({
        nodeId: 'start',
        status: 'succeeded',
        firedHandles: ['next'],
        idempotencyKey: `${runId}:start:1`,
      }),
    ]);
    expect(started.progress).toMatchObject({ runnable: ['review'], settled: false });

    // What a runtime would persist; then a new client and service, as after a restart.
    await prisma.workflowNodeExecution.create({
      data: {
        runId,
        nodeId: 'review',
        nodeType: 'agent',
        status: 'WAITING',
        idempotencyKey: `${runId}:review:1`,
        waitingOn: { kind: 'timer', until: '2026-12-24T18:00:00.000Z' },
      },
    });
    await expect(
      prisma.workflowNodeExecution.create({
        data: {
          runId,
          nodeId: 'review',
          nodeType: 'agent',
          idempotencyKey: `${runId}:review:1`,
        },
      }),
    ).rejects.toThrow();

    const fresh = createPrismaClient({ databaseUrl: process.env.DATABASE_URL });
    try {
      const reread = await runsService(fresh).get({
        runId,
        userId: adminId,
      });
      expect(reread.progress).toMatchObject({ runnable: [], active: ['review'], settled: false });
      expect(reread.nodeExecutions[1]?.waitingOn).toEqual({
        kind: 'timer',
        until: '2026-12-24T18:00:00.000Z',
      });
    } finally {
      await fresh.$disconnect();
    }

    await expect(
      service.delete({ workflowId, userId: adminId, correlationId }),
    ).rejects.toMatchObject({ code: 'workflow_has_active_runs' });
    await prisma.workflowRun.update({ where: { id: runId }, data: { status: 'CANCELLED' } });
    const deleted = await service.delete({ workflowId, userId: adminId, correlationId });
    expect(deleted).toEqual({ deleted: true, deletedRuns: 1 });
  });

  it('refuses a run from a trigger of the wrong kind and of an unpublished workflow', async () => {
    const created = await createWorkflow('Kein Lauf');
    await expect(
      runs.start({
        workflowId: created.workflow.id,
        userId: adminId,
        request: { triggerNodeId: 'start' },
        correlationId,
      }),
    ).rejects.toMatchObject({ code: 'workflow_not_published' });
    await service.publish({
      workflowId: created.workflow.id,
      userId: adminId,
      request: {},
      correlationId,
    });
    await expect(
      startWorkflowRun(prisma, {
        workflowId: created.workflow.id,
        origin: 'schedule',
        triggerNodeId: 'start',
        startedById: adminId,
        correlationId,
        chainDepth: 0,
        settings: settingsSchema.parse({}),
        requireEnabled: false,
      }),
    ).resolves.toEqual({ ok: false, reason: 'trigger_invalid' });
    await expect(
      runs.start({
        workflowId: created.workflow.id,
        userId: adminId,
        request: { triggerNodeId: 'review' },
        correlationId,
      }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    // A member may read runs but not start them.
    await expect(
      runs.start({ workflowId: created.workflow.id, userId: memberId, request: {}, correlationId }),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

  it('refuses a start while workflows are switched off, and from a run of the built-in AI', async () => {
    const created = await createWorkflow('Schalter aus');
    await service.publish({
      workflowId: created.workflow.id,
      userId: adminId,
      request: {},
      correlationId,
    });
    settingsOverride = { 'workflows.enabled': false };
    try {
      await expect(
        runs.start({
          workflowId: created.workflow.id,
          userId: adminId,
          request: {},
          correlationId,
        }),
      ).rejects.toMatchObject({ code: 'workflows_disabled' });
    } finally {
      settingsOverride = {};
    }
    await expect(
      runWithRequestContext({ correlationId, aiRunId: 'run-1' }, () =>
        runs.start({
          workflowId: created.workflow.id,
          userId: adminId,
          request: {},
          correlationId,
        }),
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('starts a test run that proposes unless told otherwise, and shows the envelope', async () => {
    const created = await createWorkflow('Probelauf');
    expect(created.envelope).toMatchObject({
      workflowsEnabled: true,
      writeMode: 'direct',
      limits: { budgetMicroUsd: expect.any(Number) },
    });
    await service.publish({
      workflowId: created.workflow.id,
      userId: adminId,
      request: {},
      correlationId,
    });
    const proposing = await runs.start({
      workflowId: created.workflow.id,
      userId: adminId,
      request: { test: true },
      correlationId,
    });
    expect(proposing.run).toMatchObject({ origin: 'test', writeMode: 'propose' });
    const reading = await runs.start({
      workflowId: created.workflow.id,
      userId: adminId,
      request: { test: true, writeMode: 'read_only' },
      correlationId,
    });
    expect(reading.run.writeMode).toBe('read_only');
    const manual = await runs.start({
      workflowId: created.workflow.id,
      userId: adminId,
      request: {},
      correlationId,
    });
    expect(manual.run).toMatchObject({ origin: 'manual', writeMode: null });
  });

  it('freezes the stricter limits and cancels everything in flight', async () => {
    const graph = workflowGraphSchema.parse({
      ...reviewGraph(),
      limits: { maxNodeExecutions: 7, maxParallelBranches: 9 },
    });
    const created = await createWorkflow('Abbrechen', graph);
    const workflowId = created.workflow.id;
    await service.publish({ workflowId, userId: adminId, request: {}, correlationId });
    settingsOverride = { 'workflows.maxParallelBranches': 3 };
    const started = await runs.start({ workflowId, userId: adminId, request: {}, correlationId });
    settingsOverride = {};
    expect(started.run.limits).toMatchObject({ maxNodeExecutions: 7, maxParallelBranches: 3 });

    const runId = started.run.id;
    await prisma.workflowNodeExecution.create({
      data: {
        runId,
        nodeId: 'review',
        nodeType: 'agent',
        status: 'RUNNING',
        idempotencyKey: `${runId}:review:1`,
        leaseToken: 'held-by-a-worker',
        leaseExpiresAt: new Date(Date.now() + 60_000),
      },
    });
    const cancelled = await runs.cancel({
      runId,
      userId: adminId,
      request: { reason: 'Falscher Tag' },
      correlationId,
    });
    expect(cancelled.run).toMatchObject({
      status: 'cancelled',
      errorCode: 'workflow_cancelled',
      errorMessage: 'Falscher Tag',
    });
    const review = cancelled.nodeExecutions.find((row) => row.nodeId === 'review');
    expect(review).toMatchObject({ status: 'cancelled', errorClass: 'cancelled' });
    const lease = await prisma.workflowNodeExecution.findFirstOrThrow({
      where: { runId, nodeId: 'review' },
      select: { leaseToken: true },
    });
    expect(lease.leaseToken).toBeNull();
    expect(cancelled.events.map((event) => event.type).slice(-2)).toEqual([
      'node.cancelled',
      'run.cancelled',
    ]);
    await expect(
      runs.cancel({ runId, userId: adminId, request: {}, correlationId }),
    ).rejects.toMatchObject({ code: 'workflow_run_finished' });
  });

  it('keeps the trigger projection in step with the switch and the published version', async () => {
    const scheduled = workflowGraphSchema.parse({
      schemaVersion: 1,
      nodes: [
        {
          id: 'daily',
          type: 'trigger.schedule',
          schedule: { kind: 'DAILY', time: '07:30', timeZone: 'Europe/Berlin' },
        },
        {
          id: 'changed',
          type: 'trigger.event',
          events: ['DOCUMENT_CREATED'],
          scopeDocumentId: null,
        },
        { id: 'fan', type: 'join', policy: 'any' },
        { id: 'done', type: 'end', outcome: 'succeeded' },
      ],
      edges: [
        edge('e1', 'daily', 'next', 'fan'),
        edge('e2', 'changed', 'next', 'fan'),
        edge('e3', 'fan', 'next', 'done'),
      ],
    });
    const created = await createWorkflow('Zeitplan', scheduled);
    const workflowId = created.workflow.id;
    await service.publish({ workflowId, userId: adminId, request: {}, correlationId });
    expect(await prisma.workflowTrigger.count({ where: { workflowId } })).toBe(0);

    await service.setActivation({
      workflowId,
      userId: ownerId,
      request: { enabled: true },
      correlationId,
    });
    const rows = await prisma.workflowTrigger.findMany({
      where: { workflowId },
      orderBy: { nodeId: 'asc' },
    });
    expect(rows.map((row) => [row.nodeId, row.nodeType])).toEqual([
      ['changed', 'trigger.event'],
      ['daily', 'trigger.schedule'],
    ]);
    expect(rows[0]?.events).toEqual(['DOCUMENT_CREATED']);
    expect(rows[1]?.nextRunAt?.getTime()).toBeGreaterThan(Date.now());
    const workflow = await prisma.workflow.findUniqueOrThrow({
      where: { id: workflowId },
      select: { enabledById: true },
    });
    expect(workflow.enabledById).toBe(ownerId);

    await service.setActivation({
      workflowId,
      userId: ownerId,
      request: { enabled: false },
      correlationId,
    });
    expect(await prisma.workflowTrigger.count({ where: { workflowId } })).toBe(0);
  });

  it('stamps a workflow node write on the outbox row, depth included', async () => {
    const outbox = new OutboxService(prisma, logger);
    const workflow = { workflowId: 'wf1', runId: 'run1', executionId: 'exec1', depth: 2 };
    await runWithRequestContext({ correlationId: 'wf-origin', workflow }, () =>
      prisma.$transaction((tx) =>
        outbox.writeEvent(tx, {
          workspaceId,
          type: 'document.updated',
          payload: { documentId: 'doc1' },
          correlationId: 'wf-origin',
        }),
      ),
    );
    const row = await prisma.outboxEvent.findFirstOrThrow({
      where: { workspaceId, correlationId: 'wf-origin' },
    });
    expect(row).toMatchObject({
      workflowId: 'wf1',
      workflowRunId: 'run1',
      workflowNodeExecutionId: 'exec1',
      automationRuleId: null,
      automationDepth: 2,
    });
    await prisma.outboxEvent.delete({ where: { id: row.id } });
  });

  it('lets only the owner switch a published workflow on', async () => {
    const created = await createWorkflow('Schalter');
    const workflowId = created.workflow.id;
    await expect(
      service.setActivation({
        workflowId,
        userId: ownerId,
        request: { enabled: true },
        correlationId,
      }),
    ).rejects.toMatchObject({ code: 'workflow_not_published' });
    await service.publish({ workflowId, userId: adminId, request: {}, correlationId });
    await expect(
      service.setActivation({
        workflowId,
        userId: adminId,
        request: { enabled: true },
        correlationId,
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);
    const enabled = await service.setActivation({
      workflowId,
      userId: ownerId,
      request: { enabled: true },
      correlationId,
    });
    expect(enabled.workflow.enabled).toBe(true);
    const audit = await prisma.auditLog.findMany({
      where: { targetType: 'workflow', targetId: workflowId },
      select: { action: true },
    });
    expect(audit.map((row) => row.action).toSorted()).toEqual([
      'workflow.created',
      'workflow.enabled',
      'workflow.published',
    ]);
  });
});
