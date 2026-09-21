import { z } from 'zod';

import { aiReasoningLevelSchema } from './ai-models';
import { idSchema, isoDateTimeSchema } from './primitives';

export const aiRunStatusSchema = z.enum([
  'pending',
  'running',
  'completed',
  'failed',
  'cancelled',
  'timed_out',
]);
export type AiRunStatus = z.infer<typeof aiRunStatusSchema>;

/**
 * What a run is busy with while it produces no text (issue #6).
 *
 * `reasoning` and `compacting` are the two phases that used to look exactly
 * like a stalled run from the outside: reasoning tokens are dropped by the
 * provider adapter and never become deltas, and compaction only reports
 * itself once it is over (`ai.conversation.compacted`). `generating` ends
 * either of them again, so a client never has to guess when a named silence
 * stopped.
 */
export const aiRunPhaseSchema = z.enum(['reasoning', 'compacting', 'generating']);
export type AiRunPhase = z.infer<typeof aiRunPhaseSchema>;

/** Widened from `['system', 'user', 'assistant']` to support the tool loop. */
export const aiMessageRoleSchema = z.enum(['system', 'user', 'assistant', 'tool']);
export type AiMessageRole = z.infer<typeof aiMessageRoleSchema>;

export const aiMessageSchema = z.object({
  role: aiMessageRoleSchema,
  // Empty string is allowed: an assistant turn that only calls tools has no text.
  content: z.string().max(20_000),
  toolCallId: z.string().optional(),
  toolName: z.string().optional(),
  /** Assistant tool-call requests, provider-shaped and only passed through. */
  toolCalls: z.unknown().optional(),
});
export type AiMessage = z.infer<typeof aiMessageSchema>;

export const createAiRunRequestSchema = z.object({
  workspaceId: idSchema,
  /**
   * Optional document context reference. Only the identifier is transmitted
   * over this API: the worker resolves it server-side. Its images may be sent
   * to a configured vision model as a result (ADR-012); its text is not sent
   * anywhere (see docs/ai-architecture.md).
   */
  documentId: idSchema.nullable().optional(),
  // Raised from 40 to 200: tool turns multiply the message count.
  messages: z.array(aiMessageSchema).min(1).max(200),
  model: z.string().trim().min(1).max(120).optional(),
  conversationId: idSchema.nullable().optional(),
  reasoningLevel: aiReasoningLevelSchema.optional(),
  /** 'off' disables the vision companion for this run. */
  visionCompanionSlug: z.string().trim().min(1).max(120).optional(),
  toolsEnabled: z.boolean().optional(),
});
export type CreateAiRunRequest = z.infer<typeof createAiRunRequestSchema>;

export const aiUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative(),
  provider: z.string(),
  model: z.string(),
  /** Provider cost in the smallest currency unit, when reported. */
  providerCostMicroUsd: z.number().int().nonnegative().nullable(),
  durationMs: z.number().int().nonnegative(),
});
export type AiUsage = z.infer<typeof aiUsageSchema>;

export const aiRunSchema = z.object({
  id: idSchema,
  workspaceId: idSchema,
  documentId: idSchema.nullable(),
  status: aiRunStatusSchema,
  provider: z.string(),
  model: z.string(),
  createdById: idSchema,
  createdAt: isoDateTimeSchema,
  startedAt: isoDateTimeSchema.nullable(),
  /** Last sign of life from the worker while the run is `running` (issue #16). */
  heartbeatAt: isoDateTimeSchema.nullable(),
  finishedAt: isoDateTimeSchema.nullable(),
  usage: aiUsageSchema.nullable(),
  errorCode: z.string().nullable(),
  /**
   * What went wrong, said to the person rather than to the log (issue #118,
   * ADR-059).
   *
   * German, several sentences, and written to stand on its own: for
   * `ai_tool_limit_exceeded` it names the tools the run spent its calls on,
   * how many of those calls answered nothing new, and the way in that would
   * have worked. `null` wherever the code alone is the whole story.
   */
  errorDetail: z.string().nullable(),
  /**
   * The answer as the worker has it so far. Complete once the run reached a
   * terminal status, and the authoritative text *while* it is still running:
   * the worker renews it with every heartbeat, so a client that noticed a gap
   * in `ai.run.progress` can reload the answer instead of showing the
   * incomplete text it stitched together from deltas (issue #6).
   */
  resultText: z.string().nullable(),
  conversationId: idSchema.nullable(),
  reasoningLevel: aiReasoningLevelSchema,
  toolIterations: z.number().int().nonnegative(),
  /** Calls made, where `toolIterations` counts the rounds they arrived in. */
  toolCalls: z.number().int().nonnegative(),
  /**
   * What this run was offered, and what that weighed (issue #121).
   *
   * The built-in loop is handed the tool domains its task needs rather than
   * the whole catalogue, and this is what makes that visible per run: how many
   * tools the request carried, how many characters of JSON schema that was,
   * and which domains they came from. `null` for a run that was offered no
   * tools, and for every run from before the measurement existed.
   */
  toolsOffered: z.number().int().nonnegative().nullable(),
  toolSchemaChars: z.number().int().nonnegative().nullable(),
  toolDomains: z.array(z.string()),
});
export type AiRun = z.infer<typeof aiRunSchema>;

export const createAiRunResponseSchema = z.object({
  run: aiRunSchema,
});
export type CreateAiRunResponse = z.infer<typeof createAiRunResponseSchema>;
