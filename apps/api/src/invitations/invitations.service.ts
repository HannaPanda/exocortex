import { Inject, Injectable } from '@nestjs/common';

import {
  assertPolicy,
  canManageWorkspaceMembers,
  generateInvitationToken,
  hashInvitationToken,
  invitationUrl,
  looksLikeInvitationToken,
  WorkspaceAccessService,
} from '@exocortex/auth';
import { type ApiEnv } from '@exocortex/config';
import {
  type AcceptInvitationRequest,
  type AcceptInvitationResponse,
  type CreateInvitationRequest,
  type Invitation,
  type InvitationPreview,
  type InvitationStatus,
  isLocale,
  type Locale,
} from '@exocortex/contracts';
import {
  type PrismaClient,
  type UserRole as UserRolePrisma,
  type WorkspaceRole as WorkspaceRolePrisma,
} from '@exocortex/database';
import { resolveLocale } from '@exocortex/i18n';
import { type Logger } from '@exocortex/logger';
import { type Mailer } from '@exocortex/mail';

import { AuthService } from '../auth/auth.service';
import { AppError } from '../common/app-error';
import { API_ENV, LOGGER } from '../common/logger.provider';
import { OutboxService } from '../common/outbox.service';
import { MAILER, PRISMA } from '../platform/platform-tokens';

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

/** Everything the list and the create response need. Kept in one place so the two can never disagree. */
const INVITATION_INCLUDE = {
  invitedBy: { select: { name: true, email: true, locale: true } },
  workspace: { select: { name: true } },
} as const;

interface InvitationRow {
  id: string;
  email: string;
  role: UserRolePrisma;
  workspaceId: string | null;
  workspaceRole: WorkspaceRolePrisma | null;
  expiresAt: Date;
  acceptedAt: Date | null;
  revokedAt: Date | null;
  sentCount: number;
  lastSentAt: Date | null;
  locale: string | null;
  createdAt: Date;
  invitedBy: { name: string; email: string; locale: string | null };
  workspace: { name: string } | null;
}

/**
 * The status is derived, never stored: three timestamps already say everything,
 * and a fourth column repeating them is a column that can be wrong. Order
 * matters -- an invitation that was accepted stays "accepted" after its expiry
 * date passes, because that is what happened to it.
 */
export function invitationStatus(row: {
  acceptedAt: Date | null;
  revokedAt: Date | null;
  expiresAt: Date;
}): InvitationStatus {
  if (row.acceptedAt !== null) return 'accepted';
  if (row.revokedAt !== null) return 'revoked';
  if (row.expiresAt.getTime() <= Date.now()) return 'expired';
  return 'pending';
}

function toContract(row: InvitationRow): Invitation {
  return {
    id: row.id,
    email: row.email,
    status: invitationStatus(row),
    role: row.role === 'ADMIN' ? 'admin' : 'user',
    workspaceId: row.workspaceId,
    workspaceName: row.workspace?.name ?? null,
    workspaceRole: row.workspaceRole,
    invitedByName: row.invitedBy.name,
    invitedByEmail: row.invitedBy.email,
    expiresAt: row.expiresAt.toISOString(),
    acceptedAt: row.acceptedAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    sentCount: row.sentCount,
    lastSentAt: row.lastSentAt?.toISOString() ?? null,
    locale: isLocale(row.locale) ? row.locale : null,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * The language the invitation mail is written in (issue #98, ADR-062).
 *
 * The reader has no account yet, so there is no `User.locale` to ask: the
 * inviter's choice for this invitation wins, then the inviter's own account
 * language, then German. A tag the deployment no longer speaks is skipped.
 */
function invitationMailLocale(row: {
  locale: string | null;
  invitedBy: { locale: string | null };
}): Locale {
  return isLocale(row.locale) ? row.locale : resolveLocale({ preference: row.invitedBy.locale });
}

/** Addresses are compared and stored lowercased, so one person cannot hold two invitations. */
function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export interface CreatedInvitation {
  invitation: Invitation;
  url: string;
  emailSent: boolean;
}

/**
 * Invitations, and the accounts that come out of them (issue #3).
 *
 * Self-registration is off (`disableSignUp` in `packages/auth/src/auth.ts`), so
 * this service is the only path from "somebody has an email address" to "somebody
 * has an account here". It does not go through Better Auth's sign-up route --
 * that route is closed on purpose and staying closed is the point -- but it does
 * use Better Auth's own password hasher through `$context`, so an invited account
 * signs in through the ordinary form and is indistinguishable from a seeded one.
 *
 * Two callers issue invitations and they are allowed different things:
 *
 *   * a **global admin** may invite into any workspace or into none at all, and
 *     may grant the new account global admin rights;
 *   * a **workspace OWNER/ADMIN** may invite into their own workspace only, and
 *     never grants a global role.
 *
 * The second one does create an instance account as a side effect, which is the
 * open question the issue raised. It is answered yes deliberately: a deployment
 * for a handful of friends where the workspace owner cannot add a collaborator
 * without waiting for the operator is a deployment where the operator is a
 * ticket queue. The authority is bounded -- one workspace, no global role, and
 * every invitation is visible with its sender in the admin list.
 */
@Injectable()
export class InvitationsService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(API_ENV) private readonly env: ApiEnv,
    @Inject(LOGGER) private readonly logger: Logger,
    private readonly access: WorkspaceAccessService,
    private readonly authService: AuthService,
    private readonly outbox: OutboxService,
    // Synchronous on purpose (issue #102): the response carries `emailSent`,
    // and a queued job cannot answer that yet.
    @Inject(MAILER) private readonly mailer: Mailer,
  ) {}

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  /** Every invitation in the deployment, newest first. Global admin only. */
  async listAll(): Promise<Invitation[]> {
    const rows = await this.prisma.invitation.findMany({
      orderBy: { createdAt: 'desc' },
      include: INVITATION_INCLUDE,
    });
    return rows.map(toContract);
  }

  /** Invitations into one workspace. Requires the right to manage its members. */
  async listForWorkspace(workspaceId: string, actorUserId: string): Promise<Invitation[]> {
    const role = await this.access.findRole(workspaceId, actorUserId);
    assertPolicy(canManageWorkspaceMembers(role));

    const rows = await this.prisma.invitation.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'desc' },
      include: INVITATION_INCLUDE,
    });
    return rows.map(toContract);
  }

  // -------------------------------------------------------------------------
  // Issuing
  // -------------------------------------------------------------------------

  /**
   * Issues an invitation on behalf of a global admin.
   *
   * `workspaceId` is optional here: an admin may deliberately create an account
   * that belongs to no workspace yet.
   */
  async createAsAdmin(input: {
    request: CreateInvitationRequest;
    actorUserId: string;
    correlationId: string;
  }): Promise<CreatedInvitation> {
    if (input.request.workspaceId !== undefined) {
      const workspace = await this.prisma.workspace.findUnique({
        where: { id: input.request.workspaceId },
        select: { id: true, archivedAt: true },
      });
      if (workspace === null || workspace.archivedAt !== null) {
        throw AppError.notFound('Workspace');
      }
    }

    return this.issue({
      email: input.request.email,
      workspaceId: input.request.workspaceId ?? null,
      workspaceRole: input.request.workspaceId === undefined ? null : input.request.workspaceRole,
      globalRole: input.request.role === 'admin' ? 'ADMIN' : 'USER',
      expiresInDays: input.request.expiresInDays,
      locale: input.request.locale ?? null,
      actorUserId: input.actorUserId,
      correlationId: input.correlationId,
    });
  }

  /**
   * Issues an invitation into one workspace, on behalf of its OWNER or ADMIN.
   *
   * The workspace comes from the URL, not the body, and the global role is never
   * negotiable here: a workspace admin cannot mint a deployment admin.
   */
  async createForWorkspace(input: {
    workspaceId: string;
    request: CreateInvitationRequest;
    actorUserId: string;
    correlationId: string;
  }): Promise<CreatedInvitation> {
    const role = await this.access.findRole(input.workspaceId, input.actorUserId);
    assertPolicy(canManageWorkspaceMembers(role));

    if (input.request.role === 'admin') {
      throw AppError.forbidden('Only a global admin may grant global admin rights');
    }

    return this.issue({
      email: input.request.email,
      workspaceId: input.workspaceId,
      workspaceRole: input.request.workspaceRole,
      globalRole: 'USER',
      expiresInDays: input.request.expiresInDays,
      locale: input.request.locale ?? null,
      actorUserId: input.actorUserId,
      correlationId: input.correlationId,
    });
  }

  /**
   * Sends the invitation again, with a **fresh token**.
   *
   * Rotating rather than repeating the old link is the safer default: the reason
   * to resend is usually that the first mail went astray, and a link that went
   * astray is a link that should stop working. It also means one address never
   * has two live tokens.
   */
  async resend(input: {
    invitationId: string;
    actorUserId: string;
    workspaceId?: string;
  }): Promise<CreatedInvitation> {
    const existing = await this.prisma.invitation.findUnique({
      where: { id: input.invitationId },
      include: INVITATION_INCLUDE,
    });
    if (existing === null) throw AppError.notFound('Invitation');

    if (input.workspaceId !== undefined) {
      if (existing.workspaceId !== input.workspaceId) throw AppError.notFound('Invitation');
      const role = await this.access.findRole(input.workspaceId, input.actorUserId);
      assertPolicy(canManageWorkspaceMembers(role));
    }

    const status = invitationStatus(existing);
    if (status === 'accepted') {
      throw new AppError('invitation_already_used', 'This invitation has already been redeemed');
    }

    const token = generateInvitationToken();
    const expiresAt = new Date(Date.now() + this.ttlDays(existing) * MILLISECONDS_PER_DAY);

    const updated = await this.prisma.invitation.update({
      where: { id: existing.id },
      data: {
        tokenHash: token.tokenHash,
        expiresAt,
        // Resending a revoked invitation revives it; that is what the button
        // means, and it saves an admin from having to re-enter the address.
        revokedAt: null,
        sentCount: { increment: 1 },
      },
      include: INVITATION_INCLUDE,
    });

    const url = invitationUrl(this.env.APP_URL, token.secret);
    const sentAt = await this.sendInvitationMail({
      email: updated.email,
      invitedByName: updated.invitedBy.name,
      workspaceName: updated.workspace?.name ?? null,
      url,
      expiresAt,
      invitationId: updated.id,
      locale: invitationMailLocale(updated),
    });

    return {
      invitation: toContract({ ...updated, lastSentAt: sentAt ?? updated.lastSentAt }),
      url,
      emailSent: sentAt !== null,
    };
  }

  /** Withdraws an invitation. The link stops working immediately. */
  async revoke(input: {
    invitationId: string;
    actorUserId: string;
    workspaceId?: string;
  }): Promise<void> {
    const existing = await this.prisma.invitation.findUnique({
      where: { id: input.invitationId },
      select: { id: true, workspaceId: true, acceptedAt: true, email: true },
    });
    if (existing === null) throw AppError.notFound('Invitation');

    if (input.workspaceId !== undefined) {
      if (existing.workspaceId !== input.workspaceId) throw AppError.notFound('Invitation');
      const role = await this.access.findRole(input.workspaceId, input.actorUserId);
      assertPolicy(canManageWorkspaceMembers(role));
    }

    if (existing.acceptedAt !== null) {
      throw new AppError(
        'invitation_already_used',
        'This invitation was redeemed; disable the account instead',
      );
    }

    await this.prisma.invitation.update({
      where: { id: existing.id },
      data: { revokedAt: new Date() },
    });
    this.logger.info('Invitation revoked', {
      invitationId: existing.id,
      actorId: input.actorUserId,
    });
  }

  // -------------------------------------------------------------------------
  // Redeeming (unauthenticated)
  // -------------------------------------------------------------------------

  /**
   * What the acceptance page may show before anybody is signed in.
   *
   * Every failure mode answers with the same shape of error as an unknown token,
   * because this route is reachable by anyone: it must not become a way to learn
   * which tokens exist or which addresses have accounts.
   */
  async preview(token: string): Promise<InvitationPreview> {
    const row = await this.findRedeemable(token);
    const accountExists = (await this.prisma.user.count({ where: { email: row.email } })) > 0;

    return {
      email: row.email,
      invitedByName: row.invitedBy.name,
      workspaceName: row.workspace?.name ?? null,
      expiresAt: row.expiresAt.toISOString(),
      accountExists,
    };
  }

  /**
   * Turns an invitation into an account.
   *
   * The address is taken from the invitation, never from the request, so a valid
   * token cannot be used to register a different address. The new account is
   * marked `emailVerified` because the token arrived at that address and came
   * back: that is exactly the proof a verification mail collects, already
   * completed.
   *
   * One transaction, so an invitation can never be spent without the account and
   * the membership existing. The `updateMany` on the invitation is the lock: it
   * only matches while `acceptedAt` is still null, so two simultaneous
   * redemptions of the same link produce one account and one conflict.
   */
  async accept(request: AcceptInvitationRequest): Promise<AcceptInvitationResponse> {
    const row = await this.findRedeemable(request.token);

    const existingUser = await this.prisma.user.findUnique({
      where: { email: row.email },
      select: { id: true },
    });
    if (existingUser !== null) {
      throw new AppError(
        'invitation_email_taken',
        'An account for this address already exists; sign in instead',
      );
    }

    const context = await this.authService.auth.$context;
    const passwordHash = await context.password.hash(request.password);

    const result = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.invitation.updateMany({
        where: { id: row.id, acceptedAt: null, revokedAt: null },
        data: { acceptedAt: new Date() },
      });
      if (claimed.count === 0) {
        throw new AppError('invitation_already_used', 'This invitation has already been redeemed');
      }

      const user = await tx.user.create({
        data: {
          email: row.email,
          name: request.name,
          role: row.role,
          // The token was mailed to this address and came back from it. There is
          // nothing left for a verification mail to establish.
          emailVerified: true,
          // The language the invitation spoke becomes the account's until the
          // person picks another (issue #98). A fresh account has no choice of
          // its own to overrule, and an invitation nobody chose a language for
          // leaves it undecided, so the browser decides.
          locale: isLocale(row.locale) ? row.locale : null,
        },
        select: { id: true },
      });

      await tx.account.create({
        data: {
          userId: user.id,
          providerId: 'credential',
          // Better Auth's own convention for a credential account is that the
          // account id *is* the user id (`sign-up.mjs`), not the address.
          accountId: user.id,
          password: passwordHash,
        },
      });

      await tx.invitation.update({
        where: { id: row.id },
        data: { acceptedById: user.id },
      });

      if (row.workspaceId !== null) {
        await tx.workspaceMember.create({
          data: {
            workspaceId: row.workspaceId,
            userId: user.id,
            // A pending invitation always carries a role; the fallback keeps the
            // type honest for the rows that predate a role being required.
            role: row.workspaceRole ?? 'MEMBER',
          },
        });
        await this.outbox.writeAudit(tx, {
          workspaceId: row.workspaceId,
          actorId: user.id,
          action: 'workspace.member_joined',
          targetType: 'workspace_member',
          targetId: user.id,
          correlationId: `invitation:${row.id}`,
          metadata: { invitationId: row.id, role: row.workspaceRole ?? 'MEMBER' },
        });
      }

      return { userId: user.id };
    });

    this.logger.info('Invitation redeemed', {
      invitationId: row.id,
      userId: result.userId,
      workspaceId: row.workspaceId ?? undefined,
    });

    return { accepted: true, email: row.email, workspaceId: row.workspaceId };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Looks an invitation up by the token in the link and refuses everything that
   * is not a live, unspent one.
   *
   * The lookup is a single indexed read on the SHA-256 of the token, so a wrong
   * token costs what a right one costs. The raw value is never stored and never
   * logged.
   */
  private async findRedeemable(token: string): Promise<InvitationRow> {
    if (!looksLikeInvitationToken(token)) {
      throw new AppError('invitation_invalid', 'Not an invitation token');
    }

    const row = await this.prisma.invitation.findUnique({
      where: { tokenHash: hashInvitationToken(token) },
      include: INVITATION_INCLUDE,
    });
    if (row === null) {
      throw new AppError('invitation_invalid', 'Unknown invitation token');
    }

    switch (invitationStatus(row)) {
      case 'accepted':
        throw new AppError('invitation_already_used', 'This invitation has already been redeemed');
      case 'revoked':
        // Deliberately the same error an unknown token gets: a withdrawn
        // invitation should not confirm that it ever existed.
        throw new AppError('invitation_invalid', 'This invitation was withdrawn');
      case 'expired':
        throw new AppError('invitation_expired', 'This invitation has expired');
      case 'pending':
        return row;
    }
  }

  /**
   * Creates the row and tries to send the mail.
   *
   * A failed send is not a failed invitation: the row stays, `lastSentAt` stays
   * null, and the caller gets `emailSent: false` together with the link. The
   * alternative -- rolling the invitation back -- would leave an administrator
   * with a broken relay and no way to invite anyone, which is the situation this
   * whole feature exists to get out of.
   */
  private async issue(input: {
    email: string;
    workspaceId: string | null;
    workspaceRole: WorkspaceRolePrisma | null;
    globalRole: UserRolePrisma;
    expiresInDays: number;
    locale: Locale | null;
    actorUserId: string;
    correlationId: string;
  }): Promise<CreatedInvitation> {
    const email = normalizeEmail(input.email);

    const existingUser = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true },
    });
    if (existingUser !== null) {
      throw new AppError('invitation_email_taken', 'An account for this address already exists');
    }

    const token = generateInvitationToken();
    const expiresAt = new Date(Date.now() + input.expiresInDays * MILLISECONDS_PER_DAY);

    const created = await this.prisma.$transaction(async (tx) => {
      // One live link per address. An earlier invitation is withdrawn rather
      // than left alongside the new one, so nobody has to work out which of two
      // mails is the real one.
      await tx.invitation.updateMany({
        where: { email, acceptedAt: null, revokedAt: null },
        data: { revokedAt: new Date() },
      });

      const invitation = await tx.invitation.create({
        data: {
          email,
          tokenHash: token.tokenHash,
          invitedById: input.actorUserId,
          workspaceId: input.workspaceId,
          workspaceRole: input.workspaceRole,
          role: input.globalRole,
          expiresAt,
          locale: input.locale,
        },
        include: INVITATION_INCLUDE,
      });

      if (input.workspaceId !== null) {
        await this.outbox.writeAudit(tx, {
          workspaceId: input.workspaceId,
          actorId: input.actorUserId,
          action: 'workspace.member_invited',
          targetType: 'invitation',
          targetId: invitation.id,
          correlationId: input.correlationId,
          // The address is the point of the record; the token is not in it.
          metadata: { email, role: input.workspaceRole },
        });
      }

      return invitation;
    });

    const url = invitationUrl(this.env.APP_URL, token.secret);
    const sentAt = await this.sendInvitationMail({
      email,
      invitedByName: created.invitedBy.name,
      workspaceName: created.workspace?.name ?? null,
      url,
      expiresAt,
      invitationId: created.id,
      locale: invitationMailLocale(created),
    });

    this.logger.info('Invitation created', {
      invitationId: created.id,
      actorId: input.actorUserId,
      workspaceId: input.workspaceId ?? undefined,
      emailSent: sentAt !== null,
    });

    return {
      invitation: toContract({ ...created, lastSentAt: sentAt }),
      url,
      emailSent: sentAt !== null,
    };
  }

  /**
   * Sends the mail and records the attempt. Never throws; see `issue`.
   *
   * Returns the moment it went out, or null when it did not. The caller folds
   * that into the invitation it returns, because the row it built was read
   * before the send: without this, a successful create answers `emailSent: true`
   * next to `lastSentAt: null`, and the "nicht angekommen" column would
   * contradict the confirmation right beside it.
   */
  private async sendInvitationMail(input: {
    email: string;
    invitedByName: string;
    workspaceName: string | null;
    url: string;
    expiresAt: Date;
    invitationId: string;
    locale: Locale;
  }): Promise<Date | null> {
    try {
      await this.mailer.send({
        to: input.email,
        locale: input.locale,
        message: {
          template: 'INVITATION',
          invitedByName: input.invitedByName,
          workspaceName: input.workspaceName,
          url: input.url,
          expiresAt: input.expiresAt.toISOString(),
        },
      });
      const sentAt = new Date();
      await this.prisma.invitation.update({
        where: { id: input.invitationId },
        data: { lastSentAt: sentAt },
      });
      return sentAt;
    } catch (error) {
      this.logger.error('Failed to send invitation email', error, {
        invitationId: input.invitationId,
      });
      return null;
    }
  }

  /** Reuses the original lifetime when resending, so a short invitation stays short. */
  private ttlDays(row: { createdAt: Date; expiresAt: Date }): number {
    const days = Math.round(
      (row.expiresAt.getTime() - row.createdAt.getTime()) / MILLISECONDS_PER_DAY,
    );
    return days >= 1 && days <= 90 ? days : 7;
  }
}
