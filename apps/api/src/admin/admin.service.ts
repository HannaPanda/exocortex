import { Inject, Injectable } from '@nestjs/common';

import {
  type AdminOverviewResponse,
  type AdminUser,
  type AdminUserListResponse,
  type SettingsResponse,
  type UpdateSettingsRequest,
  type UserRole,
} from '@exocortex/contracts';
import { type PrismaClient, type UserRole as UserRolePrisma } from '@exocortex/database';
import { type Logger } from '@exocortex/logger';

import { AppError } from '../common/app-error';
import { LOGGER } from '../common/logger.provider';
import { PRISMA } from '../platform/platform-tokens';
import { SettingsService } from '../platform/settings.service';
import { RealtimeService } from '../realtime/realtime.service';

const USER_ROLE_TO_CONTRACT: Record<UserRolePrisma, UserRole> = { USER: 'user', ADMIN: 'admin' };
const USER_ROLE_TO_PRISMA: Record<UserRole, UserRolePrisma> = { user: 'USER', admin: 'ADMIN' };

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

interface UserWithCounts {
  id: string;
  email: string;
  name: string;
  role: UserRolePrisma;
  emailVerified: boolean;
  disabledAt: Date | null;
  createdAt: Date;
  _count: {
    memberships: number;
    createdDocuments: number;
    updatedDocuments: number;
    comments: number;
    createdAttachments: number;
  };
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
    disabledAt: user.disabledAt?.toISOString() ?? null,
    hasAuthoredContent: hasAuthoredContent(user._count),
  };
}

/**
 * Whether anything still names this account as its author.
 *
 * The four relations counted here are exactly the ones whose foreign key to
 * `user` is required, so they are the ones that make a `DELETE` impossible at
 * the database level. Everything else about an account (sessions, tokens,
 * memberships, conversations) cascades away on its own.
 */
function hasAuthoredContent(counts: UserWithCounts['_count']): boolean {
  return (
    counts.createdDocuments > 0 ||
    counts.updatedDocuments > 0 ||
    counts.comments > 0 ||
    counts.createdAttachments > 0
  );
}

const USER_WITH_COUNTS_INCLUDE = {
  _count: {
    select: {
      memberships: true,
      createdDocuments: true,
      updatedDocuments: true,
      comments: true,
      createdAttachments: true,
    },
  },
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
    private readonly realtime: RealtimeService,
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

  /**
   * The settings plus the stored rows that had to be ignored. The admin area is
   * the one place where a dropped row has to be visible (issue #27), so both
   * halves travel together rather than needing a second request.
   */
  async getSettings(): Promise<SettingsResponse> {
    const settings = await this.settingsService.get();
    return { settings, invalidKeys: await this.settingsService.invalidKeys() };
  }

  async updateSettings(patch: UpdateSettingsRequest, actorId: string): Promise<SettingsResponse> {
    const settings = await this.settingsService.update({ patch, actorId });
    // Read after the write: a save that corrected a bad row must not answer with
    // the list from before it.
    return { settings, invalidKeys: await this.settingsService.invalidKeys() };
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

  /**
   * Switches an account off, or back on.
   *
   * Disabling is not a flag somebody has to remember to check on every request.
   * It takes effect by removing what the account can act with: every session row
   * and every API token goes, and `packages/auth`'s session-creation hook refuses
   * to make a new one while `disabledAt` is set. So there is no window in which a
   * disabled account still holds a working credential, and no per-request lookup
   * on the hot path either.
   *
   * The same two lock-out guards as `updateUserRole`: not yourself, and not the
   * last remaining admin.
   */
  async setUserDisabled(input: {
    userId: string;
    disabled: boolean;
    actorId: string;
  }): Promise<AdminUser> {
    if (input.userId === input.actorId) {
      throw AppError.validation('You cannot disable your own account');
    }

    const target = await this.prisma.user.findUnique({
      where: { id: input.userId },
      select: { id: true, role: true, disabledAt: true },
    });
    if (target === null) throw AppError.notFound('User');

    if (input.disabled && target.role === 'ADMIN') {
      const activeAdmins = await this.prisma.user.count({
        where: { role: 'ADMIN', disabledAt: null },
      });
      if (activeAdmins <= 1) {
        throw AppError.conflict('The last global admin cannot be disabled');
      }
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.update({
        where: { id: input.userId },
        data: { disabledAt: input.disabled ? new Date() : null },
        include: USER_WITH_COUNTS_INCLUDE,
      });

      if (input.disabled) {
        // Both credential kinds at once. A session cookie stops working because
        // the row it points at is gone; a bearer token because it is marked
        // revoked, which `SessionGuard` already refuses.
        await tx.session.deleteMany({ where: { userId: input.userId } });
        await tx.apiToken.updateMany({
          where: { userId: input.userId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        // An OAuth connector holds its own access tokens, so a switched-off
        // account must lose those too, or ChatGPT keeps working for an hour.
        await tx.oauthAccessToken.deleteMany({ where: { userId: input.userId } });
      }

      return user;
    });

    if (input.disabled) {
      // Deleting the credentials stops every new request, but a WebSocket that
      // was authenticated an hour ago has no credential left to lose: it has to
      // be told (issue #62). Re-enabling publishes nothing -- a regained right
      // takes effect when the account signs in again, never by seeping into a
      // connection that outlived the switch-off.
      await this.realtime.revoke({
        userId: input.userId,
        workspaceId: null,
        reason: 'account_disabled',
        correlationId: 'admin-user-disabled',
      });
    }

    this.logger.info(input.disabled ? 'User disabled' : 'User re-enabled', {
      actorId: input.actorId,
      userId: input.userId,
    });
    return toAdminUser(updated);
  }

  /**
   * Deletes an account outright.
   *
   * Only for an account that authored nothing. `Document.createdById` is a
   * required reference, so the database would refuse anyway; catching it here
   * turns a 500 into `user_has_content` and a sentence that says what to do
   * instead. What this is for is the invitation that went to the wrong address
   * and the account nobody ever used -- everything with a history gets disabled.
   */
  async deleteUser(input: { userId: string; actorId: string }): Promise<void> {
    if (input.userId === input.actorId) {
      throw AppError.validation('You cannot delete your own account');
    }

    const target = await this.prisma.user.findUnique({
      where: { id: input.userId },
      include: USER_WITH_COUNTS_INCLUDE,
    });
    if (target === null) throw AppError.notFound('User');

    if (target.role === 'ADMIN') {
      const adminCount = await this.prisma.user.count({ where: { role: 'ADMIN' } });
      if (adminCount <= 1) {
        throw AppError.conflict('The last global admin cannot be deleted');
      }
    }

    if (hasAuthoredContent(target._count)) {
      throw new AppError(
        'user_has_content',
        'This account authored pages, comments or uploads; disable it instead of deleting it',
      );
    }

    await this.prisma.user.delete({ where: { id: input.userId } });
    await this.realtime.revoke({
      userId: input.userId,
      workspaceId: null,
      reason: 'account_deleted',
      correlationId: 'admin-user-deleted',
    });
    this.logger.info('User deleted', { actorId: input.actorId, userId: input.userId });
  }
}
