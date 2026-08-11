import { type PrismaClient } from '@exocortex/database';

import { type VerifiedSession } from './auth';

/**
 * Verification of the access tokens the Better Auth `mcp` plugin issues.
 *
 * Deliberately a direct read rather than a call into `auth.api.getMcpSession`:
 * the plugin's endpoint types cannot be named through better-auth's export map
 * (see `createMcpPlugin`), and more importantly this keeps every credential
 * kind the API accepts verifiable by the same kind of code, next to
 * `verifyApiToken` and `verifyServiceToken`, instead of one of them hiding
 * inside a plugin.
 *
 * What this token is *not*: a session. It authenticates exactly one endpoint,
 * `/api/mcp`. `SessionGuard` never looks at it, so an OAuth token cannot be
 * pointed at the REST API to do things the MCP catalogue does not offer.
 */

export interface VerifiedMcpToken {
  session: VerifiedSession;
  /** `clientId` of the OAuth application the token was issued to. */
  clientId: string;
  /** Space-separated OAuth scopes recorded on the token. */
  scopes: string;
}

export type McpTokenFailure = 'unknown' | 'expired' | 'orphaned' | 'client_disabled';

export type McpTokenVerification =
  | { valid: true; token: VerifiedMcpToken }
  | { valid: false; reason: McpTokenFailure };

export async function verifyMcpAccessToken(
  prisma: PrismaClient,
  accessToken: string,
  now: Date = new Date(),
): Promise<McpTokenVerification> {
  const row = await prisma.oauthAccessToken.findUnique({
    where: { accessToken },
    select: {
      accessTokenExpiresAt: true,
      clientId: true,
      scopes: true,
      application: { select: { disabled: true } },
      user: { select: { id: true, email: true, name: true, emailVerified: true } },
    },
  });

  if (row === null) return { valid: false, reason: 'unknown' };
  if (row.accessTokenExpiresAt.getTime() <= now.getTime()) {
    return { valid: false, reason: 'expired' };
  }
  // `userId` is nullable in the plugin's schema because a client-credentials
  // grant would have no user. This deployment issues no such grant, so a row
  // without one is a token that authorizes nobody, and it must not resolve to
  // some default account.
  if (row.user === null) return { valid: false, reason: 'orphaned' };
  // Turning a client off is how a connector is revoked without hunting down
  // every token it holds, so the check has to happen on use, not only on issue.
  if (row.application.disabled === true) return { valid: false, reason: 'client_disabled' };

  return {
    valid: true,
    token: {
      session: {
        userId: row.user.id,
        sessionId: `mcp:${row.clientId}`,
        email: row.user.email,
        name: row.user.name,
        emailVerified: row.user.emailVerified,
        expiresAt: row.accessTokenExpiresAt,
      },
      clientId: row.clientId,
      scopes: row.scopes,
    },
  };
}
