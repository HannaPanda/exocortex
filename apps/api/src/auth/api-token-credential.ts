import { type PageScopeRestriction } from '@exocortex/auth';
import { type Prisma } from '@exocortex/database';

import { AppError } from '../common/app-error';

/**
 * What decides whether a persistent `exo_` token may still act, in one place.
 *
 * Two callers ask: `SessionGuard`, for the token in a request's `Authorization`
 * header, and the upload-ticket redeem route (ADR-064), for the token that
 * minted the ticket minutes earlier. They must never disagree -- a ticket that
 * outlived its token's revocation would be a way around it -- so the columns
 * read and the refusals given are shared rather than written twice.
 */
export const API_TOKEN_CREDENTIAL_SELECT = {
  id: true,
  scopes: true,
  pageScoped: true,
  pageScopes: { select: { documentId: true, scope: true } },
  expiresAt: true,
  revokedAt: true,
  user: {
    select: { id: true, email: true, name: true, emailVerified: true, disabledAt: true },
  },
} satisfies Prisma.ApiTokenSelect;

export type ApiTokenCredential = Prisma.ApiTokenGetPayload<{
  select: typeof API_TOKEN_CREDENTIAL_SELECT;
}>;

/** Throws the refusal a token that can no longer act deserves; returns when it can. */
export function assertApiTokenUsable(token: ApiTokenCredential, now: number = Date.now()): void {
  if (token.revokedAt !== null) {
    throw new AppError('api_token_invalid', 'The API token has been revoked');
  }
  // Belt and braces: disabling an account revokes its tokens in the same
  // transaction, so this should be unreachable. It stays because "should be"
  // is doing a lot of work in that sentence, and the column is already loaded.
  if (token.user.disabledAt !== null) {
    throw new AppError('user_disabled', 'This account is disabled');
  }
  if (token.expiresAt !== null && token.expiresAt.getTime() <= now) {
    throw new AppError('api_token_expired', 'The API token has expired');
  }
}

/**
 * The pages the token is confined to, or `undefined` for a token that carries
 * its owner's full reach.
 *
 * `declared` is the flag, not the length of the list: the rows are deleted with
 * the pages they name, so an empty list on a confined token means "everything
 * it was given is gone", which must reach nothing rather than everything
 * (issue #83, ADR-044).
 */
export function pageScopesOf(token: ApiTokenCredential): PageScopeRestriction | undefined {
  return token.pageScoped
    ? { tokenId: token.id, declared: true, scopes: token.pageScopes }
    : undefined;
}
