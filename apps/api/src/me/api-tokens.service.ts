import { Inject, Injectable } from '@nestjs/common';

import { generateApiToken } from '@exocortex/auth';
import {
  type ApiToken,
  type ApiTokenListResponse,
  type ApiTokenScope,
  apiTokenScopeSchema,
  type CreateApiTokenRequest,
  type CreateApiTokenResponse,
} from '@exocortex/contracts';
import { type PrismaClient } from '@exocortex/database';

import { AppError } from '../common/app-error';
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
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}

function toContract(row: ApiTokenRow): ApiToken {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    // Rows predating scopes, and any value the enum no longer knows, are dropped
    // rather than surfaced: the guard already treats them as granting nothing,
    // and the list must not claim an authority the token does not have.
    scopes: row.scopes.filter(isApiTokenScope),
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
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async list(userId: string): Promise<ApiTokenListResponse> {
    const rows = await this.prisma.apiToken.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
    return { tokens: rows.map(toContract) };
  }

  async create(userId: string, request: CreateApiTokenRequest): Promise<CreateApiTokenResponse> {
    const activeCount = await this.prisma.apiToken.count({ where: { userId, revokedAt: null } });
    if (activeCount >= MAX_ACTIVE_TOKENS_PER_USER) {
      throw new AppError('conflict', `You already have the maximum of ${MAX_ACTIVE_TOKENS_PER_USER} active API tokens`);
    }

    // The raw secret is returned exactly once, here, and never logged or stored.
    const generated = generateApiToken();
    const expiresAt =
      request.expiresInDays === null ? null : new Date(Date.now() + request.expiresInDays * MILLISECONDS_PER_DAY);

    const created = await this.prisma.apiToken.create({
      data: {
        userId,
        name: request.name,
        tokenHash: generated.tokenHash,
        prefix: generated.prefix,
        // Deduplicated, because the scopes are cumulative and a repeated entry
        // would only make the stored row harder to read.
        scopes: [...new Set(request.scopes)],
        expiresAt,
      },
    });

    return { token: toContract(created), secret: generated.secret };
  }

  /** Idempotent: revoking an already-revoked token is a no-op success. */
  async revoke(userId: string, tokenId: string): Promise<{ revoked: true }> {
    const existing = await this.prisma.apiToken.findFirst({ where: { id: tokenId, userId } });
    if (existing === null) throw AppError.notFound('API token');

    if (existing.revokedAt === null) {
      await this.prisma.apiToken.update({ where: { id: tokenId }, data: { revokedAt: new Date() } });
    }
    return { revoked: true };
  }
}
