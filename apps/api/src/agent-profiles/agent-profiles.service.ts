import { Inject, Injectable } from '@nestjs/common';

import { assertPolicy, canManageAgentProfiles, WorkspaceAccessService } from '@exocortex/auth';
import {
  type AgentProfileListResponse,
  type AgentProfileResponse,
  type CreateAgentProfileRequest,
  type DeleteAgentProfileResponse,
  type DuplicateAgentProfileRequest,
  TOOL_DOMAINS,
  type UpdateAgentProfileRequest,
} from '@exocortex/contracts';
import { Prisma, type PrismaClient, type PrismaTransactionClient } from '@exocortex/database';

import { AppError } from '../common/app-error';
import { currentAiRunId } from '../common/correlation';
import { OutboxService } from '../common/outbox.service';
import { PRISMA } from '../platform/platform.module';

import {
  AGENT_PROFILE_SELECT,
  type AgentProfileRow,
  toAgentProfile,
  toHistoryEntry,
} from './agent-profile-mapper';

/** How many audit lines the detail read carries. */
const HISTORY_LIMIT = 30;

type ProfileFields = Omit<UpdateAgentProfileRequest, 'isDefault'>;

/** What a request sets, in a shape both a create and an update accept. */
type ProfileColumns = Omit<
  Prisma.AgentProfileUncheckedCreateInput,
  'id' | 'workspaceId' | 'name' | 'isDefault' | 'revision'
> & { name?: string };

/**
 * Agent profiles (issue #143, ADR-071).
 *
 * Reading is anybody's in the workspace, writing an admin's. A run of the
 * built-in AI may write none of it, whatever its person may do: a profile is
 * what holds the run, and a run that could edit the rules it runs under would
 * not be held by them. Every change lands in the audit log in the
 * transaction that makes it.
 */
@Injectable()
export class AgentProfilesService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly access: WorkspaceAccessService,
    private readonly outbox: OutboxService,
  ) {}

  async list(input: { workspaceId: string; userId: string }): Promise<AgentProfileListResponse> {
    await this.access.requireRole(input.workspaceId, input.userId);
    const rows = await this.prisma.agentProfile.findMany({
      where: { workspaceId: input.workspaceId },
      select: AGENT_PROFILE_SELECT,
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
    });
    const titles = await this.ruleTitles(rows.flatMap((row) => row.ruleDocumentIds));
    return { profiles: rows.map((row) => toAgentProfile(row, titles)) };
  }

  async get(input: { profileId: string; userId: string }): Promise<AgentProfileResponse> {
    const row = await this.loadRow(input.profileId);
    await this.access.requireRole(row.workspaceId, input.userId);
    const [titles, audit] = await Promise.all([
      this.ruleTitles(row.ruleDocumentIds),
      this.prisma.auditLog.findMany({
        where: { targetType: 'agent_profile', targetId: row.id },
        orderBy: { createdAt: 'desc' },
        take: HISTORY_LIMIT,
        select: {
          action: true,
          metadata: true,
          createdAt: true,
          actor: { select: { id: true, name: true } },
        },
      }),
    ]);
    return { profile: toAgentProfile(row, titles), history: audit.map(toHistoryEntry) };
  }

  async create(input: {
    workspaceId: string;
    userId: string;
    request: CreateAgentProfileRequest;
    correlationId: string;
  }): Promise<AgentProfileResponse> {
    await this.assertMayManage(input.workspaceId, input.userId);
    const { request } = input;
    await this.validate(input.workspaceId, request);

    const id = await this.writeUnique(() =>
      this.prisma.$transaction(async (tx) => {
        if (request.isDefault === true) await this.clearDefault(tx, input.workspaceId);
        const created = await tx.agentProfile.create({
          data: {
            workspaceId: input.workspaceId,
            name: request.name,
            ...this.columns(request),
            isDefault: request.isDefault ?? false,
            createdById: input.userId,
            updatedById: input.userId,
          },
          select: { id: true },
        });
        await this.outbox.writeAudit(tx, {
          workspaceId: input.workspaceId,
          actorId: input.userId,
          action: 'agent_profile.created',
          targetType: 'agent_profile',
          targetId: created.id,
          correlationId: input.correlationId,
          metadata: { name: request.name, revision: 1 },
        });
        return created.id;
      }),
    );
    return this.get({ profileId: id, userId: input.userId });
  }

  async update(input: {
    profileId: string;
    userId: string;
    request: UpdateAgentProfileRequest;
    correlationId: string;
  }): Promise<AgentProfileResponse> {
    const existing = await this.loadRow(input.profileId);
    await this.assertMayManage(existing.workspaceId, input.userId);
    const { request } = input;
    await this.validate(existing.workspaceId, request);

    await this.writeUnique(() =>
      this.prisma.$transaction(async (tx) => {
        if (request.isDefault === true && !existing.isDefault) {
          await this.clearDefault(tx, existing.workspaceId);
        }
        const updated = await tx.agentProfile.update({
          where: { id: existing.id },
          data: {
            ...this.columns(request),
            ...(request.isDefault === undefined ? {} : { isDefault: request.isDefault }),
            revision: { increment: 1 },
            updatedById: input.userId,
          },
          select: { revision: true },
        });
        await this.outbox.writeAudit(tx, {
          workspaceId: existing.workspaceId,
          actorId: input.userId,
          action: 'agent_profile.updated',
          targetType: 'agent_profile',
          targetId: existing.id,
          correlationId: input.correlationId,
          metadata: { fields: Object.keys(request).join(','), revision: updated.revision },
        });
      }),
    );
    return this.get({ profileId: existing.id, userId: input.userId });
  }

  async duplicate(input: {
    profileId: string;
    userId: string;
    request: DuplicateAgentProfileRequest;
    correlationId: string;
  }): Promise<AgentProfileResponse> {
    const source = await this.get({ profileId: input.profileId, userId: input.userId });
    const { profile } = source;
    return this.create({
      workspaceId: profile.workspaceId,
      userId: input.userId,
      correlationId: input.correlationId,
      request: {
        name: input.request.name,
        description: profile.description,
        instructions: profile.instructions,
        ruleDocumentIds: profile.ruleDocuments
          .filter((rule) => rule.title !== null)
          .map((rule) => rule.documentId),
        modelSlug: profile.modelSlug,
        reasoningLevel: profile.reasoningLevel,
        providerRouting: profile.providerRouting,
        toolDomains: profile.toolDomains,
        writeMode: profile.writeMode,
        approvalPolicy: profile.approvalPolicy,
        budgetMicroUsdPerRun: profile.budgetMicroUsdPerRun,
        budgetMicroUsdPerTask: profile.budgetMicroUsdPerTask,
        maxToolIterations: profile.maxToolIterations,
        maxRunSeconds: profile.maxRunSeconds,
        confineToWorkspace: profile.confineToWorkspace,
        // A copy is a new role, never a second default.
        isDefault: false,
      },
    });
  }

  async delete(input: {
    profileId: string;
    userId: string;
    correlationId: string;
  }): Promise<DeleteAgentProfileResponse> {
    const existing = await this.loadRow(input.profileId);
    await this.assertMayManage(existing.workspaceId, input.userId);
    const detached = await this.prisma.$transaction(async (tx) => {
      const count = await tx.workItem.count({ where: { agentProfileId: existing.id } });
      await tx.agentProfile.delete({ where: { id: existing.id } });
      await this.outbox.writeAudit(tx, {
        workspaceId: existing.workspaceId,
        actorId: input.userId,
        action: 'agent_profile.deleted',
        targetType: 'agent_profile',
        targetId: existing.id,
        correlationId: input.correlationId,
        metadata: { name: existing.name, revision: existing.revision, detachedWorkItems: count },
      });
      return count;
    });
    return { deleted: true, detachedWorkItems: detached };
  }

  /**
   * A profile of this workspace the caller may name on a work item, or a
   * refusal. Used by the work item service, which owns the question of who
   * may change the profile of a piece of work.
   */
  async assertUsable(workspaceId: string, profileId: string): Promise<{ name: string }> {
    const row = await this.prisma.agentProfile.findUnique({
      where: { id: profileId },
      select: { workspaceId: true, name: true },
    });
    if (row === null || row.workspaceId !== workspaceId) throw AppError.notFound('Agent profile');
    return { name: row.name };
  }

  private async assertMayManage(workspaceId: string, userId: string): Promise<void> {
    if (currentAiRunId() !== undefined) {
      throw AppError.forbidden('A run of the built-in AI cannot change agent profiles');
    }
    const role = await this.access.findRole(workspaceId, userId);
    if (role === null) throw AppError.notFound('Agent profile');
    assertPolicy(canManageAgentProfiles(role));
  }

  private async loadRow(profileId: string): Promise<AgentProfileRow> {
    const row = await this.prisma.agentProfile.findUnique({
      where: { id: profileId },
      select: AGENT_PROFILE_SELECT,
    });
    if (row === null) throw AppError.notFound('Agent profile');
    return row;
  }

  /** The rule pages must be live pages of this workspace; the model must be enabled. */
  private async validate(workspaceId: string, request: ProfileFields): Promise<void> {
    const ruleIds = [...new Set(request.ruleDocumentIds ?? [])];
    if (ruleIds.length > 0) {
      const found = await this.prisma.document.count({
        where: { id: { in: ruleIds }, workspaceId, archivedAt: null },
      });
      if (found !== ruleIds.length) {
        throw new AppError(
          'agent_profile_invalid',
          'A rule page is not a live page of this workspace',
        );
      }
    }
    if (request.modelSlug !== undefined && request.modelSlug !== null) {
      const model = await this.prisma.aiModel.findUnique({
        where: { slug: request.modelSlug },
        select: { enabled: true },
      });
      if (model?.enabled !== true) {
        throw new AppError('agent_profile_invalid', 'The model is not enabled in the registry');
      }
    }
  }

  /** The columns a request sets; absent leaves a column alone, null clears it. */
  private columns(request: ProfileFields): ProfileColumns {
    const data: ProfileColumns = {};
    if (request.name !== undefined) data.name = request.name;
    if (request.description !== undefined) data.description = emptyToNull(request.description);
    if (request.instructions !== undefined) data.instructions = emptyToNull(request.instructions);
    if (request.ruleDocumentIds !== undefined) {
      data.ruleDocumentIds = [...new Set(request.ruleDocumentIds)];
    }
    if (request.modelSlug !== undefined) data.modelSlug = request.modelSlug;
    if (request.reasoningLevel !== undefined) {
      data.reasoningLevel =
        request.reasoningLevel === null
          ? null
          : (request.reasoningLevel.toUpperCase() as ProfileColumns['reasoningLevel']);
    }
    if (request.providerRouting !== undefined) {
      data.providerRouting =
        request.providerRouting === null || Object.keys(request.providerRouting).length === 0
          ? Prisma.DbNull
          : (request.providerRouting as Prisma.InputJsonObject);
    }
    if (request.toolDomains !== undefined) {
      data.toolDomains =
        request.toolDomains === null
          ? Prisma.DbNull
          : TOOL_DOMAINS.filter((domain) => request.toolDomains!.includes(domain));
    }
    if (request.writeMode !== undefined) {
      data.writeMode = request.writeMode.toUpperCase() as 'READ_ONLY' | 'PROPOSE' | 'DIRECT';
    }
    if (request.approvalPolicy !== undefined) {
      data.approvalPolicy = request.approvalPolicy.toUpperCase() as 'NONE' | 'REVIEW_BEFORE_DONE';
    }
    if (request.budgetMicroUsdPerRun !== undefined) {
      data.budgetMicroUsdPerRun = request.budgetMicroUsdPerRun;
    }
    if (request.budgetMicroUsdPerTask !== undefined) {
      data.budgetMicroUsdPerTask = request.budgetMicroUsdPerTask;
    }
    if (request.maxToolIterations !== undefined) data.maxToolIterations = request.maxToolIterations;
    if (request.maxRunSeconds !== undefined) data.maxRunSeconds = request.maxRunSeconds;
    if (request.confineToWorkspace !== undefined) {
      data.confineToWorkspace = request.confineToWorkspace;
    }
    return data;
  }

  private async clearDefault(tx: PrismaTransactionClient, workspaceId: string): Promise<void> {
    await tx.agentProfile.updateMany({
      where: { workspaceId, isDefault: true },
      data: { isDefault: false },
    });
  }

  /** Runs a write, turning a clash on the unique name into its own code. */
  private async writeUnique<T>(write: () => Promise<T>): Promise<T> {
    try {
      return await write();
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new AppError(
          'agent_profile_name_taken',
          'Another agent profile in this workspace has that name',
        );
      }
      throw error;
    }
  }

  private async ruleTitles(ids: readonly string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const rows = await this.prisma.document.findMany({
      where: { id: { in: [...new Set(ids)] }, archivedAt: null },
      select: { id: true, title: true },
    });
    return new Map(rows.map((row) => [row.id, row.title]));
  }
}

function emptyToNull(value: string | null): string | null {
  return value === null || value.trim().length === 0 ? null : value;
}
