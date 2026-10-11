import { Inject, Injectable } from '@nestjs/common';

import {
  assertPolicy,
  canActivateWorkflows,
  canManageWorkflows,
  type PolicyDecision,
  WorkspaceAccessService,
} from '@exocortex/auth';
import {
  type CreateWorkflowRequest,
  effectiveWorkflowLimits,
  type DeleteWorkflowResponse,
  emptyWorkflowGraph,
  type PublishWorkflowRequest,
  type PublishWorkflowResponse,
  type SetWorkflowActivationRequest,
  type UpdateWorkflowRequest,
  validateWorkflowGraph,
  type WorkflowGraph,
  workflowGraphSchema,
  type WorkflowListResponse,
  type WorkflowProblem,
  type WorkflowResponse,
  type WorkflowValidationResponse,
  type WorkflowVersionListResponse,
  type WorkflowVersionResponse,
  type WorkspaceRole,
} from '@exocortex/contracts';
import { Prisma, type PrismaClient, syncWorkflowTriggers } from '@exocortex/database';

import { AppError } from '../common/app-error';
import { currentAiRunId } from '../common/correlation';
import { OutboxService } from '../common/outbox.service';
import { PRISMA } from '../platform/platform.module';
import { SettingsService } from '../platform/settings.service';

import {
  ACTIVE_RUN_STATUSES,
  graphHash,
  storedGraph,
  toWorkflowSummary,
  toWorkflowVersion,
  VERSION_SELECT,
  WORKFLOW_SELECT,
  type WorkflowRow,
} from './workflow-mapper';
import { referenceProblems } from './workflow-references';

/**
 * Agent workflow definitions (issue #160, ADR-075).
 *
 * A workflow has one mutable draft and immutable published versions. Saving
 * a draft moves `draftRevision` only when the graph changes; publishing
 * validates the draft against the contract and the database and freezes it
 * as the next version; enabling is a separate decision of the owner.
 *
 * Reading is anybody's in the workspace. Writing is an admin's and never a
 * run of the built-in AI's: agent-authored drafts are issue #165, with their
 * own boundary.
 */
@Injectable()
export class WorkflowsService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly access: WorkspaceAccessService,
    private readonly outbox: OutboxService,
    private readonly settings: SettingsService,
  ) {}

  async list(input: { workspaceId: string; userId: string }): Promise<WorkflowListResponse> {
    await this.access.requireRole(input.workspaceId, input.userId);
    const rows = await this.prisma.workflow.findMany({
      where: { workspaceId: input.workspaceId },
      select: WORKFLOW_SELECT,
      orderBy: { name: 'asc' },
    });
    return { workflows: rows.map((row) => toWorkflowSummary(row)) };
  }

  async get(input: { workflowId: string; userId: string }): Promise<WorkflowResponse> {
    const row = await this.loadRow(input.workflowId);
    await this.access.requireRole(row.workspaceId, input.userId);
    return this.respond(row);
  }

  async create(input: {
    workspaceId: string;
    userId: string;
    request: CreateWorkflowRequest;
    correlationId: string;
  }): Promise<WorkflowResponse> {
    await this.assertMay(input.workspaceId, input.userId, canManageWorkflows);
    const graph = workflowGraphSchema.parse(input.request.graph ?? emptyWorkflowGraph());
    const id = await this.writeUnique(() =>
      this.prisma.$transaction(async (tx) => {
        const created = await tx.workflow.create({
          data: {
            workspaceId: input.workspaceId,
            name: input.request.name,
            description: emptyToNull(input.request.description ?? null),
            draftGraph: graph as Prisma.InputJsonObject,
            createdById: input.userId,
            updatedById: input.userId,
          },
          select: { id: true },
        });
        await this.outbox.writeAudit(tx, {
          workspaceId: input.workspaceId,
          actorId: input.userId,
          action: 'workflow.created',
          targetType: 'workflow',
          targetId: created.id,
          correlationId: input.correlationId,
          metadata: { name: input.request.name, draftRevision: 1 },
        });
        return created.id;
      }),
    );
    return this.get({ workflowId: id, userId: input.userId });
  }

  async update(input: {
    workflowId: string;
    userId: string;
    request: UpdateWorkflowRequest;
    correlationId: string;
  }): Promise<WorkflowResponse> {
    const existing = await this.loadRow(input.workflowId);
    await this.assertMay(existing.workspaceId, input.userId, canManageWorkflows);
    const { request } = input;
    const graph =
      request.graph === undefined ? undefined : workflowGraphSchema.parse(request.graph);
    const graphChanged =
      graph !== undefined && graphHash(graph) !== graphHash(storedGraph(existing.draftGraph));

    await this.writeUnique(() =>
      this.prisma.$transaction(async (tx) => {
        const updated = await tx.workflow.updateMany({
          where: {
            id: existing.id,
            ...(request.expectedRevision === undefined
              ? {}
              : { draftRevision: request.expectedRevision }),
          },
          data: {
            ...(request.name === undefined ? {} : { name: request.name }),
            ...(request.description === undefined
              ? {}
              : { description: emptyToNull(request.description) }),
            ...(graphChanged
              ? { draftGraph: graph as Prisma.InputJsonObject, draftRevision: { increment: 1 } }
              : {}),
            updatedById: input.userId,
          },
        });
        if (updated.count === 0) throw revisionConflict();
        await this.outbox.writeAudit(tx, {
          workspaceId: existing.workspaceId,
          actorId: input.userId,
          action: 'workflow.updated',
          targetType: 'workflow',
          targetId: existing.id,
          correlationId: input.correlationId,
          metadata: {
            fields: Object.keys(request)
              .filter((key) => key !== 'expectedRevision')
              .join(','),
            draftRevision: existing.draftRevision + (graphChanged ? 1 : 0),
          },
        });
      }),
    );
    return this.get({ workflowId: existing.id, userId: input.userId });
  }

  /**
   * Checks a graph without storing anything: the one sent, or the stored
   * draft when none is. Anybody who may read the workflow may ask.
   */
  async validate(input: {
    workflowId: string;
    userId: string;
    graph: unknown;
  }): Promise<WorkflowValidationResponse> {
    const row = await this.loadRow(input.workflowId);
    await this.access.requireRole(row.workspaceId, input.userId);
    const problems = await this.problemsOf(
      row.workspaceId,
      input.graph === undefined ? row.draftGraph : input.graph,
    );
    return { valid: problems.length === 0, problems };
  }

  /**
   * Freezes the draft as the next version. Publishing a draft identical to
   * the newest version publishes nothing and answers with that version, so
   * a repeated request cannot fill the history with copies.
   */
  async publish(input: {
    workflowId: string;
    userId: string;
    request: PublishWorkflowRequest;
    correlationId: string;
  }): Promise<PublishWorkflowResponse> {
    const existing = await this.loadRow(input.workflowId);
    await this.assertMay(existing.workspaceId, input.userId, canManageWorkflows);
    if (
      input.request.expectedRevision !== undefined &&
      input.request.expectedRevision !== existing.draftRevision
    ) {
      throw revisionConflict();
    }
    const problems = await this.problemsOf(existing.workspaceId, existing.draftGraph);
    if (problems.length > 0) {
      throw new AppError('workflow_invalid', 'The draft cannot be published as it is', {
        problems,
      });
    }
    const graph = storedGraph(existing.draftGraph);
    const hash = graphHash(graph);

    const versionId = await this.writeUnique(() =>
      this.prisma.$transaction(async (tx) => {
        const newest = await tx.workflowVersion.findFirst({
          where: { workflowId: existing.id },
          orderBy: { version: 'desc' },
          select: { id: true, version: true, graphHash: true },
        });
        if (newest?.graphHash === hash) return newest.id;
        // Only the revision that was checked above may become the version.
        const claimed = await tx.workflow.updateMany({
          where: { id: existing.id, draftRevision: existing.draftRevision },
          data: { updatedById: input.userId },
        });
        if (claimed.count === 0) throw revisionConflict();
        const version = await tx.workflowVersion.create({
          data: {
            workflowId: existing.id,
            version: (newest?.version ?? 0) + 1,
            graph: graph as Prisma.InputJsonObject,
            graphHash: hash,
            draftRevision: existing.draftRevision,
            publishedById: input.userId,
          },
          select: { id: true, version: true },
        });
        await tx.workflow.update({
          where: { id: existing.id },
          data: { publishedVersionId: version.id },
        });
        // A switched-on workflow starts from the new version's triggers now.
        await syncWorkflowTriggers(tx, existing.id);
        await this.outbox.writeAudit(tx, {
          workspaceId: existing.workspaceId,
          actorId: input.userId,
          action: 'workflow.published',
          targetType: 'workflow',
          targetId: existing.id,
          correlationId: input.correlationId,
          metadata: {
            version: version.version,
            draftRevision: existing.draftRevision,
            graphHash: hash,
          },
        });
        return version.id;
      }),
    );
    const [workflow, version] = await Promise.all([
      this.loadRow(existing.id),
      this.prisma.workflowVersion.findUniqueOrThrow({
        where: { id: versionId },
        select: VERSION_SELECT,
      }),
    ]);
    return { workflow: toWorkflowSummary(workflow), version: toWorkflowVersion(version) };
  }

  async setActivation(input: {
    workflowId: string;
    userId: string;
    request: SetWorkflowActivationRequest;
    correlationId: string;
  }): Promise<WorkflowResponse> {
    const existing = await this.loadRow(input.workflowId);
    await this.assertMay(existing.workspaceId, input.userId, canActivateWorkflows);
    if (input.request.enabled && existing.publishedVersion === null) {
      throw new AppError('workflow_not_published', 'Only a published workflow can be enabled');
    }
    if (existing.enabled !== input.request.enabled) {
      await this.prisma.$transaction(async (tx) => {
        await tx.workflow.update({
          where: { id: existing.id },
          data: {
            enabled: input.request.enabled,
            // Who switched it on is who its self-started runs act as (issue #161).
            enabledById: input.request.enabled ? input.userId : null,
            updatedById: input.userId,
          },
        });
        await syncWorkflowTriggers(tx, existing.id);
        await this.outbox.writeAudit(tx, {
          workspaceId: existing.workspaceId,
          actorId: input.userId,
          action: input.request.enabled ? 'workflow.enabled' : 'workflow.disabled',
          targetType: 'workflow',
          targetId: existing.id,
          correlationId: input.correlationId,
          metadata: { version: existing.publishedVersion?.version ?? null },
        });
      });
    }
    return this.get({ workflowId: existing.id, userId: input.userId });
  }

  async delete(input: {
    workflowId: string;
    userId: string;
    correlationId: string;
  }): Promise<DeleteWorkflowResponse> {
    const existing = await this.loadRow(input.workflowId);
    await this.assertMay(existing.workspaceId, input.userId, canManageWorkflows);
    if (existing._count.runs > 0) {
      throw new AppError('workflow_has_active_runs', 'A run of this workflow has not finished');
    }
    const deletedRuns = await this.prisma.$transaction(async (tx) => {
      const runs = await tx.workflowRun.deleteMany({
        where: { workflowId: existing.id, status: { notIn: [...ACTIVE_RUN_STATUSES] } },
      });
      const active = await tx.workflowRun.count({ where: { workflowId: existing.id } });
      if (active > 0) {
        throw new AppError('workflow_has_active_runs', 'A run of this workflow has started');
      }
      await tx.workflow.update({ where: { id: existing.id }, data: { publishedVersionId: null } });
      await tx.workflow.delete({ where: { id: existing.id } });
      await this.outbox.writeAudit(tx, {
        workspaceId: existing.workspaceId,
        actorId: input.userId,
        action: 'workflow.deleted',
        targetType: 'workflow',
        targetId: existing.id,
        correlationId: input.correlationId,
        metadata: { name: existing.name, deletedRuns: runs.count },
      });
      return runs.count;
    });
    return { deleted: true, deletedRuns };
  }

  async listVersions(input: {
    workflowId: string;
    userId: string;
  }): Promise<WorkflowVersionListResponse> {
    const row = await this.loadRow(input.workflowId);
    await this.access.requireRole(row.workspaceId, input.userId);
    const versions = await this.prisma.workflowVersion.findMany({
      where: { workflowId: row.id },
      orderBy: { version: 'desc' },
      select: VERSION_SELECT,
    });
    return {
      versions: versions.map((version) => {
        const { graph: _graph, ...rest } = toWorkflowVersion(version);
        return rest;
      }),
    };
  }

  async getVersion(input: { versionId: string; userId: string }): Promise<WorkflowVersionResponse> {
    const version = await this.prisma.workflowVersion.findUnique({
      where: { id: input.versionId },
      select: { ...VERSION_SELECT, workflow: { select: { workspaceId: true } } },
    });
    if (version === null) throw AppError.notFound('Workflow version');
    const role = await this.access.findRole(version.workflow.workspaceId, input.userId);
    if (role === null) throw AppError.notFound('Workflow version');
    return { version: toWorkflowVersion(version) };
  }

  /** The contract's problems and the database's, in one list. */
  private async problemsOf(workspaceId: string, raw: unknown): Promise<WorkflowProblem[]> {
    const { graph, problems } = validateWorkflowGraph(raw);
    if (graph === null) return problems;
    return [...problems, ...(await referenceProblems(this.prisma, workspaceId, graph))];
  }

  private async respond(row: WorkflowRow): Promise<WorkflowResponse> {
    const draft: WorkflowGraph = storedGraph(row.draftGraph);
    const [problems, settings] = await Promise.all([
      this.problemsOf(row.workspaceId, draft),
      this.settings.getForWorkspace(row.workspaceId),
    ]);
    return {
      workflow: toWorkflowSummary(row, problems.length === 0),
      draft,
      problems,
      envelope: {
        workflowsEnabled: settings['workflows.enabled'],
        writeMode: settings['ai.writeMode'],
        limits: effectiveWorkflowLimits(draft.limits, settings),
      },
    };
  }

  private async assertMay(
    workspaceId: string,
    userId: string,
    policy: (role: WorkspaceRole | null) => PolicyDecision,
  ): Promise<void> {
    if (currentAiRunId() !== undefined) {
      throw AppError.forbidden('A run of the built-in AI cannot change workflows');
    }
    const role = await this.access.findRole(workspaceId, userId);
    if (role === null) throw AppError.notFound('Workflow');
    assertPolicy(policy(role));
  }

  private async loadRow(workflowId: string): Promise<WorkflowRow> {
    const row = await this.prisma.workflow.findUnique({
      where: { id: workflowId },
      select: WORKFLOW_SELECT,
    });
    if (row === null) throw AppError.notFound('Workflow');
    return row;
  }

  /** Runs a write, turning a clash on the unique name into its own code. */
  private async writeUnique<T>(write: () => Promise<T>): Promise<T> {
    try {
      return await write();
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const target = JSON.stringify(error.meta ?? {});
        if (target.includes('version')) throw revisionConflict();
        throw new AppError(
          'workflow_name_taken',
          'Another workflow in this workspace has that name',
        );
      }
      throw error;
    }
  }
}

function revisionConflict(): AppError {
  return new AppError(
    'workflow_revision_conflict',
    'The draft moved on since the revision this request names',
  );
}

function emptyToNull(value: string | null): string | null {
  return value === null || value.trim().length === 0 ? null : value;
}
