import { z } from 'zod';

/**
 * Runtime settings, stored one row per key in the `setting` table.
 *
 * Every field has a default, so `settingsSchema.parse({})` is the full
 * fallback configuration and an empty table is a valid state. Resolution order
 * is defaults < environment < database (see `resolveSettings`), which is what
 * lets the deployment keep booting from `.env` alone.
 */
export const settingsSchema = z.object({
  'ai.enabled': z.boolean().default(true),
  /** Slug from the `ai_model` registry. Null falls back to the env default. */
  'ai.defaultModelSlug': z.string().trim().min(1).max(120).nullable().default(null),
  /** Prepended to every run's system prompt, before any AI rule pages. */
  'ai.systemPrompt': z.string().max(8_000).default(''),
  'ai.maxOutputTokens': z.number().int().min(256).max(200_000).default(4_096),
  'ai.timeoutMs': z.number().int().min(5_000).max(600_000).default(180_000),
  'ai.budgetMicroUsdPerRun': z.number().int().min(1_000).max(50_000_000).default(500_000),
  'ai.toolsEnabled': z.boolean().default(true),
  /** Whether the built-in AI may call tools that change data. */
  'ai.mutatingToolsEnabled': z.boolean().default(true),
  'ai.maxToolIterations': z.number().int().min(0).max(25).default(8),
  'ai.visionEnabled': z.boolean().default(true),
  'ai.visionMaxImagesPerRun': z.number().int().min(0).max(16).default(4),
  /** Compaction starts once the prompt passes this share of the context window. */
  'ai.compactionThresholdPercent': z.number().int().min(30).max(95).default(70),
  'ai.compactionKeepRecentMessages': z.number().int().min(2).max(40).default(8),
  /** Model used to write the summary. Null reuses the conversation's model. */
  'ai.compactionModelSlug': z.string().trim().min(1).max(120).nullable().default(null),
  'ai.pdfExtractionEnabled': z.boolean().default(true),
  /**
   * Engine used first.
   *
   * `docling` is the default because it is the cheaper and the more capable of
   * the two: it runs in a local container, costs nothing per document, and is
   * the only one that reads scans. `openrouter` is a hosted chat completion
   * that returns the whole document as output tokens, so it costs real money
   * per page and still cannot read a scan. It stays selectable because a
   * deployment without the container needs some way to read a PDF at all.
   *
   * Neither engine reads the PDF's own metadata dictionary as a precondition
   * any more; `createPdfDocumentInfoReader` does that locally either way.
   *
   * Selecting an engine the deployment has not configured leaves extraction
   * unavailable rather than silently using the other one, unless the fallback
   * below is on.
   */
  'ai.pdfExtractor': z.enum(['docling', 'openrouter']).default('docling'),
  /**
   * When the engine above returns nothing (the signature of a scan meeting a
   * text-only engine) or fails, try the other engine before recording a
   * failure. No effect when only one of the two is configured.
   */
  'ai.pdfExtractorFallbackEnabled': z.boolean().default(true),
  /** Model with a PDF file-parser. Null reuses `ai.defaultModelSlug`. */
  'ai.pdfExtractionModelSlug': z.string().trim().min(1).max(120).nullable().default(null),
  'ai.pdfMaxBytes': z.number().int().min(1_024).max(50 * 1_024 * 1_024).default(10 * 1_024 * 1_024),
  'mcp.enabled': z.boolean().default(true),
  'mcp.maxSearchResults': z.number().int().min(1).max(100).default(20),
  /** Two-step confirmation for mutating MCP tools (destination-keyed). */
  'mcp.writeConfirmationRequired': z.boolean().default(true),
});
export type Settings = z.infer<typeof settingsSchema>;

export const SETTING_KEYS = Object.keys(settingsSchema.shape) as readonly (keyof Settings)[];
export const settingKeySchema = z.enum(
  SETTING_KEYS as [keyof Settings, ...(keyof Settings)[]],
);
export type SettingKey = z.infer<typeof settingKeySchema>;

/**
 * Environment variables that seed a setting when its row is absent. The `.env`
 * file stays the bootstrap configuration; the database overrides it at runtime.
 */
export const SETTING_ENV_MAP: Readonly<Partial<Record<SettingKey, string>>> = {
  'ai.defaultModelSlug': 'OPENROUTER_DEFAULT_MODEL',
};

/**
 * Merges defaults, environment and database rows into one validated object.
 *
 * A row whose value fails validation is dropped with the key reported in
 * `invalidKeys` rather than throwing, so one bad hand-edited row can never stop
 * a process from booting.
 */
export function resolveSettings(input: {
  rows: readonly { key: string; value: unknown }[];
  env?: Readonly<Record<string, string | undefined>>;
}): { settings: Settings; invalidKeys: string[] } {
  const candidate: Record<string, unknown> = {};

  for (const [settingKey, envVariable] of Object.entries(SETTING_ENV_MAP)) {
    const envValue = input.env?.[envVariable];
    if (envValue !== undefined && envValue.length > 0) {
      candidate[settingKey] = envValue;
    }
  }

  for (const row of input.rows) {
    if ((SETTING_KEYS as readonly string[]).includes(row.key)) {
      candidate[row.key] = row.value;
    }
  }

  const parsed = settingsSchema.safeParse(candidate);
  if (parsed.success) {
    return { settings: parsed.data, invalidKeys: [] };
  }

  const invalidKeys: string[] = [];
  for (const key of Object.keys(candidate)) {
    if (!(SETTING_KEYS as readonly string[]).includes(key)) continue;
    const shape = settingsSchema.shape[key as SettingKey];
    const fieldResult = shape.safeParse(candidate[key]);
    if (!fieldResult.success) {
      invalidKeys.push(key);
      delete candidate[key];
    }
  }

  // Every remaining value has already been validated individually, so this
  // second parse can only fail if `settingsSchema` itself is inconsistent.
  const retried = settingsSchema.parse(candidate);
  return { settings: retried, invalidKeys };
}

export const settingsResponseSchema = z.object({ settings: settingsSchema });
export type SettingsResponse = z.infer<typeof settingsResponseSchema>;

/**
 * A genuine partial: keys the caller did not send stay absent.
 *
 * `settingsSchema.partial()` cannot be used here. Zod keeps each field's
 * `.default()` inside the resulting optional, so parsing
 * `{ 'ai.maxToolIterations': 6 }` returns all twenty keys filled with their
 * defaults. `SettingsService.update` writes one row per key it receives, so a
 * single edit would materialize every default as an explicit `setting` row and
 * pin `ai.defaultModelSlug` to `null`, silently shadowing
 * `OPENROUTER_DEFAULT_MODEL` -- destroying exactly the defaults < env < database
 * order ADR-013 promises. Unwrapping the default before making the field
 * optional keeps absent keys absent while still validating present values.
 */
type UpdateSettingsShape = {
  [K in SettingKey]: z.ZodOptional<ReturnType<(typeof settingsSchema.shape)[K]['unwrap']>>;
};

// `Object.fromEntries` widens the keys to `string` and collapses the values into
// a union, so the per-key mapping has to be restated for the type system. The
// double assertion is the narrowing TypeScript asks for; `UpdateSettingsShape`
// is derived from `settingsSchema.shape` itself, so it cannot drift from the
// runtime shape built directly above it, and the tests in `settings.test.ts`
// pin the resulting parse behaviour.
const updateSettingsShape = Object.fromEntries(
  SETTING_KEYS.map((key) => [key, settingsSchema.shape[key].unwrap().optional()]),
) as unknown as UpdateSettingsShape;

export const updateSettingsRequestSchema = z.object(updateSettingsShape);
export type UpdateSettingsRequest = z.infer<typeof updateSettingsRequestSchema>;
