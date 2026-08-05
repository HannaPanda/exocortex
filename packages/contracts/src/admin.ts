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

export const apiTokenSchema = z.object({
  id: idSchema,
  name: z.string(),
  prefix: z.string(),
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
