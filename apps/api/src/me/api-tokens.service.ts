import { Inject, Injectable } from '@nestjs/common';

import { generateApiToken, WorkspaceAccessService } from '@exocortex/auth';
import {
  type ApiToken,
  type ApiTokenListResponse,
  type ApiTokenPageScope,
  type ApiTokenScope,
  apiTokenScopeSchema,
  type CreateApiTokenRequest,
  type CreateApiTokenResponse,
  type ShareScope,
} from '@exocortex/contracts';
import { type PrismaClient } from '@exocortex/database';

import { AppError } from '../common/app-error';
import { currentPageScopeRestriction } from '../common/correlation';
import { PRISMA } from '../platform/platform-tokens';

/** Every user manages their own tokens; a 21st active one is refused rather than silently allowed to grow unbounded. */
const MAX_ACTIVE_TOKENS_PER_USER = 20;
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

function isApiTokenScope(value: string): value is ApiTokenScope {
  return apiTokenScopeSchema.safeParse(value).success;
}

interface ApiTokenRow {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  pageScoped: boolean;
  pageScopes: {
    documentId: string;
    scope: ShareScope;
    document: { title: string; workspaceId: string };
  }[];
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}

const TOKEN_SELECT = {
  id: true,
  name: true,
  prefix: true,
  scopes: true,
  pageScoped: true,
  pageScopes: {
    select: {
      documentId: true,
      scope: true,
      document: { select: { title: true, workspaceId: true } },
    },
  },
  lastUsedAt: true,
  expiresAt: true,
  revokedAt: true,
  createdAt: true,
} as const;

function toContract(row: ApiTokenRow): ApiToken {
  const pageScopes: ApiTokenPageScope[] = row.pageScopes.map((entry) => ({
    documentId: entry.documentId,
    scope: entry.scope,
    documentTitle: entry.document.title,
    workspaceId: entry.document.workspaceId,
  }));
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    // Rows predating scopes, and any value the enum no longer knows, are dropped
    // rather than surfaced: the guard already treats them as granting nothing,
    // and the list must not claim an authority the token does not have.
    scopes: row.scopes.filter(isApiTokenScope),
    // A confined token that has lost every page it named answers with an empty
    // list, and that is the truth rather than a gap: it now reaches nothing.
    // The list is not what makes it confined -- `pageScoped` is (issue #83).
    pageScopes,
    lastUsedAt: row.lastUsedAt === null ? null : row.lastUsedAt.toISOString(),
    expiresAt: row.expiresAt === null ? null : row.expiresAt.toISOString(),
    revokedAt: row.revokedAt === null ? null : row.revokedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Personal API token management. Every user manages only their own tokens --
 * `revoke` scopes its `where` to `{ id, userId }` so one user can never revoke
 * another's token, and no admin role is required (session or token auth is
 * enough, see `SessionGuard`).
 */
@Injectable()
export class ApiTokensService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly access: WorkspaceAccessService,
  ) {}

  async list(userId: string): Promise<ApiTokenListResponse> {
    const rows = await this.prisma.apiToken.findMany({
      where: { userId },
      select: TOKEN_SELECT,
      orderBy: { createdAt: 'desc' },
    });
    return { tokens: rows.map(toContract) };
  }

  async create(userId: string, request: CreateApiTokenRequest): Promise<CreateApiTokenResponse> {
    const activeCount = await this.prisma.apiToken.count({ where: { userId, revokedAt: null } });
    if (activeCount >= MAX_ACTIVE_TOKENS_PER_USER) {
      throw new AppError(
        'conflict',
        `You already have the maximum of ${MAX_ACTIVE_TOKENS_PER_USER} active API tokens`,
      );
    }

    // A confined credential cannot mint an unconfined one (issue #83). Without
    // this line the whole mechanism is decorative: the narrow token would ask
    // for a wide one and carry on. The scopes it *does* name are then checked
    // below by reading each page as the caller, which under a confinement is
    // itself confined -- so a narrow token can only ever mint a token no wider
    // than itself.
    if (currentPageScopeRestriction() !== null && request.pageScopes.length === 0) {
      throw new AppError(
        'token_scope_exceeded',
        'A page-scoped credential cannot create a token without page scopes',
      );
    }

    // "A token can never hold more rights than its account" (issue #83): every
    // page it is confined to has to be one this person can actually reach, so
    // the scope is checked as a read by them, right now. It is checked again on
    // every request the token makes, because a membership can end afterwards --
    // this check is about not issuing a token that was wrong from the start.
    await this.assertScopesAreReachable(userId, request.pageScopes);

    // The raw secret is returned exactly once, here, and never logged or stored.
    const generated = generateApiToken();
    const expiresAt =
      request.expiresInDays === null
        ? null
        : new Date(Date.now() + request.expiresInDays * MILLISECONDS_PER_DAY);

    const created = await this.prisma.apiToken.create({
      data: {
        userId,
        name: request.name,
        tokenHash: generated.tokenHash,
        prefix: generated.prefix,
        // Deduplicated, because the scopes are cumulative and a repeated entry
        // would only make the stored row harder to read.
        scopes: [...new Set(request.scopes)],
        pageScoped: request.pageScopes.length > 0,
        pageScopes: {
          create: request.pageScopes.map((entry) => ({
            documentId: entry.documentId,
            scope: entry.scope,
          })),
        },
        expiresAt,
      },
      select: TOKEN_SELECT,
    });

    return { token: toContract(created), secret: generated.secret };
  }

  /** Every named page has to be one this account may read today. */
  private async assertScopesAreReachable(
    userId: string,
    pageScopes: CreateApiTokenRequest['pageScopes'],
  ): Promise<void> {
    const seen = new Set<string>();
    for (const entry of pageScopes) {
      if (seen.has(entry.documentId)) {
        throw AppError.validation('A page may appear only once in the scope list');
      }
      seen.add(entry.documentId);
      const context = await this.access.findDocumentContext(entry.documentId, userId);
      if (context === null) {
        throw AppError.validation(
          'A page named in the scope list does not exist or is not visible to you',
        );
      }
    }
  }

  /** Idempotent: revoking an already-revoked token is a no-op success. */
  async revoke(userId: string, tokenId: string): Promise<{ revoked: true }> {
    const existing = await this.prisma.apiToken.findFirst({ where: { id: tokenId, userId } });
    if (existing === null) throw AppError.notFound('API token');

    if (existing.revokedAt === null) {
      await this.prisma.apiToken.update({
        where: { id: tokenId },
        data: { revokedAt: new Date() },
      });
    }
    return { revoked: true };
  }
}
