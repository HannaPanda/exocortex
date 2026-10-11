import { Inject, Injectable } from '@nestjs/common';

import { assertPolicy, canManageWorkflows, WorkspaceAccessService } from '@exocortex/auth';
import {
  type CancelWorkflowRunRequest,
  QUEUE_NAMES,
  type StartWorkflowRunRequest,
  workflowProgress,
  type WorkflowRunListResponse,
  type WorkflowRunResponse,
  type WorkflowRunStartResponse,
} from '@exocortex/contracts';
import {
  cancelWorkflowRun,
  type Prisma,
  type PrismaClient,
  startWorkflowRun,
  type StartWorkflowRunRefusal,
} from '@exocortex/database';
import { QueueRegistry } from '@exocortex/queue';

import { AppError } from '../common/app-error';
import { currentAiRunId, currentAutomation, currentWorkflowOrigin } from '../common/correlation';
import { OutboxService } from '../common/outbox.service';
import { PRISMA, QUEUES } from '../platform/platform-tokens';
import { SettingsService } from '../platform/settings.service';
import { RealtimeService } from '../realtime/realtime.service';

import {
  RUN_SELECT,
  storedGraph,
  toNodeExecution,
  toRunEvent,
  toWorkflowRun,
} from './workflow-mapper';

const RUN_LIST_LIMIT = 50;

/** How a refused start is told to the caller. */
function refusal(reason: StartWorkflowRunRefusal): AppError {
  switch (reason) {
    case 'not_found':
      return AppError.notFound('Workflow');
    case 'not_published':
    case 'version_moved':
      return new AppError('workflow_not_published', 'Only a published workflow can run');
    case 'not_enabled':
      return AppError.conflict('The workflow is switched off');
    case 'trigger_ambiguous':
      return new AppError(
        'workflow_trigger_ambiguous',
        'Name the trigger: the published version has none or several manual ones',
      );
    case 'trigger_invalid':
      return AppError.validation('That node is no manual trigger of the published version');
  }
}

/**
 * Workflow runs (issues #160 and #161, ADR-075, ADR-076).
 *
 * A run names the version it started on and reads that graph, never the
 * draft. Its state is the run row, one row per node attempt and its history;
 * how far it has come is derived from those rows by `workflowProgress`, which
 * is what lets any worker continue it after any restart.
 *
 * This service starts a run by hand and cancels one; executing it is the
 * worker's (`apps/worker/src/workflows`). Both are an admin's, like writing
 * the workflow, and never a run of the built-in AI's: a run starts agents and
 * spends money, and an agent starting more of them is issue #165's boundary.
 */
@Injectable()
export class WorkflowRunsService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly access: WorkspaceAccessService,
    private readonly settings: SettingsService,
    @Inject(QUEUES) private readonly queues: QueueRegistry,
    private readonly outbox: OutboxService,
    private readonly realtime: RealtimeService,
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
        events: { orderBy: { sequence: 'asc' } },
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
      events: row.events.flatMap((event) => {
        const mapped = toRunEvent(event);
        return mapped === null ? [] : [mapped];
      }),
      progress: workflowProgress(graph, row.triggerNodeId, executions),
    };
  }

  /**
   * Starts a run of the published version by hand. Needs `workflows.enabled`
   * but not the workflow's own switch, which is about starting by itself.
   * The run is written first and its first step queued after; a lost enqueue
   * is picked up by the worker's sweep.
   */
  async start(input: {
    workflowId: string;
    userId: string;
    request: StartWorkflowRunRequest;
    correlationId: string;
  }): Promise<WorkflowRunStartResponse> {
    const workflow = await this.prisma.workflow.findUnique({
      where: { id: input.workflowId },
      select: { workspaceId: true },
    });
    if (workflow === null) throw AppError.notFound('Workflow');
    await this.assertMay(workflow.workspaceId, input.userId);
    const settings = await this.settings.getForWorkspace(workflow.workspaceId);
    if (!settings['workflows.enabled']) {
      throw new AppError('workflows_disabled', 'Workflows are switched off for this workspace');
    }

    // A start from a service token that carries an origin continues that
    // chain rather than beginning a fresh one.
    const chainDepth = Math.max(
      currentAutomation()?.depth ?? 0,
      currentWorkflowOrigin()?.depth ?? 0,
    );
    // A test proposes unless the person starting it chose otherwise, and
    // whatever they chose only narrows what each agent node would do.
    const test = input.request.test === true;
    const writeMode = input.request.writeMode ?? (test ? 'propose' : null);
    const started = await startWorkflowRun(this.prisma, {
      workflowId: input.workflowId,
      origin: test ? 'test' : 'manual',
      triggerNodeId: input.request.triggerNodeId ?? null,
      ...(input.request.input === undefined
        ? {}
        : { input: input.request.input as Prisma.InputJsonObject }),
      startedById: input.userId,
      correlationId: input.correlationId,
      chainDepth,
      writeMode,
      settings,
      requireEnabled: false,
    });
    if (!started.ok) throw refusal(started.reason);

    await this.prisma.$transaction((tx) =>
      this.outbox.writeAudit(tx, {
        workspaceId: workflow.workspaceId,
        actorId: input.userId,
        action: 'workflow.run.started',
        targetType: 'workflow',
        targetId: input.workflowId,
        correlationId: input.correlationId,
        metadata: { runId: started.runId, test, writeMode },
      }),
    );
    await this.queues.enqueue(QUEUE_NAMES.workflow, {
      kind: 'advance',
      runId: started.runId,
      correlationId: input.correlationId,
    });
    const row = await this.prisma.workflowRun.findUniqueOrThrow({
      where: { id: started.runId },
      select: RUN_SELECT,
    });
    return { run: toWorkflowRun(row) };
  }

  /** Cancels a run that has not finished; answers with the run as it now is. */
  async cancel(input: {
    runId: string;
    userId: string;
    request: CancelWorkflowRunRequest;
    correlationId: string;
  }): Promise<WorkflowRunResponse> {
    const run = await this.prisma.workflowRun.findUnique({
      where: { id: input.runId },
      select: { workspaceId: true, workflowId: true },
    });
    if (run === null) throw AppError.notFound('Workflow run');
    const role = await this.access.findRole(run.workspaceId, input.userId);
    if (role === null) throw AppError.notFound('Workflow run');
    await this.assertMay(run.workspaceId, input.userId);

    const result = await cancelWorkflowRun(this.prisma, {
      runId: input.runId,
      reason: input.request.reason ?? null,
      byUserId: input.userId,
    });
    if (!result.ok) {
      if (result.reason === 'not_found') throw AppError.notFound('Workflow run');
      throw new AppError('workflow_run_finished', 'The run has already finished');
    }
    // An approval the run was waiting on is obsolete now (issue #163).
    if (result.obsoleteAttentionItemIds.length > 0) {
      await this.realtime.emit('attention.changed', run.workspaceId, input.correlationId, {
        attentionItemIds: result.obsoleteAttentionItemIds,
        action: 'settled',
      });
    }
    await this.prisma.$transaction((tx) =>
      this.outbox.writeAudit(tx, {
        workspaceId: run.workspaceId,
        actorId: input.userId,
        action: 'workflow.run.cancelled',
        targetType: 'workflow',
        targetId: run.workflowId,
        correlationId: input.correlationId,
        metadata: { runId: input.runId },
      }),
    );
    return this.get({ runId: input.runId, userId: input.userId });
  }

  private async assertMay(workspaceId: string, userId: string): Promise<void> {
    if (currentAiRunId() !== undefined) {
      throw AppError.forbidden('A run of the built-in AI cannot start or cancel workflow runs');
    }
    const role = await this.access.findRole(workspaceId, userId);
    if (role === null) throw AppError.notFound('Workflow');
    assertPolicy(canManageWorkflows(role));
  }
}
