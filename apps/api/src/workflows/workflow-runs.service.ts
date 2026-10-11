import { Inject, Injectable } from '@nestjs/common';

import { WorkspaceAccessService } from '@exocortex/auth';
import {
  isTriggerNode,
  type WorkflowNodeExecutionStatus,
  workflowProgress,
  type WorkflowRunListResponse,
  type WorkflowRunOrigin,
  type WorkflowRunResponse,
  type WorkflowTriggerType,
} from '@exocortex/contracts';
import { type Prisma, type PrismaClient } from '@exocortex/database';

import { AppError } from '../common/app-error';
import { PRISMA } from '../platform/platform.module';

import {
  nodeIdempotencyKey,
  RUN_SELECT,
  storedGraph,
  toNodeExecution,
  toWorkflowRun,
} from './workflow-mapper';

const RUN_LIST_LIMIT = 50;

/** Which trigger type a run of each origin starts from; a test may start from any. */
const ORIGIN_TRIGGER: Readonly<Record<WorkflowRunOrigin, WorkflowTriggerType | null>> = {
  manual: 'trigger.manual',
  schedule: 'trigger.schedule',
  event: 'trigger.event',
  test: null,
};

/**
 * Workflow runs (issue #160, ADR-075).
 *
 * A run names the version it started on and reads that graph, never the
 * draft. Its state is the run row and one row per node attempt; how far it
 * has come is derived from those rows by `workflowProgress`, which is what
 * lets any worker continue it after any restart (issue #161).
 *
 * This service owns the persistence: reading runs, and `start`, which writes
 * a run and its trigger's execution in one transaction. Executing nodes is
 * the runtime's, in the worker.
 */
@Injectable()
export class WorkflowRunsService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly access: WorkspaceAccessService,
  ) {}

  async list(input: { workflowId: string; userId: string }): Promise<WorkflowRunListResponse> {
    const workflow = await this.prisma.workflow.findUnique({
      where: { id: input.workflowId },
      select: { workspaceId: true },
    });
    if (workflow === null) throw AppError.notFound('Workflow');
    await this.access.requireRole(workflow.workspaceId, input.userId);
    const rows = await this.prisma.workflowRun.findMany({
      where: { workflowId: input.workflowId },
      orderBy: { createdAt: 'desc' },
      take: RUN_LIST_LIMIT,
      select: RUN_SELECT,
    });
    return { runs: rows.map(toWorkflowRun) };
  }

  async get(input: { runId: string; userId: string }): Promise<WorkflowRunResponse> {
    const row = await this.prisma.workflowRun.findUnique({
      where: { id: input.runId },
      select: {
        ...RUN_SELECT,
        workflowVersion: { select: { version: true, graph: true } },
        nodeExecutions: { orderBy: [{ queuedAt: 'asc' }, { attempt: 'asc' }] },
      },
    });
    if (row === null) throw AppError.notFound('Workflow run');
    const role = await this.access.findRole(row.workspaceId, input.userId);
    if (role === null) throw AppError.notFound('Workflow run');

    const graph = storedGraph(row.workflowVersion.graph);
    const executions = row.nodeExecutions.map(toNodeExecution);
    return {
      run: toWorkflowRun(row),
      graph,
      nodeExecutions: executions,
      progress: workflowProgress(graph, row.triggerNodeId, executions),
    };
  }

  /**
   * Starts a run of the published version: the run row and its trigger's
   * execution, succeeded, in one transaction, so the run is never visible
   * without the step that began it. Returns the run's id.
   *
   * Not a route yet: there is nothing to execute a run until the runtime
   * exists (issue #161), and a run nobody executes would sit queued for ever.
   */
  async start(input: {
    workflowId: string;
    origin: WorkflowRunOrigin;
    triggerNodeId: string;
    input?: Prisma.InputJsonValue;
    startedById: string | null;
    correlationId: string | null;
  }): Promise<string> {
    const workflow = await this.prisma.workflow.findUnique({
      where: { id: input.workflowId },
      select: {
        workspaceId: true,
        publishedVersion: { select: { id: true, graph: true } },
      },
    });
    if (workflow === null) throw AppError.notFound('Workflow');
    const version = workflow.publishedVersion;
    if (version === null) {
      throw new AppError('workflow_not_published', 'Only a published workflow can run');
    }
    const trigger = storedGraph(version.graph).nodes.find(
      (node) => node.id === input.triggerNodeId,
    );
    const expected = ORIGIN_TRIGGER[input.origin];
    if (
      trigger === undefined ||
      !isTriggerNode(trigger) ||
      (expected !== null && trigger.type !== expected)
    ) {
      throw AppError.validation(`Node ${input.triggerNodeId} is no ${input.origin} trigger`);
    }

    return this.prisma.$transaction(async (tx) => {
      const now = new Date();
      const run = await tx.workflowRun.create({
        data: {
          workflowId: input.workflowId,
          workspaceId: workflow.workspaceId,
          workflowVersionId: version.id,
          origin: input.origin.toUpperCase() as 'MANUAL' | 'SCHEDULE' | 'EVENT' | 'TEST',
          triggerNodeId: trigger.id,
          ...(input.input === undefined ? {} : { input: input.input }),
          startedById: input.startedById,
          correlationId: input.correlationId,
          nodeExecutionCount: 1,
        },
        select: { id: true },
      });
      await tx.workflowNodeExecution.create({
        data: {
          runId: run.id,
          nodeId: trigger.id,
          nodeType: trigger.type,
          attempt: 1,
          status: 'SUCCEEDED' satisfies Uppercase<WorkflowNodeExecutionStatus>,
          idempotencyKey: nodeIdempotencyKey(run.id, trigger.id, 1),
          firedHandles: ['next'],
          ...(input.input === undefined ? {} : { input: input.input }),
          queuedAt: now,
          startedAt: now,
          finishedAt: now,
        },
      });
      return run.id;
    });
  }
}
