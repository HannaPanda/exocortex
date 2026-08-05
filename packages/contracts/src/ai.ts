import { z } from 'zod';

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

export const aiMessageRoleSchema = z.enum(['system', 'user', 'assistant']);
export type AiMessageRole = z.infer<typeof aiMessageRoleSchema>;

export const aiMessageSchema = z.object({
  role: aiMessageRoleSchema,
  content: z.string().min(1).max(20_000),
});
export type AiMessage = z.infer<typeof aiMessageSchema>;

export const createAiRunRequestSchema = z.object({
  workspaceId: idSchema,
  /**
   * Optional document context reference. Only the identifier is transmitted:
   * document contents are never forwarded to an external provider in this
   * version (see docs/ai-architecture.md).
   */
  documentId: idSchema.nullable().optional(),
  messages: z.array(aiMessageSchema).min(1).max(40),
  model: z.string().trim().min(1).max(120).optional(),
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
});
export type AiRun = z.infer<typeof aiRunSchema>;

export const createAiRunResponseSchema = z.object({
  run: aiRunSchema,
});
export type CreateAiRunResponse = z.infer<typeof createAiRunResponseSchema>;
