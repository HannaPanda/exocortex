import { z } from 'zod';

import { idSchema, isoDateTimeSchema } from './primitives';

export const aiReasoningLevelSchema = z.enum(['none', 'minimal', 'low', 'medium', 'high']);
export type AiReasoningLevel = z.infer<typeof aiReasoningLevelSchema>;

export const aiModelSchema = z.object({
  id: idSchema,
  slug: z.string(),
  provider: z.string(),
  displayName: z.string(),
  description: z.string().nullable(),
  contextWindowTokens: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive().nullable(),
  supportsVision: z.boolean(),
  supportsTools: z.boolean(),
  reasoningLevels: z.array(aiReasoningLevelSchema),
  inputMicroUsdPerMTok: z.number().int().nonnegative(),
  outputMicroUsdPerMTok: z.number().int().nonnegative(),
  /** Slug of the vision companion, resolved from the relation. */
  visionCompanionSlug: z.string().nullable(),
  enabled: z.boolean(),
  sortOrder: z.number().int(),
  syncedAt: isoDateTimeSchema.nullable(),
});
export type AiModel = z.infer<typeof aiModelSchema>;

export const aiModelListResponseSchema = z.object({
  models: z.array(aiModelSchema),
  /** Slug the server would use when a request omits `model`. */
  defaultModelSlug: z.string().nullable(),
});
export type AiModelListResponse = z.infer<typeof aiModelListResponseSchema>;

export const createAiModelRequestSchema = aiModelSchema
  .omit({ id: true, syncedAt: true })
  .partial({
    provider: true,
    description: true,
    enabled: true,
    sortOrder: true,
    visionCompanionSlug: true,
    reasoningLevels: true,
    maxOutputTokens: true,
  });
export type CreateAiModelRequest = z.infer<typeof createAiModelRequestSchema>;

export const updateAiModelRequestSchema = createAiModelRequestSchema.partial();
export type UpdateAiModelRequest = z.infer<typeof updateAiModelRequestSchema>;

export const syncAiModelsRequestSchema = z.object({
  /** Restrict the sync to these slugs. Empty syncs every registry row. */
  slugs: z.array(z.string().trim().min(1).max(120)).max(100).default([]),
  /** Add slugs the registry does not know yet instead of only refreshing. */
  addMissing: z.boolean().default(false),
});
export type SyncAiModelsRequest = z.infer<typeof syncAiModelsRequestSchema>;

export const syncAiModelsResponseSchema = z.object({
  updated: z.array(z.string()),
  added: z.array(z.string()),
  disabled: z.array(z.string()),
  unchanged: z.number().int().nonnegative(),
});
export type SyncAiModelsResponse = z.infer<typeof syncAiModelsResponseSchema>;
