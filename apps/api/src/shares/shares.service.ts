import { Inject, Injectable } from '@nestjs/common';

import {
  assertPolicy,
  canManageShares,
  canReadShares,
  canShareAtMost,
  generateShareToken,
  WorkspaceAccessService,
} from '@exocortex/auth';
import {
  type CreateShareRequest,
  type DocumentShare,
  type DocumentShareChangedPayload,
  type IncomingShare,
  type IncomingShareListResponse,
  type MyShareListResponse,
  type OutgoingShareListResponse,
  type ShareListResponse,
  type SharePermission,
  type ShareResponse,
  type ShareScope,
  type UpdateShareRequest,
} from '@exocortex/contracts';
import {
  loadAncestorChain,
  type PrismaClient,
  type PrismaTransactionClient,
} from '@exocortex/database';
import { type Logger } from '@exocortex/logger';

import { AppError } from '../common/app-error';
import { LOGGER } from '../common/logger.provider';
import { OutboxService } from '../common/outbox.service';
import { toSummary } from '../documents/document-shape';
import { PRISMA } from '../platform/platform.module';
import { RealtimeService } from '../realtime/realtime.service';

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * A page can carry only so many grants before the list stops being reviewable,
 * and a list nobody reviews is where a forgotten share lives for ever.
 */
const MAX_SHARES_PER_DOCUMENT = 50;

/** Upper bound of the personal list; the answer says when it was reached. */
const MAX_MY_SHARES = 500;

interface ShareRow {
  id: string;
  workspaceId: string;
  documentId: string;
  kind: 'USER' | 'PUBLIC_LINK';
  permission: SharePermission;
  scope: ShareScope;
  granteeId: string | null;
  grantee: { id: string; name: string; email: string } | null;
  tokenPrefix: string | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
  createdById: string;
  createdBy: { name: string };
  createdAt: Date;
  document: { title: string; icon: string | null };
}

const SHARE_SELECT = {
  id: true,
  workspaceId: true,
  documentId: true,
  kind: true,
  permission: true,
  scope: true,
  granteeId: true,
  grantee: { select: { id: true, name: true, email: true } },
  tokenPrefix: true,
  expiresAt: true,
  revokedAt: true,
  createdById: true,
  createdBy: { select: { name: true } },
  createdAt: true,
  document: { select: { title: true, icon: true } },
} as const;

function toContract(row: ShareRow, secret?: string): DocumentShare {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    documentId: row.documentId,
    documentTitle: row.document.title,
    documentIcon: row.document.icon,
    kind: row.kind,
    permission: row.permission,
    scope: row.scope,
    grantee: row.grantee,
    // The raw link exists in exactly one response: the one that created it.
    // Everywhere else it is the prefix, because a list that could reproduce a
    // link would make every reader of the list a holder of it.
    token: secret ?? null,
    tokenPrefix: row.tokenPrefix,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    createdById: row.createdById,
    createdByName: row.createdBy.name,
    createdAt: row.createdAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null,
  };
}

/**
 * True when an update changed something the recipient would want to know
 * (issue #103): what they may do, how far it reaches, or how long it lasts.
 *
 * Everything else an update can touch is bookkeeping. A tree move is not in
 * this list at all and never reaches it: moving a page into a shared branch
 * writes no share row, which is what keeps a reorganization from mailing
 * everybody who holds anything nearby.
 */
function changesTheGrant(before: ShareRow, after: ShareRow): boolean {
  return (
    before.permission !== after.permission ||
    before.scope !== after.scope ||
    (before.expiresAt?.getTime() ?? null) !== (after.expiresAt?.getTime() ?? null)
  );
}

/**
 * Page shares (issue #83, ADR-044).
 *
 * This service writes grants; it never reads one to decide anything. Deciding
 * is `WorkspaceAccessService`, where every route already goes, and keeping the
 * two apart is what stops a second authorization path from growing here --
 * the failure the issue's architecture note warns about.
 *
 * What this service does own is the consequence of a change: a withdrawn or
 * narrowed grant has to reach connections that are already open (ADR-029), and
 * that cannot wait for the next request because a collaboration socket makes
 * no further requests.
 */
@Injectable()
export class SharesService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(LOGGER) private readonly logger: Logger,
    private readonly access: WorkspaceAccessService,
    private readonly outbox: OutboxService,
    private readonly realtime: RealtimeService,
  ) {}

  /**
   * Every grant on one page, live ones first, plus the ones it is covered by
   * from further up.
   *
   * Both halves in one answer on purpose: the page that is readable from
   * outside without anybody here having shared *it* is the one nobody would
   * think to ask about.
   */
  async list(documentId: string, userId: string): Promise<ShareListResponse> {
    const context = await this.access.requireDocumentContext(documentId, userId);
    assertPolicy(canReadShares(context.role));
    // Somebody who is here *through* a share is told nothing about the others:
    // who else holds the page, and whether a public link exists beside their
    // own grant, is the workspace's business. An empty answer rather than a
    // refusal, because the badge that asks this runs on every page view.
    if (context.grant.source !== 'membership') return { shares: [], inherited: [] };

    const chain = await loadAncestorChain(this.prisma, documentId);
    const ancestors = chain.slice(1);
    const now = new Date();
    const [rows, inheritedRows] = await Promise.all([
      this.prisma.documentShare.findMany({
        where: { documentId },
        select: SHARE_SELECT,
        orderBy: [{ revokedAt: 'asc' }, { createdAt: 'desc' }],
      }),
      ancestors.length === 0
        ? Promise.resolve([])
        : this.prisma.documentShare.findMany({
            where: {
              documentId: { in: ancestors },
              scope: 'SUBTREE',
              revokedAt: null,
              OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
            },
            select: SHARE_SELECT,
            orderBy: { createdAt: 'desc' },
          }),
    ]);
    return {
      shares: rows.map((row) => toContract(row)),
      inherited: inheritedRows.map((row) => toContract(row)),
    };
  }

  async create(input: {
    documentId: string;
    userId: string;
    request: CreateShareRequest;
    correlationId: string;
  }): Promise<ShareResponse> {
    const context = await this.access.requireDocumentContext(input.documentId, input.userId);
    // A share is made by a member of the workspace, never by somebody who only
    // holds a share themselves: re-sharing would let a grant outlive the chain
    // of people who agreed to it, and nobody in that chain would see the list.
    if (context.grant.source !== 'membership') {
      throw AppError.forbidden('A page reached through a share cannot be shared on');
    }
    assertPolicy(canShareAtMost(context.role, input.request.permission, context.document));

    const active = await this.prisma.documentShare.count({
      where: { documentId: input.documentId, revokedAt: null },
    });
    if (active >= MAX_SHARES_PER_DOCUMENT) {
      throw AppError.conflict(
        `This page already has the maximum of ${MAX_SHARES_PER_DOCUMENT} active shares`,
      );
    }

    const expiresAt =
      input.request.expiresInDays === null
        ? null
        : new Date(Date.now() + input.request.expiresInDays * MILLISECONDS_PER_DAY);

    return input.request.kind === 'USER'
      ? this.createUserShare({ ...input, context, expiresAt })
      : this.createLinkShare({ ...input, context, expiresAt });
  }

  private async createUserShare(input: {
    documentId: string;
    userId: string;
    request: CreateShareRequest;
    correlationId: string;
    context: { workspaceId: string; document: { title: string } };
    expiresAt: Date | null;
  }): Promise<ShareResponse> {
    const email = (input.request.email ?? '').trim().toLowerCase();
    const grantee = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true, disabledAt: true },
    });
    // No account, and a switched-off account, answer the same way: a sharing
    // dialog must not become a way to find out who has an account here and
    // whether it still works.
    if (grantee === null || grantee.disabledAt !== null) {
      throw new AppError('share_grantee_unknown', 'No account here uses that address');
    }
    if (grantee.id === input.userId) {
      throw new AppError('share_grantee_is_member', 'You already have access to this page');
    }
    // The raw membership of the *grantee*, which is a question about their
    // account and not about this request's credential.
    const existingRole = await this.access.findMembershipRole(
      input.context.workspaceId,
      grantee.id,
    );
    if (existingRole !== null) {
      throw new AppError(
        'share_grantee_is_member',
        'That person is already a member of this workspace and can reach the page',
      );
    }

    const duplicate = await this.prisma.documentShare.findFirst({
      where: { documentId: input.documentId, granteeId: grantee.id, revokedAt: null },
      select: { id: true },
    });
    if (duplicate !== null) {
      throw new AppError('share_exists', 'This page is already shared with that account');
    }

    const created = await this.prisma.$transaction(async (tx) => {
      // A revoked grant to the same account still occupies the unique pair, so
      // it is cleared rather than left to collide. Re-sharing is a new grant,
      // not the old one coming back to life.
      await tx.documentShare.deleteMany({
        where: { documentId: input.documentId, granteeId: grantee.id },
      });
      const row = await tx.documentShare.create({
        data: {
          workspaceId: input.context.workspaceId,
          documentId: input.documentId,
          kind: 'USER',
          permission: input.request.permission,
          scope: input.request.scope,
          granteeId: grantee.id,
          expiresAt: input.expiresAt,
          createdById: input.userId,
        },
        select: SHARE_SELECT,
      });
      await this.outbox.writeAudit(tx, {
        workspaceId: input.context.workspaceId,
        actorId: input.userId,
        action: 'document.shared',
        targetType: 'document',
        targetId: input.documentId,
        correlationId: input.correlationId,
        metadata: {
          kind: 'USER',
          granteeId: grantee.id,
          permission: input.request.permission,
          scope: input.request.scope,
        },
      });
      await this.announceByMail(tx, row, input.userId, 'granted', input.correlationId);
      return row;
    });

    this.logger.info('Page shared with an account', {
      documentId: input.documentId,
      shareId: created.id,
      permission: created.permission,
      scope: created.scope,
    });
    return { share: toContract(created) };
  }

  private async createLinkShare(input: {
    documentId: string;
    userId: string;
    request: CreateShareRequest;
    correlationId: string;
    context: { workspaceId: string };
    expiresAt: Date | null;
  }): Promise<ShareResponse> {
    const token = generateShareToken();
    const created = await this.prisma.$transaction(async (tx) => {
      const row = await tx.documentShare.create({
        data: {
          workspaceId: input.context.workspaceId,
          documentId: input.documentId,
          kind: 'PUBLIC_LINK',
          // Belt and braces beside the contract's refinement and the check
          // constraint in the migration: anonymous writing does not exist.
          permission: 'READ',
          scope: input.request.scope,
          tokenHash: token.tokenHash,
          tokenPrefix: token.prefix,
          expiresAt: input.expiresAt,
          createdById: input.userId,
        },
        select: SHARE_SELECT,
      });
      await this.outbox.writeAudit(tx, {
        workspaceId: input.context.workspaceId,
        actorId: input.userId,
        action: 'document.shared',
        targetType: 'document',
        targetId: input.documentId,
        correlationId: input.correlationId,
        // The raw token is never written here, and never logged: an audit row
        // that carried it would make the log a list of working links.
        metadata: { kind: 'PUBLIC_LINK', scope: input.request.scope },
      });
      return row;
    });

    this.logger.info('Public link created for a page', {
      documentId: input.documentId,
      shareId: created.id,
      scope: created.scope,
    });
    return { share: toContract(created, token.secret) };
  }

  async update(input: {
    shareId: string;
    userId: string;
    request: UpdateShareRequest;
    correlationId: string;
  }): Promise<ShareResponse> {
    const existing = await this.loadManageableShare(input.shareId, input.userId);
    if (existing.kind === 'PUBLIC_LINK' && input.request.permission === 'WRITE') {
      throw AppError.validation('A public link is read-only');
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.documentShare.update({
        where: { id: input.shareId },
        data: {
          ...(input.request.permission === undefined
            ? {}
            : { permission: input.request.permission }),
          ...(input.request.scope === undefined ? {} : { scope: input.request.scope }),
          ...(input.request.expiresInDays === undefined
            ? {}
            : {
                expiresAt:
                  input.request.expiresInDays === null
                    ? null
                    : new Date(Date.now() + input.request.expiresInDays * MILLISECONDS_PER_DAY),
              }),
        },
        select: SHARE_SELECT,
      });
      // Only when the grant actually reads differently afterwards. A dialog
      // that submits every field on every save would otherwise mail somebody
      // to tell them nothing changed, which is how a useful mail becomes one
      // people filter away.
      if (row.revokedAt === null && changesTheGrant(existing, row)) {
        await this.announceByMail(tx, row, input.userId, 'changed', input.correlationId);
      }
      return row;
    });

    // Every change, not only a narrowing (ADR-029): a connection authorized
    // under the old grant is replaced rather than patched, so a widened one
    // arrives through a fresh handshake and a narrowed one takes effect now.
    await this.announce(updated, input.correlationId);
    return { share: toContract(updated) };
  }

  async revoke(input: {
    shareId: string;
    userId: string;
    correlationId: string;
  }): Promise<{ revoked: true }> {
    const existing = await this.loadManageableShare(input.shareId, input.userId);
    if (existing.revokedAt === null) {
      const revoked = await this.prisma.$transaction(async (tx) => {
        const row = await tx.documentShare.update({
          where: { id: input.shareId },
          data: { revokedAt: new Date() },
          select: SHARE_SELECT,
        });
        await this.outbox.writeAudit(tx, {
          workspaceId: row.workspaceId,
          actorId: input.userId,
          action: 'document.share_revoked',
          targetType: 'document',
          targetId: row.documentId,
          correlationId: input.correlationId,
          metadata: { kind: row.kind, shareId: row.id },
        });
        await this.announceByMail(tx, row, input.userId, 'revoked', input.correlationId);
        return row;
      });
      await this.announce(revoked, input.correlationId);
    }
    return { revoked: true };
  }

  /**
   * Writes the event the recipient's mail is built from (issue #103).
   *
   * Inside the caller's transaction, like every other outbox write: a mail
   * announcing a share that was rolled back is worse than no mail at all,
   * because the reader will go looking for a page that never existed.
   *
   * Nothing is decided here beyond "this grant names an account". Whether that
   * account still exists, whether it is switched off, and what its address is,
   * are read by the dispatcher when it enqueues the mail -- minutes later, from
   * the state that holds then.
   */
  private async announceByMail(
    tx: PrismaTransactionClient,
    row: ShareRow,
    actorId: string,
    change: 'granted' | 'changed' | 'revoked',
    correlationId: string,
  ): Promise<void> {
    // A public link is nobody's post. Not an omission: mailing on link
    // creation would mean mailing whoever created it about what they just did.
    if (row.kind !== 'USER' || row.granteeId === null) return;
    await this.outbox.writeEvent(tx, {
      workspaceId: row.workspaceId,
      type: 'document.share.changed',
      payload: {
        shareId: row.id,
        documentId: row.documentId,
        granteeId: row.granteeId,
        actorId,
        change,
      } satisfies DocumentShareChangedPayload,
      correlationId,
    });
  }

  /** Tells open connections that a grant changed. A link has nobody to tell. */
  private async announce(row: ShareRow, correlationId: string): Promise<void> {
    if (row.granteeId === null) return;
    await this.realtime.revoke({
      userId: row.granteeId,
      workspaceId: row.workspaceId,
      reason: 'document_share_changed',
      correlationId,
    });
  }

  private async loadManageableShare(shareId: string, userId: string): Promise<ShareRow> {
    const row = await this.prisma.documentShare.findUnique({
      where: { id: shareId },
      select: SHARE_SELECT,
    });
    if (row === null) throw AppError.notFound('Share');
    // Through the document, so a confined credential and a non-member are
    // refused by the one place that knows how to refuse them.
    const context = await this.access.requireDocumentContext(row.documentId, userId);
    if (context.grant.source !== 'membership') {
      throw AppError.forbidden('A page reached through a share cannot be shared on');
    }
    assertPolicy(canManageShares(context.role));
    return row;
  }

  /** What this workspace has handed out, for the "Freigaben" overview. */
  async listOutgoing(workspaceId: string, userId: string): Promise<OutgoingShareListResponse> {
    const scoped = await this.access.requireScopedRole(workspaceId, userId);
    assertPolicy(canReadShares(scoped.role));

    const rows = await this.prisma.documentShare.findMany({
      where: {
        workspaceId,
        ...(scoped.documentIds === null ? {} : { documentId: { in: [...scoped.documentIds] } }),
      },
      select: SHARE_SELECT,
      orderBy: [{ revokedAt: 'asc' }, { createdAt: 'desc' }],
      take: 200,
    });
    return { shares: rows.map((row) => toContract(row)) };
  }

  /**
   * What this account has handed out, across every workspace it is a member of.
   *
   * Limited to the caller's own grants, because the question is "what did I
   * share" and the per-workspace overview already answers "what did anybody
   * share here". Only workspaces the caller still belongs to are asked: a grant
   * in a workspace they have left is that workspace's business now, and the
   * row would name a page they may no longer see. A confined credential gets
   * the grants on the pages it reaches, through the same `requireScopedRole`
   * the per-workspace list uses.
   */
  async listMine(userId: string): Promise<MyShareListResponse> {
    const memberships = await this.prisma.workspaceMember.findMany({
      where: { userId },
      select: { workspaceId: true, role: true, workspace: { select: { name: true } } },
    });

    const names = new Map<string, string>();
    const revocable = new Set<string>();
    const filters: { workspaceId: string; documentId?: { in: string[] } }[] = [];
    for (const membership of memberships) {
      if (!canReadShares(membership.role).allowed) continue;
      const scoped = await this.access.requireScopedRole(membership.workspaceId, userId);
      names.set(membership.workspaceId, membership.workspace.name);
      if (canManageShares(scoped.role).allowed) revocable.add(membership.workspaceId);
      filters.push(
        scoped.documentIds === null
          ? { workspaceId: membership.workspaceId }
          : { workspaceId: membership.workspaceId, documentId: { in: [...scoped.documentIds] } },
      );
    }
    if (filters.length === 0) return { shares: [], truncated: false };

    const rows = await this.prisma.documentShare.findMany({
      where: { createdById: userId, OR: filters },
      select: SHARE_SELECT,
      // Live grants first. Postgres sorts NULL last in ascending order, and a
      // live grant is exactly the one whose `revokedAt` is NULL.
      orderBy: [{ revokedAt: { sort: 'asc', nulls: 'first' } }, { createdAt: 'desc' }],
      take: MAX_MY_SHARES + 1,
    });
    return {
      shares: rows.slice(0, MAX_MY_SHARES).map((row) => ({
        ...toContract(row),
        workspaceName: names.get(row.workspaceId) ?? '',
        canRevoke: revocable.has(row.workspaceId),
      })),
      truncated: rows.length > MAX_MY_SHARES,
    };
  }

  /**
   * Pages other people have shared with me.
   *
   * The one listing in the application that crosses workspace boundaries on
   * purpose, and the reason the recipient sees anything at all: they are not a
   * member anywhere, so no navigation would ever show them the page.
   */
  async listIncoming(userId: string): Promise<IncomingShareListResponse> {
    const now = new Date();
    const rows = await this.prisma.documentShare.findMany({
      where: {
        granteeId: userId,
        kind: 'USER',
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      select: {
        id: true,
        workspaceId: true,
        permission: true,
        scope: true,
        expiresAt: true,
        createdAt: true,
        createdBy: { select: { name: true } },
        workspace: { select: { name: true } },
        document: {
          select: {
            id: true,
            workspaceId: true,
            parentId: true,
            type: true,
            title: true,
            icon: true,
            iconColor: true,
            layout: true,
            overviewMode: true,
            coverAttachmentId: true,
            coverPosition: true,
            orderKey: true,
            createdById: true,
            updatedById: true,
            createdAt: true,
            updatedAt: true,
            archivedAt: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });

    const shares: IncomingShare[] = rows.map((row) => ({
      id: row.id,
      workspaceId: row.workspaceId,
      workspaceName: row.workspace.name,
      document: toSummary(row.document),
      permission: row.permission,
      scope: row.scope,
      sharedByName: row.createdBy.name,
      sharedAt: row.createdAt.toISOString(),
      expiresAt: row.expiresAt?.toISOString() ?? null,
    }));
    return { shares };
  }

  /**
   * The grants a page would inherit if it were moved under `parentId`.
   *
   * The move dialog asks this before it moves anything (issue #83): dropping a
   * page into a shared branch is the one way to publish something without
   * doing anything that looks like publishing, and a person who cannot see
   * that coming will do it eventually.
   */
  async inheritedAt(parentId: string, userId: string): Promise<ShareListResponse> {
    const context = await this.access.requireDocumentContext(parentId, userId);
    assertPolicy(canReadShares(context.role));

    const chain = await loadAncestorChain(this.prisma, parentId);

    const now = new Date();
    const rows = await this.prisma.documentShare.findMany({
      where: {
        documentId: { in: chain },
        scope: 'SUBTREE',
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      select: SHARE_SELECT,
      orderBy: { createdAt: 'desc' },
    });
    // Every one of them is inherited by definition: this route answers about a
    // target, and the target's own grants say nothing about what lands in it.
    return { shares: [], inherited: rows.map((row) => toContract(row)) };
  }
}
