import { z } from 'zod';

import { idSchema, isoDateTimeSchema } from './primitives';

export const aiReasoningLevelSchema = z.enum([
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);
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

export const createAiModelRequestSchema = aiModelSchema.omit({ id: true, syncedAt: true }).partial({
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

/**
 * One model the provider currently offers, mapped onto the registry's shape.
 *
 * The catalogue exists so a model can be registered by picking it instead of by
 * typing ten fields that the provider already knows.
 */
export const aiModelCatalogEntrySchema = z.object({
  slug: z.string(),
  displayName: z.string(),
  description: z.string().nullable(),
  /**
   * The model an alias entry (`~z-ai/glm-latest`) currently resolves to, `null`
   * for an ordinary one. The figures above then describe the target, not the
   * alias row: that row carries the cheapest endpoint's numbers.
   */
  aliasTargetSlug: z.string().nullable(),
  contextWindowTokens: z.number().int().nonnegative(),
  maxOutputTokens: z.number().int().positive().nullable(),
  supportsVision: z.boolean(),
  supportsTools: z.boolean(),
  reasoningLevels: z.array(aiReasoningLevelSchema),
  inputMicroUsdPerMTok: z.number().int().nonnegative(),
  outputMicroUsdPerMTok: z.number().int().nonnegative(),
  /** True when the registry already has a row for this slug, enabled or not. */
  registered: z.boolean(),
});
export type AiModelCatalogEntry = z.infer<typeof aiModelCatalogEntrySchema>;

export const aiModelCatalogResponseSchema = z.object({
  entries: z.array(aiModelCatalogEntrySchema),
  /** When the provider list behind this answer was fetched. */
  fetchedAt: isoDateTimeSchema,
});
export type AiModelCatalogResponse = z.infer<typeof aiModelCatalogResponseSchema>;

export const addAiModelsFromCatalogRequestSchema = z.object({
  slugs: z.array(z.string().trim().min(1).max(120)).min(1).max(50),
  /** Whether the new rows appear in the picker right away. */
  enabled: z.boolean().default(true),
});
export type AddAiModelsFromCatalogRequest = z.infer<typeof addAiModelsFromCatalogRequestSchema>;

export const addAiModelsFromCatalogResponseSchema = z.object({
  added: z.array(aiModelSchema),
  /** Slugs the registry already knew, or that the provider no longer offers. */
  skipped: z.array(z.string()),
});
export type AddAiModelsFromCatalogResponse = z.infer<typeof addAiModelsFromCatalogResponseSchema>;

export const syncAiModelsResponseSchema = z.object({
  updated: z.array(z.string()),
  added: z.array(z.string()),
  disabled: z.array(z.string()),
  unchanged: z.number().int().nonnegative(),
});
export type SyncAiModelsResponse = z.infer<typeof syncAiModelsResponseSchema>;

/** Ascending strength of the thinking levels. `none` is the floor. */
export const REASONING_LEVEL_RANK: Record<AiReasoningLevel, number> = {
  none: 0,
  minimal: 1,
  low: 2,
  medium: 3,
  high: 4,
  xhigh: 5,
  max: 6,
};

/**
 * Clamps a requested thinking level to what a model actually offers.
 *
 * Shared by the API (which decides what the provider is asked for) and the
 * browser (which decides what the picker shows): a remembered `high` must not
 * appear as the selected value on a model that cannot think at all.
 */
export function clampReasoningLevel(
  available: readonly AiReasoningLevel[],
  requested: AiReasoningLevel,
): AiReasoningLevel {
  if (available.includes(requested)) return requested;

  const requestedRank = REASONING_LEVEL_RANK[requested];
  let best: AiReasoningLevel = 'none';
  for (const level of available) {
    if (
      REASONING_LEVEL_RANK[level] <= requestedRank &&
      REASONING_LEVEL_RANK[level] > REASONING_LEVEL_RANK[best]
    ) {
      best = level;
    }
  }
  return best;
}

/**
 * Display names for the vendors whose spelling is not a capitalisation of their
 * slug segment. Everything else goes through `titleCaseVendor`, so an unknown
 * vendor still reads as a name instead of a slug fragment.
 */
const VENDOR_LABELS: Record<string, string> = {
  ai21: 'AI21 Labs',
  'meta-llama': 'Meta',
  mistralai: 'Mistral AI',
  moonshotai: 'Moonshot AI',
  nousresearch: 'Nous Research',
  nvidia: 'NVIDIA',
  openai: 'OpenAI',
  openrouter: 'OpenRouter',
  'x-ai': 'xAI',
  'z-ai': 'Z.ai',
};

function titleCaseVendor(vendor: string): string {
  return vendor
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

/**
 * The vendor segment of a model slug: `openai/gpt-5` is served by OpenRouter but
 * made by OpenAI, and that is the distinction a picker groups by.
 *
 * Deliberately derived rather than stored. `AiModel.provider` already means
 * something else (which provider serves the model, `openrouter` or `mock`), and
 * a second column would be one more field to fill in by hand -- the thing this
 * is meant to save. A slug without a `/` is its own vendor.
 */
export function aiModelVendor(slug: string): string {
  const separatorIndex = slug.indexOf('/');
  return separatorIndex === -1 ? slug : slug.slice(0, separatorIndex);
}

/** The vendor's name as a human writes it. */
export function aiModelVendorLabel(slug: string): string {
  const vendor = aiModelVendor(slug);
  return VENDOR_LABELS[vendor] ?? titleCaseVendor(vendor);
}

/**
 * Groups models by vendor, keeping the order the caller passed in: the registry
 * is sorted by `sortOrder`, and a group appears where its first model does.
 */
export function groupAiModelsByVendor<TModel extends { slug: string }>(
  models: readonly TModel[],
): { vendor: string; label: string; models: TModel[] }[] {
  const groups = new Map<string, { vendor: string; label: string; models: TModel[] }>();
  for (const model of models) {
    const vendor = aiModelVendor(model.slug);
    const group = groups.get(vendor);
    if (group === undefined) {
      groups.set(vendor, { vendor, label: aiModelVendorLabel(model.slug), models: [model] });
      continue;
    }
    group.models.push(model);
  }
  return [...groups.values()];
}
