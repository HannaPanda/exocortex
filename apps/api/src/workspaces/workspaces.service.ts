import { Inject, Injectable } from '@nestjs/common';

import {
  assertPolicy,
  canChangeMemberRole,
  canManageWorkspaceMembers,
  canUpdateWorkspace,
  WorkspaceAccessService,
} from '@exocortex/auth';
import {
  type CreateWorkspaceRequest,
  type UpdateWorkspaceRequest,
  type Workspace,
  type WorkspaceDetail,
  type WorkspaceMember,
  type WorkspaceRole,
} from '@exocortex/contracts';
import { type PrismaClient } from '@exocortex/database';

import { AppError } from '../common/app-error';
import { OutboxService } from '../common/outbox.service';
import { PRISMA } from '../platform/platform.module';
import { RealtimeService } from '../realtime/realtime.service';

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
  return base.length >= 2 ? base : 'arbeitsbereich';
}

/**
 * Workspace domain service.
 *
 * Workspaces and memberships are Exocortex domain entities; the Better Auth
 * organization plugin is deliberately not used for them, so ownership,
 * invitations and roles stay under application control.
 */
@Injectable()
export class WorkspacesService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly access: WorkspaceAccessService,
    private readonly outbox: OutboxService,
    private readonly realtime: RealtimeService,
  ) {}

  async listForUser(userId: string): Promise<Workspace[]> {
    const memberships = await this.prisma.workspaceMember.findMany({
      where: { userId, workspace: { archivedAt: null } },
      include: {
        workspace: { include: { _count: { select: { members: true } } } },
      },
      orderBy: { createdAt: 'asc' },
    });

    return memberships.map((membership) => ({
      id: membership.workspace.id,
      name: membership.workspace.name,
      slug: membership.workspace.slug,
      createdAt: membership.workspace.createdAt.toISOString(),
      updatedAt: membership.workspace.updatedAt.toISOString(),
      role: membership.role,
      memberCount: membership.workspace._count.members,
    }));
  }

  /** Creates a workspace and makes the creator its OWNER, atomically. */
  async create(userId: string, input: CreateWorkspaceRequest): Promise<Workspace> {
    const desiredSlug = input.slug ?? slugify(input.name);
    const slug = await this.findFreeSlug(desiredSlug);

    const workspace = await this.prisma.$transaction(async (tx) => {
      const created = await tx.workspace.create({
        data: {
          name: input.name,
          slug,
          members: { create: { userId, role: 'OWNER' } },
        },
      });
      return created;
    });

    return {
      id: workspace.id,
      name: workspace.name,
      slug: workspace.slug,
      createdAt: workspace.createdAt.toISOString(),
      updatedAt: workspace.updatedAt.toISOString(),
      role: 'OWNER',
      memberCount: 1,
    };
  }

  async getDetail(workspaceId: string, userId: string): Promise<WorkspaceDetail> {
    const role = await this.access.requireRole(workspaceId, userId);
    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      include: {
        members: {
          include: { user: { select: { id: true, name: true, email: true } } },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    if (workspace === null) throw AppError.notFound('Workspace');

    const members: WorkspaceMember[] = workspace.members.map((member) => ({
      id: member.id,
      userId: member.userId,
      name: member.user.name,
      email: member.user.email,
      role: member.role,
      createdAt: member.createdAt.toISOString(),
    }));

    return {
      id: workspace.id,
      name: workspace.name,
      slug: workspace.slug,
      createdAt: workspace.createdAt.toISOString(),
      updatedAt: workspace.updatedAt.toISOString(),
      role,
      memberCount: members.length,
      members,
    };
  }

  /**
   * Renames a workspace and/or changes its slug.
   *
   * The two are independent on purpose: unlike `create()`, this never derives
   * `slug` from `name`. The slug appears in URLs and in links people already
   * saved, so a plain rename must not silently move it; changing it is a
   * separate, explicit field the UI warns about.
   */
  async update(input: {
    workspaceId: string;
    actorUserId: string;
    request: UpdateWorkspaceRequest;
    correlationId: string;
  }): Promise<Workspace> {
    const role = await this.access.findRole(input.workspaceId, input.actorUserId);
    assertPolicy(canUpdateWorkspace(role));

    if (input.request.slug !== undefined) {
      const existing = await this.prisma.workspace.findUnique({
        where: { slug: input.request.slug },
        select: { id: true },
      });
      if (existing !== null && existing.id !== input.workspaceId) {
        throw new AppError(
          'workspace_slug_taken',
          'This slug is already used by another workspace',
        );
      }
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const workspace = await tx.workspace.update({
        where: { id: input.workspaceId },
        data: {
          ...(input.request.name === undefined ? {} : { name: input.request.name }),
          ...(input.request.slug === undefined ? {} : { slug: input.request.slug }),
        },
        include: { _count: { select: { members: true } } },
      });

      await this.outbox.writeAudit(tx, {
        workspaceId: input.workspaceId,
        actorId: input.actorUserId,
        action: 'workspace.renamed',
        targetType: 'workspace',
        targetId: input.workspaceId,
        correlationId: input.correlationId,
        metadata: {
          ...(input.request.name === undefined ? {} : { name: input.request.name }),
          ...(input.request.slug === undefined ? {} : { slug: input.request.slug }),
        },
      });
      await this.outbox.writeEvent(tx, {
        workspaceId: input.workspaceId,
        type: 'workspace.updated',
        payload: { workspace: { id: input.workspaceId } },
        correlationId: input.correlationId,
      });

      return workspace;
    });

    await this.realtime.emit('workspace.updated', input.workspaceId, input.correlationId, {
      workspace: { id: input.workspaceId },
    });

    return {
      id: updated.id,
      name: updated.name,
      slug: updated.slug,
      createdAt: updated.createdAt.toISOString(),
      updatedAt: updated.updatedAt.toISOString(),
      role: role as WorkspaceRole,
      memberCount: updated._count.members,
    };
  }

  /** Changes a member's role. Audited, because it is permission-relevant. */
  async changeMemberRole(input: {
    workspaceId: string;
    actorUserId: string;
    targetUserId: string;
    nextRole: WorkspaceRole;
    correlationId: string;
  }): Promise<WorkspaceMember> {
    const actorRole = await this.access.findRole(input.workspaceId, input.actorUserId);
    assertPolicy(canManageWorkspaceMembers(actorRole));

    const target = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: input.workspaceId, userId: input.targetUserId } },
      include: { user: { select: { id: true, name: true, email: true } } },
    });
    if (target === null) throw AppError.notFound('Workspace member');

    const ownerCount = await this.access.countOwners(input.workspaceId);
    assertPolicy(canChangeMemberRole(actorRole, target.role, input.nextRole, ownerCount));

    const updated = await this.prisma.$transaction(async (tx) => {
      const member = await tx.workspaceMember.update({
        where: { id: target.id },
        data: { role: input.nextRole },
        include: { user: { select: { id: true, name: true, email: true } } },
      });
      await this.outbox.writeAudit(tx, {
        workspaceId: input.workspaceId,
        actorId: input.actorUserId,
        action: 'workspace.member_role_changed',
        targetType: 'workspace_member',
        targetId: member.id,
        correlationId: input.correlationId,
        metadata: { previousRole: target.role, nextRole: input.nextRole },
      });
      await this.outbox.writeEvent(tx, {
        workspaceId: input.workspaceId,
        type: 'workspace.updated',
        payload: { workspace: { id: input.workspaceId } },
        correlationId: input.correlationId,
      });
      return member;
    });

    await this.realtime.emit('workspace.updated', input.workspaceId, input.correlationId, {
      workspace: { id: input.workspaceId },
    });

    return {
      id: updated.id,
      userId: updated.userId,
      name: updated.user.name,
      email: updated.user.email,
      role: updated.role,
      createdAt: updated.createdAt.toISOString(),
    };
  }

  private async findFreeSlug(desired: string): Promise<string> {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const candidate = attempt === 0 ? desired : `${desired}-${attempt + 1}`;
      const existing = await this.prisma.workspace.findUnique({
        where: { slug: candidate },
        select: { id: true },
      });
      if (existing === null) return candidate;
    }
    throw AppError.conflict('Could not derive a free workspace slug');
  }
}
