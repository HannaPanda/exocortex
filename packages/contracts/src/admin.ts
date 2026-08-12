import { z } from 'zod';

import { idSchema, isoDateTimeSchema } from './primitives';

/**
 * Global (cross-workspace) role. Lowercase on the wire like every other status
 * enum in this package (`aiRunStatusSchema`); the database's `UserRole` enum
 * is uppercase and mapped by the service layer.
 */
export const userRoleSchema = z.enum(['user', 'admin']);
export type UserRole = z.infer<typeof userRoleSchema>;

export const adminUserSchema = z.object({
  id: idSchema,
  email: z.string(),
  name: z.string(),
  role: userRoleSchema,
  emailVerified: z.boolean(),
  workspaceCount: z.number().int().nonnegative(),
  createdAt: isoDateTimeSchema,
  lastSessionAt: isoDateTimeSchema.nullable(),
});
export type AdminUser = z.infer<typeof adminUserSchema>;

export const adminUserListResponseSchema = z.object({ users: z.array(adminUserSchema) });
export type AdminUserListResponse = z.infer<typeof adminUserListResponseSchema>;

export const updateUserRoleRequestSchema = z.object({ role: userRoleSchema });
export type UpdateUserRoleRequest = z.infer<typeof updateUserRoleRequestSchema>;

export const adminOverviewResponseSchema = z.object({
  userCount: z.number().int(),
  adminCount: z.number().int(),
  workspaceCount: z.number().int(),
  documentCount: z.number().int(),
  attachmentCount: z.number().int(),
  aiRunsLast24h: z.number().int(),
  aiCostLast24hMicroUsd: z.number().int(),
  aiModelCount: z.number().int(),
  enabledAiModelCount: z.number().int(),
  apiTokenCount: z.number().int(),
});
export type AdminOverviewResponse = z.infer<typeof adminOverviewResponseSchema>;

/**
 * What an API token is allowed to do. A token is a credential handed to a
 * machine, so it should be able to carry less authority than the person who
 * issued it -- otherwise every leaked token is a full account takeover.
 *
 * The three levels are cumulative and deliberately coarse: a finer grid would
 * have to be re-decided on every new route, and a scope nobody can reason about
 * is a scope nobody sets correctly.
 *
 *   read   - safe requests (GET, HEAD)
 *   write  - additionally creating, changing and deleting content
 *   admin  - additionally the deployment-wide admin API and token management
 */
export const API_TOKEN_SCOPES = ['read', 'write', 'admin'] as const;
export const apiTokenScopeSchema = z.enum(API_TOKEN_SCOPES);
export type ApiTokenScope = z.infer<typeof apiTokenScopeSchema>;

export const apiTokenSchema = z.object({
  id: idSchema,
  name: z.string(),
  prefix: z.string(),
  scopes: z.array(apiTokenScopeSchema),
  lastUsedAt: isoDateTimeSchema.nullable(),
  expiresAt: isoDateTimeSchema.nullable(),
  revokedAt: isoDateTimeSchema.nullable(),
  createdAt: isoDateTimeSchema,
});
export type ApiToken = z.infer<typeof apiTokenSchema>;

export const apiTokenListResponseSchema = z.object({ tokens: z.array(apiTokenSchema) });
export type ApiTokenListResponse = z.infer<typeof apiTokenListResponseSchema>;

export const createApiTokenRequestSchema = z.object({
  name: z.string().trim().min(1).max(80),
  /**
   * At least one scope; the least dangerous one is the default, so a caller who
   * does not think about it gets a read-only token rather than a master key.
   */
  scopes: z.array(apiTokenScopeSchema).min(1).max(API_TOKEN_SCOPES.length).default(['read']),
  /** Days until expiry. Null creates a token that does not expire. */
  expiresInDays: z.number().int().min(1).max(3_650).nullable().default(null),
});
export type CreateApiTokenRequest = z.infer<typeof createApiTokenRequestSchema>;

export const createApiTokenResponseSchema = z.object({
  token: apiTokenSchema,
  /** The raw bearer token. Returned exactly once and never stored in clear. */
  secret: z.string(),
});
export type CreateApiTokenResponse = z.infer<typeof createApiTokenResponseSchema>;

/**
 * An OAuth client a person has connected to their account (ChatGPT and anything
 * else that registers itself remotely). The counterpart of an API token: a token
 * is a secret the person hands out, a connection is a client the person said yes
 * to on `/verbinden`.
 *
 * `name` and `redirectUrls` are whatever the client claimed at registration and
 * are never verified, so the UI must present them as claims -- they exist so a
 * person can recognise the connector they set up, or fail to recognise one they
 * did not.
 */
export const connectedAppSchema = z.object({
  clientId: z.string(),
  name: z.string(),
  redirectUrls: z.array(z.string()),
  /** When this account first said yes to the client. */
  connectedAt: isoDateTimeSchema,
  /**
   * When the client last received or refreshed an access token. Not "last
   * request": tokens are minted and refreshed, not touched per call, so this is
   * the closest honest answer the authorization server can give.
   */
  lastAuthorizedAt: isoDateTimeSchema.nullable(),
  /** Access tokens that have not expired yet, i.e. whether it can act right now. */
  activeTokenCount: z.number().int().nonnegative(),
  disabled: z.boolean(),
});
export type ConnectedApp = z.infer<typeof connectedAppSchema>;

export const connectedAppListResponseSchema = z.object({
  applications: z.array(connectedAppSchema),
});
export type ConnectedAppListResponse = z.infer<typeof connectedAppListResponseSchema>;

export const disconnectAppResponseSchema = z.object({
  disconnected: z.literal(true),
  /**
   * Whether the client row itself was switched off, which happens when no other
   * account still consents to it. False means only this account's tokens and
   * consent were removed.
   */
  clientDisabled: z.boolean(),
});
export type DisconnectAppResponse = z.infer<typeof disconnectAppResponseSchema>;
