import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { WorkspaceAccessService } from '@exocortex/auth';
import { loadDotEnv } from '@exocortex/config';
import {
  type WorkflowGraphInput,
  workflowGraphSchema,
  type WorkflowOrigin,
} from '@exocortex/contracts';
import { createPrismaClient, type Prisma, type PrismaClient } from '@exocortex/database';
import { createLogger } from '@exocortex/logger';
import { type QueueRegistry } from '@exocortex/queue';

import { AgentProfilesService } from '../agent-profiles/agent-profiles.service';
import { type ConversationsService } from '../ai/conversations.service';
import { type AttentionService } from '../attention/attention.service';
import { AppError } from '../common/app-error';
import { runWithRequestContext } from '../common/correlation';
import { OutboxService } from '../common/outbox.service';
import { type RealtimeService } from '../realtime/realtime.service';
import { type WorkItemActor } from '../work-items/work-item-actor';
import { WorkItemCheckpointsService } from '../work-items/work-item-checkpoints.service';
import { WorkItemsService } from '../work-items/work-items.service';

import { WorkflowWakeService } from './workflow-wake.service';

/**
 * A workflow's agent node, as the API sees it (issue #162, ADR-077).
 *
 * The worker creates the node's work item through the ordinary route with
 * the workflow origin on its service token. What is proven here is that the
 * origin widens nothing it was not meant to:
 *
 * - it binds the item to its attempt, so a second create answers with the
 *   same item, and the node's fields and write mode hold whatever was sent;
 * - it lets the item name exactly the profile the published version names,
 *   and no other, and only while the attempt is running, in its own
 *   workspace, for the person the run acts for;
 * - without the origin a service-token request still cannot choose a profile;
 * - the structured result is checked on every write and asked for in full
 *   when the work is handed in;
 * - a status change wakes the attempt waiting on the item, found by what it
 *   waits on, which still works after the item is deleted.
 */
loadDotEnv();

const correlationId = 'test-correlation';
const logger = createLogger({ name: 'api-test', level: 'silent' });

let prisma: PrismaClient;
let service: WorkItemsService;
let workspaceId: string;
let otherWorkspaceId: string;
let ownerId: string;
let otherUserId: string;
let namedProfileId: string;
let otherProfileId: string;
let workflowId: string;
let runId: string;

const realtime = { emit: async () => undefined } as unknown as RealtimeService;
const conversations = {} as unknown as ConversationsService;
const enqueued: unknown[] = [];
const queueStub = {
  async enqueue(_queue: string, payload: unknown): Promise<string> {
    enqueued.push(payload);
    return 'queued';
  },
} as unknown as QueueRegistry;

/** The worker's service token acts for the person; it is not a writing token. */
const actor = (userId = ownerId): WorkItemActor => ({ kind: 'human', userId, agentLabel: null });

function graph(): WorkflowGraphInput {
  return {
    schemaVersion: 1,
    nodes: [
      { id: 'start', type: 'trigger.manual' },
      {
        id: 'review',
        type: 'agent',
        goal: 'Bewerte die Ideen',
        agentProfileId: namedProfileId,
        writeMode: 'read_only',
        outputFields: [
          { name: 'score', type: 'number' },
          { name: 'verdict', type: 'enum', values: ['go', 'stop'], required: false },
        ],
      },
      { id: 'done', type: 'end', outcome: 'succeeded' },
    ],
    edges: [
      {
        id: 'e1',
        kind: 'flow',
        source: { nodeId: 'start', handle: 'next' },
        target: { nodeId: 'review' },
      },
      {
        id: 'e2',
        kind: 'flow',
        source: { nodeId: 'review', handle: 'next' },
        target: { nodeId: 'done' },
      },
    ],
  };
}

let attempts = 0;

/** An attempt of the agent node in the state a worker's claim leaves it. */
async function attempt(status: 'RUNNING' | 'SUCCEEDED' = 'RUNNING', nodeId = 'review') {
  attempts += 1;
  const execution = await prisma.workflowNodeExecution.create({
    data: {
      runId,
      nodeId,
      nodeType: nodeId === 'review' ? 'agent' : 'end',
      attempt: attempts,
      status,
      idempotencyKey: `${runId}:${nodeId}:${String(attempts)}`,
    },
  });
  return execution.id;
}

function origin(executionId: string, overrides: Partial<WorkflowOrigin> = {}): WorkflowOrigin {
  return { workflowId, runId, executionId, depth: 0, ...overrides };
}

async function createAs(
  workflow: WorkflowOrigin | undefined,
  request: Record<string, unknown>,
  input: { workspace?: string; userId?: string } = {},
) {
  return runWithRequestContext(
    { correlationId, ...(workflow === undefined ? {} : { workflow }) },
    () =>
      service.create({
        workspaceId: input.workspace ?? workspaceId,
        actor: actor(input.userId),
        request: { title: 'Workflow: Bewerten', goal: 'Bewerte die Ideen', ...request } as never,
        correlationId,
        mayChooseProfile: false,
      }),
  );
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(AppError);
  await promise.catch((error: unknown) => {
    expect((error as AppError).code).toBe(code);
  });
}

beforeAll(async () => {
  prisma = createPrismaClient({ databaseUrl: process.env.DATABASE_URL });
  const access = new WorkspaceAccessService(prisma);
  const profiles = new AgentProfilesService(prisma, access, new OutboxService(prisma, logger));
  const checkpoints = new WorkItemCheckpointsService(prisma, access, realtime);
  service = new WorkItemsService(prisma, access, realtime, conversations, checkpoints, profiles);

  const suffix = Date.now().toString(36);
  const user = (label: string) =>
    prisma.user.create({
      data: {
        email: `wf-agent-${label}-${suffix}@exocortex.test`,
        name: label,
        emailVerified: true,
      },
    });
  ownerId = (await user('owner')).id;
  otherUserId = (await user('other')).id;
  workspaceId = (
    await prisma.workspace.create({
      data: {
        name: `Workflow agent API ${suffix}`,
        slug: `workflow-agent-api-${suffix}`,
        members: {
          create: [
            { userId: ownerId, role: 'OWNER' },
            { userId: otherUserId, role: 'ADMIN' },
          ],
        },
      },
    })
  ).id;
  otherWorkspaceId = (
    await prisma.workspace.create({
      data: {
        name: `Workflow agent API other ${suffix}`,
        slug: `workflow-agent-api-other-${suffix}`,
        members: { create: { userId: ownerId, role: 'OWNER' } },
      },
    })
  ).id;
  namedProfileId = (
    await prisma.agentProfile.create({
      data: { workspaceId, name: 'Bewerter', writeMode: 'PROPOSE' },
    })
  ).id;
  otherProfileId = (
    await prisma.agentProfile.create({
      data: { workspaceId, name: 'Freier', writeMode: 'DIRECT' },
    })
  ).id;

  const parsed = workflowGraphSchema.parse(graph());
  const workflow = await prisma.workflow.create({
    data: {
      workspaceId,
      name: `Agent API ${suffix}`,
      draftGraph: parsed as Prisma.InputJsonObject,
      createdById: ownerId,
    },
  });
  workflowId = workflow.id;
  const version = await prisma.workflowVersion.create({
    data: {
      workflowId,
      version: 1,
      graph: parsed as Prisma.InputJsonObject,
      graphHash: `agent-api-${suffix}`,
      draftRevision: 1,
    },
  });
  await prisma.workflow.update({
    where: { id: workflowId },
    data: { publishedVersionId: version.id },
  });
  runId = (
    await prisma.workflowRun.create({
      data: {
        workflowId,
        workflowVersionId: version.id,
        workspaceId,
        status: 'RUNNING',
        origin: 'MANUAL',
        triggerNodeId: 'start',
        startedById: ownerId,
        limits: {
          maxNodeExecutions: 20,
          maxParallelBranches: 5,
          maxLifetimeSeconds: 3600,
          budgetMicroUsd: 1_000_000,
        },
      },
    })
  ).id;
});

afterAll(async () => {
  await prisma.workflowRun.deleteMany({ where: { workspaceId } });
  await prisma.workflow.updateMany({ where: { workspaceId }, data: { publishedVersionId: null } });
  await prisma.workflow.deleteMany({ where: { workspaceId } });
  await prisma.workItem.deleteMany({
    where: { workspaceId: { in: [workspaceId, otherWorkspaceId] } },
  });
  await prisma.agentProfile.deleteMany({ where: { workspaceId } });
  await prisma.workspace.deleteMany({ where: { id: { in: [workspaceId, otherWorkspaceId] } } });
  await prisma.user.deleteMany({ where: { id: { in: [ownerId, otherUserId] } } });
  await prisma.$disconnect();
});

describe('a workflow agent node creating its work item', () => {
  it('binds the item to its attempt, and the node holds its fields, mode and profile', async () => {
    const executionId = await attempt();
    const first = await createAs(origin(executionId), {
      agentProfileId: namedProfileId,
      writeMode: 'direct',
      resultFields: [{ name: 'other', type: 'string' }],
    });
    const item = first.workItem;
    expect(item.agentProfile?.id).toBe(namedProfileId);
    // The node says read_only; a request asking for direct cannot loosen it.
    expect(item.writeMode).toBe('read_only');
    expect(item.resultFields.map((field) => field.name)).toEqual(['score', 'verdict']);
    expect(item.workflow).toEqual({ workflowId, runId, nodeId: 'review' });

    const second = await createAs(origin(executionId), { agentProfileId: namedProfileId });
    expect(second.workItem.id).toBe(item.id);
    expect(await prisma.workItem.count({ where: { workflowExecutionId: executionId } })).toBe(1);
  });

  it('may name no other profile than the version names', async () => {
    await expectCode(
      createAs(origin(await attempt()), { agentProfileId: otherProfileId }),
      'forbidden',
    );
  });

  it('cannot choose a profile without a verified origin', async () => {
    // No origin at all: a service token is not a writing credential.
    await expectCode(createAs(undefined, { agentProfileId: namedProfileId }), 'forbidden');
    // An attempt that is not running any more.
    await expectCode(
      createAs(origin(await attempt('SUCCEEDED')), { agentProfileId: namedProfileId }),
      'forbidden',
    );
    // A header naming another run, another workflow or a node that is no agent.
    const executionId = await attempt();
    await expectCode(
      createAs(origin(executionId, { runId: 'someOtherRun1' }), { agentProfileId: namedProfileId }),
      'forbidden',
    );
    await expectCode(
      createAs(origin(executionId, { workflowId: 'someOtherFlow1' }), {
        agentProfileId: namedProfileId,
      }),
      'forbidden',
    );
    await expectCode(
      createAs(origin(await attempt('RUNNING', 'done')), { agentProfileId: namedProfileId }),
      'forbidden',
    );
    // Another person than the run acts for.
    await expectCode(
      createAs(
        origin(await attempt()),
        { agentProfileId: namedProfileId },
        { userId: otherUserId },
      ),
      'forbidden',
    );
    // An unverified origin binds nothing either.
    const unbound = await createAs(origin(await attempt('SUCCEEDED')), {});
    expect(unbound.workItem.workflow).toBeNull();
    expect(unbound.workItem.resultFields).toEqual([]);
  });

  it('cannot reach into another workspace', async () => {
    const executionId = await attempt();
    const elsewhere = await createAs(origin(executionId), {}, { workspace: otherWorkspaceId });
    expect(elsewhere.workItem.workflow).toBeNull();
    expect(elsewhere.workItem.workspaceId).toBe(otherWorkspaceId);
    expect(await prisma.workItem.count({ where: { workflowExecutionId: executionId } })).toBe(0);
  });
});

describe('the structured result', () => {
  async function itemWithFields() {
    const created = await createAs(origin(await attempt()), {});
    return created.workItem.id;
  }

  function update(workItemId: string, request: Record<string, unknown>) {
    return runWithRequestContext({ correlationId }, () =>
      service.update({ workItemId, actor: actor(), request: request as never, correlationId }),
    );
  }

  it('is checked on every write and asked for in full when the work is handed in', async () => {
    const id = await itemWithFields();
    await expectCode(
      update(id, { structuredResult: { score: 'acht' } }),
      'work_item_result_invalid',
    );
    await expectCode(
      update(id, { structuredResult: { score: 8, extra: 1 } }),
      'work_item_result_invalid',
    );
    await expectCode(
      update(id, { structuredResult: { verdict: 'maybe' } }),
      'work_item_result_invalid',
    );

    // Partial values may be written while the work goes on.
    await update(id, { structuredResult: { verdict: 'go' } });
    await expectCode(update(id, { status: 'review' }), 'work_item_result_invalid');
    await expectCode(update(id, { status: 'done' }), 'work_item_result_invalid');

    const handedIn = await update(id, {
      structuredResult: { score: 8, verdict: 'go' },
      status: 'review',
    });
    expect(handedIn.workItem.status).toBe('review');
    expect(handedIn.workItem.structuredResult).toEqual({ score: 8, verdict: 'go' });
    expect(handedIn.workItem.events.map((event) => event.kind)).toContain(
      'structured_result_recorded',
    );

    // Failing never needs the fields.
    const other = await itemWithFields();
    expect((await update(other, { status: 'failed' })).workItem.status).toBe('failed');
  });

  it('refuses any value on work that promises no fields', async () => {
    const plain = await createAs(undefined, {});
    await expectCode(
      update(plain.workItem.id, { structuredResult: { score: 1 } }),
      'work_item_result_invalid',
    );
  });
});

describe('waking the node', () => {
  it('queues a resume for the attempt waiting on the item, also after it was deleted', async () => {
    const executionId = await attempt();
    const created = await createAs(origin(executionId), {});
    const workItemId = created.workItem.id;
    await prisma.workflowNodeExecution.update({
      where: { id: executionId },
      data: { status: 'WAITING', waitingOn: { kind: 'work_item', workItemId }, workItemId },
    });
    const wake = new WorkflowWakeService(prisma, queueStub, service, {
      onWorkflowAnswer: () => undefined,
    } as unknown as AttentionService);
    wake.onModuleInit();

    enqueued.length = 0;
    await runWithRequestContext({ correlationId }, () =>
      service.update({
        workItemId,
        actor: actor(),
        request: { status: 'cancelled' },
        correlationId,
      }),
    );
    expect(enqueued).toContainEqual(
      expect.objectContaining({
        kind: 'resume',
        runId,
        executionId,
        wake: { kind: 'work_item', workItemId },
      }),
    );

    enqueued.length = 0;
    await runWithRequestContext({ correlationId }, () =>
      service.remove({ workItemId, userId: ownerId, actor: actor(), correlationId }),
    );
    expect(enqueued).toContainEqual(expect.objectContaining({ kind: 'resume', executionId }));
  });
});
