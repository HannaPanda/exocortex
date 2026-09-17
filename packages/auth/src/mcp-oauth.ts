import { createLocalJWKSet, type JSONWebKeySet, type JWK, jwtVerify } from 'jose';

import { type PrismaClient } from '@exocortex/database';

import { authIssuer, mcpResourceIdentifier, type VerifiedSession } from './auth';

/**
 * Verification of the access tokens the `@better-auth/mcp` plugin issues.
 *
 * Deliberately done here rather than by calling into the plugin. Every
 * credential the API accepts is verified by the same kind of code, next to
 * `verifyApiToken` and `verifyServiceToken`, instead of one of them hiding
 * inside a plugin whose typing the export map will not let us name (ADR-018).
 *
 * Since better-auth 1.7 an access token is a signed JWT, not a row: the
 * authorization server hands out `at+jwt` tokens bound to a resource audience
 * and keeps no copy of them. So the signature is checked against the public
 * halves of the signing keys in the `jwks` table -- the same rows
 * `/api/auth/jwks` publishes, read directly instead of over HTTP, because this
 * process is the authorization server.
 *
 * Two things the signature alone cannot say are still read from the database:
 * whether the client has since been switched off, and whether the person it
 * was issued for still exists. Both are how a connector is revoked without
 * hunting down every token it holds, so both have to happen on use.
 *
 * What this token is *not*: a session. It authenticates exactly one endpoint,
 * `/api/mcp`. `SessionGuard` never looks at it, so an OAuth token cannot be
 * pointed at the REST API to do things the MCP catalogue does not offer.
 */

export interface VerifiedMcpToken {
  session: VerifiedSession;
  /** `clientId` of the OAuth client the token was issued to. */
  clientId: string;
  /** Space-separated OAuth scopes recorded on the token. */
  scopes: string;
}

export type McpTokenFailure = 'unknown' | 'expired' | 'orphaned' | 'client_disabled';

export type McpTokenVerification =
  | { valid: true; token: VerifiedMcpToken }
  | { valid: false; reason: McpTokenFailure };

export interface VerifyMcpAccessTokenOptions {
  prisma: PrismaClient;
  /** The raw bearer value presented at `/api/mcp`. */
  accessToken: string;
  /** Public origin of the application, e.g. `https://exocortex.app`. */
  appUrl: string;
}

/** The `typ` header RFC 9068 gives an OAuth 2.0 JWT access token. */
const ACCESS_TOKEN_TYPE = 'at+jwt';

/**
 * Builds the key set the way `/api/auth/jwks` builds its response: the `kid` is
 * the row id, and `alg` and `crv` fall back to the columns beside the key
 * because better-auth stores them separately from the serialized JWK.
 *
 * Retired keys are kept. A key stops being used for signing the moment it
 * expires, but the tokens it already signed run for another hour, so dropping
 * it here would reject perfectly good tokens for as long as a rotation takes to
 * settle.
 */
export async function readLocalJwks(prisma: PrismaClient): Promise<JSONWebKeySet> {
  const rows = await prisma.jwks.findMany({
    select: { id: true, publicKey: true, alg: true, crv: true },
  });
  const keys: JWK[] = [];
  for (const row of rows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.publicKey);
    } catch {
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null) continue;
    keys.push({
      ...(row.alg === null ? {} : { alg: row.alg }),
      ...(row.crv === null ? {} : { crv: row.crv }),
      ...(parsed as JWK),
      kid: row.id,
    });
  }
  return { keys };
}

export interface McpAccessTokenClaims {
  subject: string;
  clientId: string;
  scopes: string;
  expiresAt: Date;
}

/**
 * Checks signature, issuer, audience, type and expiry, and pulls out the three
 * claims this deployment acts on.
 *
 * Separate from the database half on purpose: this is the part with the
 * cryptography in it, and it can be exercised against a key pair made on the
 * spot rather than against rows in a shared database.
 */
export async function readMcpAccessTokenClaims(
  jwks: JSONWebKeySet,
  accessToken: string,
  appUrl: string,
): Promise<McpAccessTokenClaims | 'invalid' | 'expired'> {
  if (jwks.keys.length === 0) return 'invalid';

  let payload;
  try {
    ({ payload } = await jwtVerify(accessToken, createLocalJWKSet(jwks), {
      issuer: authIssuer(appUrl),
      audience: mcpResourceIdentifier(appUrl),
      typ: ACCESS_TOKEN_TYPE,
    }));
  } catch (error) {
    // `jose` reports an expired token with its own error code. Telling it
    // apart matters: a connector that is told "expired" refreshes, and one
    // that is told "invalid" starts the whole authorization dance again.
    const code = (error as { code?: unknown }).code;
    return code === 'ERR_JWT_EXPIRED' ? 'expired' : 'invalid';
  }

  const { sub, client_id: clientId, scope, exp } = payload;
  if (typeof sub !== 'string' || sub === '') return 'invalid';
  if (typeof clientId !== 'string' || clientId === '') return 'invalid';
  if (typeof exp !== 'number') return 'invalid';
  return {
    subject: sub,
    clientId,
    scopes: typeof scope === 'string' ? scope : '',
    expiresAt: new Date(exp * 1000),
  };
}

export async function verifyMcpAccessToken(
  options: VerifyMcpAccessTokenOptions,
): Promise<McpTokenVerification> {
  const { prisma, accessToken, appUrl } = options;

  const claims = await readMcpAccessTokenClaims(
    await readLocalJwks(prisma),
    accessToken,
    appUrl,
  );
  if (claims === 'invalid') return { valid: false, reason: 'unknown' };
  if (claims === 'expired') return { valid: false, reason: 'expired' };

  // Turning a client off is how a connector is revoked without hunting down
  // every token it holds, so the check has to happen on use, not only on issue.
  const client = await prisma.oauthClient.findUnique({
    where: { clientId: claims.clientId },
    select: { disabled: true },
  });
  if (client === null || client.disabled === true) {
    return { valid: false, reason: 'client_disabled' };
  }

  // A client-credentials grant would put the client id in `sub` and authorize
  // nobody. This deployment issues no such grant, so a subject that is not a
  // user is a token that must not resolve to some default account.
  const user = await prisma.user.findUnique({
    where: { id: claims.subject },
    select: { id: true, email: true, name: true, emailVerified: true, disabledAt: true },
  });
  if (user === null || user.disabledAt !== null) return { valid: false, reason: 'orphaned' };

  return {
    valid: true,
    token: {
      session: {
        userId: user.id,
        sessionId: `mcp:${claims.clientId}`,
        email: user.email,
        name: user.name,
        emailVerified: user.emailVerified,
        expiresAt: claims.expiresAt,
      },
      clientId: claims.clientId,
      scopes: claims.scopes,
    },
  };
}
