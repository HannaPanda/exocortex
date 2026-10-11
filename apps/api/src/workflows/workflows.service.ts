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
  type DeleteWorkflowResponse,
  type DuplicateWorkflowRequest,
  effectiveWorkflowLimits,
  emptyWorkflowGraph,
  type PublishWorkflowRequest,
  type PublishWorkflowResponse,
  type SetWorkflowActivationRequest,
  type UpdateWorkflowRequest,
  validateWorkflowGraph,
  WORKFLOW_LIMITS,
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
import { type WorkItemActor } from '../work-items/work-item-actor';
import { PARTICIPANT_TO_PRISMA } from '../work-items/work-item-mapper';

import { authorEnvelopeProblems } from './workflow-author-envelope';
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
 * Reading is anybody's in the workspace. Writing a draft is an admin's,
 * whether at the keyboard, through an agent or through a run of the
 * built-in AI (issue #165, ADR-080); a run may not put an agent under a
 * looser profile into it than its own. Publishing and switching on are a
 * person's only: how the request arrived decides that, not the account.
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
    actor: WorkItemActor;
    request: CreateWorkflowRequest;
    correlationId: string;
  }): Promise<WorkflowResponse> {
    await this.assertMay(input.workspaceId, input.actor, canManageWorkflows, 'draft');
    const graph = workflowGraphSchema.parse(input.request.graph ?? emptyWorkflowGraph());
    await this.assertWithinAuthor(input.workspaceId, input.actor, graph);
    return this.insert({
      workspaceId: input.workspaceId,
      actor: input.actor,
      name: input.request.name,
      description: emptyToNull(input.request.description ?? null),
      graph,
      correlationId: input.correlationId,
      audit: {},
    });
  }

  /**
   * Copies a workflow's draft into a new one (issue #165): a starting point
   * for a variant, which an agent may then revise. Nothing else travels --
   * no version, no run, not the switch.
   */
  async duplicate(input: {
    workflowId: string;
    actor: WorkItemActor;
    request: DuplicateWorkflowRequest;
    correlationId: string;
  }): Promise<WorkflowResponse> {
    const source = await this.loadRow(input.workflowId);
    await this.assertMay(source.workspaceId, input.actor, canManageWorkflows, 'draft');
    const graph = storedGraph(source.draftGraph);
    await this.assertWithinAuthor(source.workspaceId, input.actor, graph);
    const name = input.request.name ?? (await this.copyName(source.workspaceId, source.name));
    return this.insert({
      workspaceId: source.workspaceId,
      actor: input.actor,
      name,
      description: source.description,
      graph,
      correlationId: input.correlationId,
      audit: { duplicatedFrom: source.id },
    });
  }

  private async insert(input: {
    workspaceId: string;
    actor: WorkItemActor;
    name: string;
    description: string | null;
    graph: WorkflowGraph;
    correlationId: string;
    audit: Record<string, string>;
  }): Promise<WorkflowResponse> {
    const userId = input.actor.userId;
    const id = await this.writeUnique(() =>
      this.prisma.$transaction(async (tx) => {
        const created = await tx.workflow.create({
          data: {
            workspaceId: input.workspaceId,
            name: input.name,
            description: input.description,
            draftGraph: input.graph as Prisma.InputJsonObject,
            createdById: userId,
            updatedById: userId,
            ...authorColumns(input.actor),
          },
          select: { id: true },
        });
        await this.outbox.writeAudit(tx, {
          workspaceId: input.workspaceId,
          actorId: userId,
          action: 'workflow.created',
          targetType: 'workflow',
          targetId: created.id,
          correlationId: input.correlationId,
          metadata: {
            name: input.name,
            draftRevision: 1,
            ...authorMetadata(input.actor),
            ...input.audit,
          },
        });
        return created.id;
      }),
    );
    return this.get({ workflowId: id, userId });
  }

  /** "<name> (Kopie)", then "(Kopie 2)" and on, whichever is free. */
  private async copyName(workspaceId: string, name: string): Promise<string> {
    const taken = new Set(
      (
        await this.prisma.workflow.findMany({
          where: { workspaceId, name: { startsWith: name } },
          select: { name: true },
        })
      ).map((row) => row.name),
    );
    for (let n = 1; ; n += 1) {
      const candidate = `${name} (Kopie${n === 1 ? '' : ` ${n}`})`.slice(
        0,
        WORKFLOW_LIMITS.nameMaxChars,
      );
      if (!taken.has(candidate)) return candidate;
    }
  }

  async update(input: {
    workflowId: string;
    actor: WorkItemActor;
    request: UpdateWorkflowRequest;
    correlationId: string;
  }): Promise<WorkflowResponse> {
    const existing = await this.loadRow(input.workflowId);
    const userId = input.actor.userId;
    await this.assertMay(existing.workspaceId, input.actor, canManageWorkflows, 'draft');
    const { request } = input;
    const graph =
      request.graph === undefined ? undefined : workflowGraphSchema.parse(request.graph);
    const graphChanged =
      graph !== undefined && graphHash(graph) !== graphHash(storedGraph(existing.draftGraph));
    if (graphChanged) await this.assertWithinAuthor(existing.workspaceId, input.actor, graph);

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
              ? {
                  draftGraph: graph as Prisma.InputJsonObject,
                  draftRevision: { increment: 1 },
                  ...authorColumns(input.actor),
                }
              : {}),
            updatedById: userId,
          },
        });
        if (updated.count === 0) throw revisionConflict();
        await this.outbox.writeAudit(tx, {
          workspaceId: existing.workspaceId,
          actorId: userId,
          action: 'workflow.updated',
          targetType: 'workflow',
          targetId: existing.id,
          correlationId: input.correlationId,
          metadata: {
            fields: Object.keys(request)
              .filter((key) => key !== 'expectedRevision')
              .join(','),
            draftRevision: existing.draftRevision + (graphChanged ? 1 : 0),
            ...authorMetadata(input.actor),
          },
        });
      }),
    );
    return this.get({ workflowId: existing.id, userId });
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
   *
   * A person's only, and only the revision they name (issue #165): an agent
   * may be revising the draft while somebody reviews it, and what becomes a
   * version is exactly what was reviewed, with a record of who wrote it.
   */
  async publish(input: {
    workflowId: string;
    actor: WorkItemActor;
    /** The request carried a browser session cookie, not a token of any kind. */
    viaBrowser: boolean;
    request: PublishWorkflowRequest;
    correlationId: string;
  }): Promise<PublishWorkflowResponse> {
    const existing = await this.loadRow(input.workflowId);
    const userId = input.actor.userId;
    await this.assertPerson(input.actor, input.viaBrowser);
    await this.assertMay(existing.workspaceId, input.actor, canManageWorkflows, 'admin');
    if (input.request.expectedRevision !== existing.draftRevision) throw revisionConflict();
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
          data: { updatedById: userId },
        });
        if (claimed.count === 0) throw revisionConflict();
        const version = await tx.workflowVersion.create({
          data: {
            workflowId: existing.id,
            version: (newest?.version ?? 0) + 1,
            graph: graph as Prisma.InputJsonObject,
            graphHash: hash,
            draftRevision: existing.draftRevision,
            publishedById: userId,
            draftAuthorKind: existing.draftAuthorKind,
            draftAuthorId: existing.draftAuthor?.id ?? null,
            draftAgentLabel: existing.draftAgentLabel,
            draftAiRunId: existing.draftAiRunId,
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
          actorId: userId,
          action: 'workflow.published',
          targetType: 'workflow',
          targetId: existing.id,
          correlationId: input.correlationId,
          metadata: {
            version: version.version,
            draftRevision: existing.draftRevision,
            graphHash: hash,
            draftAuthorKind: existing.draftAuthorKind.toLowerCase(),
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
    actor: WorkItemActor;
    viaBrowser: boolean;
    request: SetWorkflowActivationRequest;
    correlationId: string;
  }): Promise<WorkflowResponse> {
    const existing = await this.loadRow(input.workflowId);
    const userId = input.actor.userId;
    await this.assertPerson(input.actor, input.viaBrowser);
    await this.assertMay(existing.workspaceId, input.actor, canActivateWorkflows, 'admin');
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
            enabledById: input.request.enabled ? userId : null,
            updatedById: userId,
          },
        });
        await syncWorkflowTriggers(tx, existing.id);
        await this.outbox.writeAudit(tx, {
          workspaceId: existing.workspaceId,
          actorId: userId,
          action: input.request.enabled ? 'workflow.enabled' : 'workflow.disabled',
          targetType: 'workflow',
          targetId: existing.id,
          correlationId: input.correlationId,
          metadata: { version: existing.publishedVersion?.version ?? null },
        });
      });
    }
    return this.get({ workflowId: existing.id, userId });
  }

  async delete(input: {
    workflowId: string;
    actor: WorkItemActor;
    correlationId: string;
  }): Promise<DeleteWorkflowResponse> {
    const existing = await this.loadRow(input.workflowId);
    await this.assertMay(existing.workspaceId, input.actor, canManageWorkflows, 'admin');
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
        actorId: input.actor.userId,
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

  /**
   * Who may make a change, by kind of change: `draft` is any admin however
   * the request arrived; `admin` is any admin but no run of the built-in AI.
   */
  private async assertMay(
    workspaceId: string,
    actor: WorkItemActor,
    policy: (role: WorkspaceRole | null) => PolicyDecision,
    who: 'draft' | 'admin',
  ): Promise<void> {
    if (who === 'admin' && actor.kind === 'assistant') {
      throw AppError.forbidden('A run of the built-in AI cannot change this');
    }
    const role = await this.access.findRole(workspaceId, actor.userId);
    if (role === null) throw AppError.notFound('Workflow');
    assertPolicy(policy(role));
  }

  /**
   * Publishing and switching on are a person's at the browser (issue #165,
   * ADR-080). The browser's session cookie is what says so, not the
   * absence of an agent-session header: an agent could leave the header out,
   * but it cannot hold the cookie. So every token is refused, a person's own
   * admin token included, and so is a cookie request that names an agent.
   */
  private async assertPerson(actor: WorkItemActor, viaBrowser: boolean): Promise<void> {
    if (viaBrowser && actor.kind === 'human') return;
    throw new AppError(
      'workflow_human_only',
      'Publishing a workflow or switching it on is decided by a person in the browser',
    );
  }

  /**
   * A run of the built-in AI writes no agent into a draft that would work
   * under a looser profile than its own (issue #165, ADR-080). Refused with
   * the problems, so the run can repair the graph and try again.
   */
  private async assertWithinAuthor(
    workspaceId: string,
    actor: WorkItemActor,
    graph: WorkflowGraph,
  ): Promise<void> {
    const aiRunId = actor.kind === 'assistant' ? (actor.runId ?? currentAiRunId()) : undefined;
    if (aiRunId === undefined) return;
    const problems = await authorEnvelopeProblems(this.prisma, { aiRunId, workspaceId, graph });
    if (problems.length > 0) {
      throw new AppError(
        'workflow_exceeds_author',
        'The draft gives an agent more room than the run writing it has',
        { problems },
      );
    }
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

/** The draft's provenance columns for a graph this actor just wrote. */
function authorColumns(actor: WorkItemActor) {
  return {
    draftAuthorKind: PARTICIPANT_TO_PRISMA[actor.kind],
    draftAuthorId: actor.userId,
    draftAgentLabel: actor.agentLabel,
    draftAiRunId: actor.kind === 'assistant' ? (actor.runId ?? null) : null,
    draftAuthoredAt: new Date(),
  };
}

function authorMetadata(actor: WorkItemActor): Record<string, string> {
  return {
    authorKind: actor.kind,
    ...(actor.agentLabel === null ? {} : { agentLabel: actor.agentLabel }),
    ...(actor.runId === undefined ? {} : { aiRunId: actor.runId }),
  };
}

function emptyToNull(value: string | null): string | null {
  return value === null || value.trim().length === 0 ? null : value;
}
