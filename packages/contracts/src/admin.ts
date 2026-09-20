import { z } from 'zod';

import { aiRunStatusSchema } from './ai';
import { userRoleSchema } from './auth';
import { idSchema, isoDateTimeSchema } from './primitives';
import { apiTokenPageScopeInputSchema, apiTokenPageScopeSchema } from './shares';

export const adminUserSchema = z.object({
  id: idSchema,
  email: z.string(),
  name: z.string(),
  role: userRoleSchema,
  emailVerified: z.boolean(),
  workspaceCount: z.number().int().nonnegative(),
  createdAt: isoDateTimeSchema,
  lastSessionAt: isoDateTimeSchema.nullable(),
  /**
   * When set, the account exists but may not act. The list shows it rather than
   * hiding the row: a switched-off account is something an administrator has to
   * be able to see and undo, not something that disappears.
   */
  disabledAt: isoDateTimeSchema.nullable(),
  /**
   * Whether anything in the deployment still points at this account as its
   * author. False is what makes outright deletion possible; true means disabling
   * is the only option, and the UI offers only that.
   */
  hasAuthoredContent: z.boolean(),
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
 * The AI usage view (issue #10).
 *
 * Everything below is derived from `ai_run` alone, over a time range the caller
 * picks. The overview above keeps its two 24-hour counters; this is the
 * separate question of what the AI actually costs and how reliably it answers.
 */
export const aiUsageQuerySchema = z.object({
  /** Inclusive lower bound. Defaults to thirty days back. */
  from: isoDateTimeSchema.optional(),
  /** Exclusive upper bound. Defaults to now. */
  to: isoDateTimeSchema.optional(),
});
export type AiUsageQuery = z.infer<typeof aiUsageQuerySchema>;

/**
 * Money, split by where the figure came from.
 *
 * `measured` is what providers reported; `estimated` is what the price list
 * says the rest of the runs cost. They are never added up silently, because a
 * total that mixes the two hides the fact that half of it is arithmetic --
 * and a total made only of `measured` quietly counts unreported runs as free,
 * which is the bug this split exists to prevent.
 */
export const aiUsageCostSchema = z.object({
  measuredMicroUsd: z.number().int().nonnegative(),
  estimatedMicroUsd: z.number().int().nonnegative(),
  /** Runs whose cost the provider reported. */
  measuredRuns: z.number().int().nonnegative(),
  /** Runs priced from the model registry instead. */
  estimatedRuns: z.number().int().nonnegative(),
  /** Runs with usage but no price anywhere -- neither reported nor estimable. */
  unpricedRuns: z.number().int().nonnegative(),
  /**
   * Runs paid for with a workspace's own provider key, and what they cost
   * (issue #52, ADR-023). Subsets of the figures above rather than additions
   * to them: the report still shows one total, and these say how much of it
   * was somebody else's money. Both stay zero on a deployment without BYOK.
   */
  ownKeyRuns: z.number().int().nonnegative(),
  ownKeyMicroUsd: z.number().int().nonnegative(),
});
export type AiUsageCost = z.infer<typeof aiUsageCostSchema>;

export const aiUsageTokensSchema = z.object({
  input: z.number().int().nonnegative(),
  output: z.number().int().nonnegative(),
  /** Subset of `input` the provider served from its prompt cache. */
  cachedInput: z.number().int().nonnegative(),
});
export type AiUsageTokens = z.infer<typeof aiUsageTokensSchema>;

/** Run counts per terminal (and non-terminal) status, all six of them. */
export const aiUsageStatusCountsSchema = z.record(
  aiRunStatusSchema,
  z.number().int().nonnegative(),
);
export type AiUsageStatusCounts = z.infer<typeof aiUsageStatusCountsSchema>;

export const aiUsageModelRowSchema = z.object({
  model: z.string(),
  provider: z.string(),
  /** The registry's display name, or null for a model the registry no longer holds. */
  displayName: z.string().nullable(),
  runs: z.number().int().nonnegative(),
  completedRuns: z.number().int().nonnegative(),
  failedRuns: z.number().int().nonnegative(),
  tokens: aiUsageTokensSchema,
  cost: aiUsageCostSchema,
  /** Milliseconds, over the runs that recorded a duration. Null when none did. */
  medianDurationMs: z.number().int().nonnegative().nullable(),
  toolIterations: z.number().int().nonnegative(),
});
export type AiUsageModelRow = z.infer<typeof aiUsageModelRowSchema>;

export const aiUsageErrorRowSchema = z.object({
  /** Null groups the runs that ended badly without naming a code. */
  errorCode: z.string().nullable(),
  runs: z.number().int().nonnegative(),
  lastSeenAt: isoDateTimeSchema,
});
export type AiUsageErrorRow = z.infer<typeof aiUsageErrorRowSchema>;

export const aiUsageDaySchema = z.object({
  /** Calendar day in the server's timezone, `YYYY-MM-DD`. */
  date: z.string(),
  runs: z.number().int().nonnegative(),
  byStatus: aiUsageStatusCountsSchema,
  costMicroUsd: z.number().int().nonnegative(),
});
export type AiUsageDay = z.infer<typeof aiUsageDaySchema>;

export const aiUsageResponseSchema = z.object({
  from: isoDateTimeSchema,
  to: isoDateTimeSchema,
  runs: z.number().int().nonnegative(),
  byStatus: aiUsageStatusCountsSchema,
  /**
   * Completed runs over runs that reached a terminal status. Cancelled runs
   * are excluded from both halves: somebody pressing stop is not the system
   * failing. Null when nothing finished in the range.
   */
  successRate: z.number().min(0).max(1).nullable(),
  tokens: aiUsageTokensSchema,
  cost: aiUsageCostSchema,
  medianDurationMs: z.number().int().nonnegative().nullable(),
  p95DurationMs: z.number().int().nonnegative().nullable(),
  toolIterations: z.number().int().nonnegative(),
  /** Runs whose prompt and answer the retention sweep has emptied. */
  prunedRuns: z.number().int().nonnegative(),
  byModel: z.array(aiUsageModelRowSchema),
  byErrorCode: z.array(aiUsageErrorRowSchema),
  daily: z.array(aiUsageDaySchema),
});
export type AiUsageResponse = z.infer<typeof aiUsageResponseSchema>;

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
  /**
   * The pages this token may reach, empty when it may reach everything its
   * owner may (issue #83). A second dimension beside `scopes` rather than more
   * values in it: what a credential may *do* and what it may do it *to* are
   * different questions, and folding them together is how a list of verbs ends
   * up carrying page ids.
   */
  pageScopes: z.array(apiTokenPageScopeSchema),
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
  /**
   * Pages this token is confined to (issue #83). An empty list leaves the
   * token as broad as its owner, which is what every token was before scopes
   * existed; naming even one page makes everything else unreachable.
   */
  pageScopes: z.array(apiTokenPageScopeInputSchema).max(20).default([]),
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
  /**
   * Refresh grants that are neither expired nor revoked, i.e. whether the
   * client can still get itself a new access token.
   *
   * Deliberately not a count of access tokens: since better-auth 1.7 those are
   * signed JWTs the server keeps no copy of, so "how many live tokens exist"
   * is a question this deployment cannot answer, and a zero would read as
   * "harmless" when it means "not asked recently".
   */
  activeGrantCount: z.number().int().nonnegative(),
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
