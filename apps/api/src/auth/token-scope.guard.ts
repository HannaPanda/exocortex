import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';

import { requiredScopeForRequest, tokenHasScope } from '@exocortex/auth';

import { AppError } from '../common/app-error';

import { type AuthenticatedRequest } from './session.guard';

/**
 * Narrows what a persistent `exo_` API token may do.
 *
 * Without this, a token is the account: every workspace, every document,
 * deletion, the admin API, and the power to mint further tokens. That is far
 * more authority than an MCP client or a cron job needs, and all of it leaks at
 * once when the token does -- into a CI log, a chat message, a stolen laptop.
 *
 * Runs after `SessionGuard` (which resolves the credential) and before
 * `AdminGuard` (which checks the *user's* role). The two are independent on
 * purpose: an administrator holding a read-only token must still be refused the
 * admin API, and a token scoped to `admin` grants nothing to a user who is not
 * one.
 *
 * Cookie sessions and the worker's service tokens pass through untouched. A
 * human at a browser already is the account, and a service token is minted per
 * AI run from a session that was itself authorized.
 */
@Injectable()
export class TokenScopeGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (request.exocortexCredential !== 'api_token') return true;

    const required = requiredScopeForRequest(request.method, pathOf(request.url));
    if (tokenHasScope(request.exocortexTokenScopes ?? [], required)) return true;

    throw new AppError(
      'api_token_insufficient_scope',
      `This API token does not carry the '${required}' scope`,
    );
  }
}

/** The request path without the query string; scopes never depend on the query. */
function pathOf(url: string): string {
  const queryStart = url.indexOf('?');
  return queryStart === -1 ? url : url.slice(0, queryStart);
}
