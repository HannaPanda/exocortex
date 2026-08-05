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
  finishedAt: isoDateTimeSchema.nullable(),
  usage: aiUsageSchema.nullable(),
  errorCode: z.string().nullable(),
  conversationId: idSchema.nullable(),
  reasoningLevel: aiReasoningLevelSchema,
  toolIterations: z.number().int().nonnegative(),
});
export type AiRun = z.infer<typeof aiRunSchema>;

export const createAiRunResponseSchema = z.object({
  run: aiRunSchema,
});
export type CreateAiRunResponse = z.infer<typeof createAiRunResponseSchema>;
