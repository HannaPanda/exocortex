import { Inject, Injectable } from '@nestjs/common';

import {
  type AdminOverviewResponse,
  type AdminUser,
  type AdminUserListResponse,
  type Settings,
  type UpdateSettingsRequest,
  type UserRole,
} from '@exocortex/contracts';
import { type PrismaClient, type UserRole as UserRolePrisma } from '@exocortex/database';
import { type Logger } from '@exocortex/logger';

import { AppError } from '../common/app-error';
import { LOGGER } from '../common/logger.provider';
import { PRISMA } from '../platform/platform-tokens';
import { SettingsService } from '../platform/settings.service';

const USER_ROLE_TO_CONTRACT: Record<UserRolePrisma, UserRole> = { USER: 'user', ADMIN: 'admin' };
const USER_ROLE_TO_PRISMA: Record<UserRole, UserRolePrisma> = { user: 'USER', admin: 'ADMIN' };

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

interface UserWithCounts {
  id: string;
  email: string;
  name: string;
  role: UserRolePrisma;
  emailVerified: boolean;
  createdAt: Date;
  _count: { memberships: number };
  sessions: { createdAt: Date }[];
}

function toAdminUser(user: UserWithCounts): AdminUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: USER_ROLE_TO_CONTRACT[user.role],
    emailVerified: user.emailVerified,
    workspaceCount: user._count.memberships,
    createdAt: user.createdAt.toISOString(),
    lastSessionAt: user.sessions[0]?.createdAt.toISOString() ?? null,
  };
}

const USER_WITH_COUNTS_INCLUDE = {
  _count: { select: { memberships: true } },
  sessions: { orderBy: { createdAt: 'desc' as const }, take: 1, select: { createdAt: true } },
};

/**
 * Deployment-wide administration: the overview dashboard, user role
 * management, and settings pass-through. Every route this backs is guarded by
 * `@AdminOnly()` on `AdminController`.
 */
@Injectable()
export class AdminService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(LOGGER) private readonly logger: Logger,
    private readonly settingsService: SettingsService,
  ) {}

  async overview(): Promise<AdminOverviewResponse> {
    const since = new Date(Date.now() - TWENTY_FOUR_HOURS_MS);

    const [
      userCount,
      adminCount,
      workspaceCount,
      documentCount,
      attachmentCount,
      aiRunsLast24h,
      aiModelCount,
      enabledAiModelCount,
      apiTokenCount,
      costRows,
    ] = await this.prisma.$transaction([
      this.prisma.user.count(),
      this.prisma.user.count({ where: { role: 'ADMIN' } }),
      this.prisma.workspace.count({ where: { archivedAt: null } }),
      this.prisma.document.count({ where: { archivedAt: null } }),
      this.prisma.attachment.count({ where: { deletedAt: null } }),
      this.prisma.aiRun.count({ where: { createdAt: { gte: since } } }),
      this.prisma.aiModel.count(),
      this.prisma.aiModel.count({ where: { enabled: true } }),
      this.prisma.apiToken.count({ where: { revokedAt: null } }),
      // Prisma cannot express "sum a JSON field cast to bigint" without a raw
      // query; this is intentionally the only line of raw SQL in this method.
      this.prisma.$queryRaw<{ total: bigint | null }[]>`
        SELECT COALESCE(SUM((usage->>'providerCostMicroUsd')::bigint), 0) AS total
        FROM ai_run
        WHERE "createdAt" >= ${since}
      `,
    ]);

    return {
      userCount,
      adminCount,
      workspaceCount,
      documentCount,
      attachmentCount,
      aiRunsLast24h,
      aiCostLast24hMicroUsd: Number(costRows[0]?.total ?? 0n),
      aiModelCount,
      enabledAiModelCount,
      apiTokenCount,
    };
  }

  async getSettings(): Promise<Settings> {
    return this.settingsService.get();
  }

  async updateSettings(patch: UpdateSettingsRequest, actorId: string): Promise<Settings> {
    return this.settingsService.update({ patch, actorId });
  }

  async listUsers(): Promise<AdminUserListResponse> {
    const users = await this.prisma.user.findMany({
      orderBy: { createdAt: 'asc' },
      include: USER_WITH_COUNTS_INCLUDE,
    });
    return { users: users.map(toAdminUser) };
  }

  /**
   * Changes a user's global role. Guarded against two lock-out scenarios: an
   * admin can never change their own global role through this endpoint (the
   * only realistic self-change is a demotion, and a locked-out sole admin
   * cannot self-repair), and the last remaining ADMIN can never be demoted.
   */
  async updateUserRole(userId: string, role: UserRole, actorId: string): Promise<AdminUser> {
    if (userId === actorId) {
      throw AppError.validation('You cannot change your own global role');
    }

    const target = await this.prisma.user.findUnique({ where: { id: userId } });
    if (target === null) throw AppError.notFound('User');

    const nextRole = USER_ROLE_TO_PRISMA[role];
    if (target.role === 'ADMIN' && nextRole !== 'ADMIN') {
      const adminCount = await this.prisma.user.count({ where: { role: 'ADMIN' } });
      if (adminCount <= 1) {
        throw new AppError('conflict', 'The last global admin cannot be demoted');
      }
    }

    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: { role: nextRole },
      include: USER_WITH_COUNTS_INCLUDE,
    });

    this.logger.info('User global role changed', { actorId, userId, nextRole: role });
    return toAdminUser(updated);
  }
}
