import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';

import {
  requestClassFor,
  requiredScopeForRequest,
  tokenHasScope,
  writeModeAllows,
} from '@exocortex/auth';

import { AppError } from '../common/app-error';
import { isHttpContext } from '../common/http-context';

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
 * AI run from a session that was itself authorized -- except when that run is
 * held to a write mode (issue #141), which its token carries and this enforces.
 */
@Injectable()
export class TokenScopeGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    if (!isHttpContext(context)) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    // A run of the built-in AI held to a write mode (issue #141): the mode is
    // signed into its service token, so the refusal happens here, on the
    // server, whatever the tool loop decided.
    if (
      request.exocortexCredential === 'service_token' &&
      request.exocortexWriteMode !== undefined
    ) {
      const requestClass = requestClassFor(request.method, pathOf(request.url));
      if (writeModeAllows(request.exocortexWriteMode, requestClass)) return true;
      throw new AppError(
        'api_token_insufficient_scope',
        `This run may not make a '${requestClass}' request in the '${request.exocortexWriteMode}' mode`,
      );
    }
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
