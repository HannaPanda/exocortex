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
  /**
   * Upper bound is the largest output window any model in the registry offers,
   * not a policy of ours: asking a provider for more is a request it rejects.
   */
  'ai.maxOutputTokens': z.number().int().min(256).max(200_000).default(4_096),
  /** Limit for a single model answer. A run with tools may take several of these (see `ai.maxRunMs`). */
  'ai.timeoutMs': z.number().int().min(5_000).max(600_000).default(180_000),
  /** Limit for the whole run, across every turn and tool round-trip. Never allowed to undercut `ai.timeoutMs` (see `deriveAiRunTimeouts`). */
  'ai.maxRunMs': z.number().int().min(60_000).max(3_600_000).default(900_000),
  'ai.budgetMicroUsdPerRun': z.number().int().min(1_000).max(50_000_000).default(500_000),
  'ai.toolsEnabled': z.boolean().default(true),
  /** Whether the built-in AI may call tools that change data. */
  'ai.mutatingToolsEnabled': z.boolean().default(true),
  /**
   * Tool round-trips one run may take. Deliberately generous (issue #28): the
   * cost of a long run is already bounded by `ai.budgetMicroUsdPerRun`, checked
   * after every round, and by `ai.maxRunMs`. Those two know money and time; a
   * round counter knows only itself, so a low third brake would just pre-empt
   * the better ones. Reordering a whole page tree genuinely needs hundreds.
   */
  'ai.maxToolIterations': z.number().int().min(0).max(1_000).default(8),
  'ai.visionEnabled': z.boolean().default(true),
  /**
   * Images described before the main answer. Each one is a paid vision call, so
   * the ceiling is high rather than tight and the run budget does the limiting.
   */
  'ai.visionMaxImagesPerRun': z.number().int().min(0).max(64).default(4),
  /**
   * Whether the open page's text is put into the system prompt directly.
   *
   * Default `false`, unlike every other AI switch here: this is the one that
   * sends document content to the provider without the user asking for it in
   * that turn. Off, the model is told which page is open and fetches it with
   * `exo_page_read` when the question needs it -- which is enough for a
   * tool-capable model and keeps the fetch per-question. On, it also gets the
   * text, which is what makes a tool-less model useful at all.
   * See docs/adr/ADR-015-page-content-in-the-prompt.md.
   */
  'ai.pageContextEnabled': z.boolean().default(false),
  /** Hard cap on the characters the open page's text may contribute. */
  'ai.pageContextMaxChars': z.number().int().min(500).max(100_000).default(12_000),
  /**
   * Compaction starts once the prompt passes this share of the context window.
   * Capped below 100 on purpose: at 100 the threshold is only reached once the
   * window has already overflowed, so compaction would never run in time.
   */
  'ai.compactionThresholdPercent': z.number().int().min(30).max(95).default(70),
  /**
   * Messages the compaction leaves untouched at the end of the transcript. A
   * value large enough that the tail alone fills the window turns compaction
   * into a no-op (`compactIfNeeded` logs and skips), which is why the ceiling
   * stays finite even though the useful value depends on the model.
   */
  'ai.compactionKeepRecentMessages': z.number().int().min(2).max(200).default(8),
  /** Model used to write the summary. Null reuses the conversation's model. */
  'ai.compactionModelSlug': z.string().trim().min(1).max(120).nullable().default(null),
  /**
   * Days after which a finished run's prompt and answer text are emptied
   * (issue #10). The metric columns survive it, so the usage history stays
   * complete for as long as the rows do; what goes is the two fat columns,
   * which are the only reason keeping months of runs would be expensive.
   *
   * Zero means "keep the texts for ever", and that is the default: dropping
   * text somebody wrote is not something an update should quietly start doing.
   * The conversation transcript is a separate table and is never touched here.
   */
  'ai.runPayloadRetentionDays': z.number().int().min(0).max(3_650).default(0),
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
  'ai.pdfMaxBytes': z
    .number()
    .int()
    .min(1_024)
    .max(50 * 1_024 * 1_024)
    .default(10 * 1_024 * 1_024),
  /**
   * Generating a page cover from a prompt.
   *
   * Off by default, unlike the read-only AI features: drawing an image is a
   * paid call a deployment should opt into knowingly, and it needs a second,
   * image-capable model that most deployments will not have configured.
   */
  'ai.imageGenerationEnabled': z.boolean().default(false),
  /**
   * Image-capable model, e.g. `google/gemini-2.5-flash-image`. Null means the
   * feature is unavailable however the flag above is set: there is no sensible
   * default here, because the main driver model cannot draw.
   */
  'ai.imageModelSlug': z.string().trim().min(1).max(120).nullable().default(null),
  /**
   * The agents' memory area (issue #34).
   *
   * Off until a workspace is named, and that is the whole switch: without
   * `memory.workspaceId` there is nowhere to write, so `recall` answers from
   * the readable workspaces only and `capture` refuses politely instead of
   * guessing a destination. The area is deliberately *not* the curated brain:
   * automatically written notes must never land in what a human curates.
   */
  'memory.enabled': z.boolean().default(true),
  /** Workspace the agents write their notes into. Null means no capture destination. */
  'memory.workspaceId': z.string().trim().min(8).max(64).nullable().default(null),
  /**
   * Model that turns a session into a handful of bullet points. Null falls
   * back to `ai.compactionModelSlug`, then to `ai.defaultModelSlug`: distilling
   * a transcript is the same kind of work compaction already does, and it
   * should not need a second model to be configured.
   */
  'memory.captureModelSlug': z.string().trim().min(1).max(120).nullable().default(null),
  /**
   * Shortest session worth remembering, in characters of transcript. The cheap
   * half of "what counts as memorable": a two-message session is noise, and
   * noise is what makes recall worse over time. The other half is the model's,
   * which may answer that there is nothing to keep.
   */
  'memory.captureMinChars': z.number().int().min(0).max(100_000).default(600),
  /** Hard ceiling for one recall answer, whatever a caller asks for. */
  'memory.recallMaxChars': z.number().int().min(500).max(50_000).default(6_000),
  /** Hard ceiling for the number of hits in one recall answer. */
  'memory.recallMaxResults': z.number().int().min(1).max(20).default(5),
  /**
   * Days a session note survives in the memory workspace. Zero means "for
   * ever", and that is the default: deleting somebody's notes is not something
   * an update should quietly start doing.
   *
   * The memory area was separated from the curated brain precisely so that this
   * is allowed here (ADR-019). It only ever touches notes under a project page,
   * never the project pages themselves, and never another workspace.
   */
  'memory.retentionDays': z.number().int().min(0).max(3_650).default(0),
  /**
   * Consolidation: turning repeated session notes into distilled facts
   * (issue #46).
   *
   * Off by default, because switching it on means a paid model call per project
   * per night. Once on, a nightly run reads the notes nobody has consolidated
   * yet and decides, per note, whether it confirms, replaces or contradicts
   * something the memory already holds.
   */
  'memory.consolidationEnabled': z.boolean().default(false),
  /**
   * Model that judges notes against existing facts. Null falls back to
   * `memory.captureModelSlug`, then to the compaction and default models: this
   * is the same kind of reading work distillation already does.
   */
  'memory.consolidationModelSlug': z.string().trim().min(1).max(120).nullable().default(null),
  /** Projects one nightly run may work through. Bounds the spend per night. */
  'memory.consolidationProjectsPerRun': z.number().int().min(1).max(100).default(10),
  /** Notes handed to the model in one project's run. */
  'memory.consolidationNotesPerProject': z.number().int().min(1).max(100).default(25),
  /**
   * Half-life of an unconfirmed fact, in days. A fact nobody repeats loses half
   * its ranking weight over this span, then half again. Zero switches the decay
   * off, which leaves a fact from March answering as loudly as one from
   * yesterday.
   *
   * Decay is the whole reason this is not `memory.retentionDays` a second time:
   * age is not the question, "has anybody said this lately" is.
   */
  'memory.factHalfLifeDays': z.number().int().min(0).max(3_650).default(90),
  /**
   * Confidence below which a fact stops being current. It is archived, not
   * deleted: everything in the memory workspace goes through the trash first.
   */
  'memory.factConfidenceFloor': z.number().min(0).max(1).default(0.15),
  /** Facts a recall may put in front of the hits. Kept small; the hits need room. */
  'memory.recallFactLimit': z.number().int().min(0).max(20).default(5),
  /**
   * Semantic search over `document_embedding` (issue #34, AP4).
   *
   * Off by default, because switching it on means every indexed page becomes a
   * paid embedding call. Once on, the search box and `recall` answer from
   * full-text and vector similarity fused together, and a page nobody
   * remembers the words of is findable by what it was about.
   */
  'search.semanticEnabled': z.boolean().default(false),
  /**
   * Embedding model, an OpenRouter slug. Must return 1536 dimensions, which is
   * what the column holds: `openai/text-embedding-3-small` does natively, and
   * the larger `text-embedding-3-large` shortens to it on request. A model that
   * answers with another length is refused rather than stored.
   */
  'search.embeddingModelSlug': z
    .string()
    .trim()
    .min(1)
    .max(120)
    .default('openai/text-embedding-3-small'),
  /**
   * How much the semantic list counts against the full-text list when the two
   * are fused, in percent. Half and half is the honest starting point:
   * full-text is precise when the words match, vectors are what find the page
   * whose words nobody remembers. A percentage rather than a fraction because
   * every number in this schema is an integer an admin types into a plain
   * number field.
   */
  'search.semanticWeightPercent': z.number().int().min(0).max(100).default(50),
  'mcp.enabled': z.boolean().default(true),
  'mcp.maxSearchResults': z.number().int().min(1).max(100).default(20),
  /**
   * Whether the two-step confirmation covers *every* mutating MCP tool.
   *
   * Off by default. The calls nothing undoes (deleting a page for good, a
   * database column, a comment, an account) are confirmed either way; this
   * extends it to ordinary writes as well. That was the behaviour until
   * 2026-08-13, and it earned its retirement: the gate stops no attacker (the
   * second call costs a line of code), its prompt reaches the model rather than
   * a person, and both MCP clients here ask their human before a write anyway.
   * What it did reliably was strand models that reword their Markdown between
   * the two attempts, one of which switched from append to replace mid-loop and
   * overwrote a page.
   */
  'mcp.writeConfirmationRequired': z.boolean().default(false),
  /**
   * Master switch for appointment reminders. Off by default: a deployment that
   * mirrors a calendar has not thereby asked to be messaged about it.
   */
  'calendar.remindersEnabled': z.boolean().default(false),
  /**
   * How long before a timed appointment the reminder goes out. Zero means "when
   * it starts", which is a legitimate choice for somebody who wants the nudge at
   * the door rather than on the way.
   */
  'calendar.reminderLeadMinutes': z.number().int().min(0).max(1_440).default(30),
  /**
   * Local hour at which an all-day appointment is announced. A birthday has no
   * start time to count back from, so counting back from midnight would send the
   * reminder in the middle of the night.
   */
  'calendar.reminderAllDayHour': z.number().int().min(0).max(23).default(9),
  /**
   * The zone the two settings above are read in. An IANA name, validated here so
   * a typo is refused at the boundary instead of throwing inside the worker
   * every minute.
   */
  'calendar.timeZone': z
    .string()
    .trim()
    .min(1)
    .max(64)
    .refine(isUsableTimeZone, { message: 'Unbekannte Zeitzone' })
    .default('Europe/Berlin'),
  /**
   * Takes a `SCHEDULED` snapshot of a page that changed since its last
   * snapshot, on the interval below (issue #20, "Bearbeitungen im Editor
   * verdichten"). Off by default: it is a new, recurring write the deployment
   * has not asked for yet, and it is what feeds session ranges in the
   * Aktivität tab -- without it, a session collapses to the single point
   * `Document.updatedAt` already carries.
   */
  'activity.editSessionSnapshotsEnabled': z.boolean().default(false),
  /**
   * How often `snapshot-active-documents` may take a fresh snapshot of the
   * same page. Also the window a page must have changed within to count as
   * "active" at all, so a page nobody has touched in months is never swept.
   */
  'activity.editSessionSnapshotIntervalMinutes': z.number().int().min(5).max(1_440).default(15),
  /**
   * Every snapshot younger than this is kept, whatever `reason` it has.
   * Below this age, `prune-snapshots` never removes anything.
   */
  'activity.snapshotRetentionFullDays': z.number().int().min(1).max(365).default(7),
  /**
   * Between the full-retention window above and this age, at most one
   * snapshot per calendar day survives (the newest of that day). Older than
   * this, at most one per calendar week survives. `MANUAL` snapshots are
   * exempt from both tiers -- a deliberately named version is never thinned
   * by age alone.
   */
  'activity.snapshotRetentionDailyDays': z.number().int().min(1).max(3_650).default(30),
  /**
   * Computes and logs what tiered retention would delete without deleting
   * anything. Defaults **on**: the first run after this feature ships must
   * not silently remove existing snapshots on a live deployment. Switch off
   * deliberately, once the dry-run log line looks right.
   */
  'activity.snapshotRetentionDryRun': z.boolean().default(true),
});

/** Whether the runtime knows the zone. `Intl` is the only authority available. */
function isUsableTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('de-DE', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}
export type Settings = z.infer<typeof settingsSchema>;

/**
 * The semantic half of search, as the running deployment has it set.
 *
 * Lives here rather than in either composition root because both of them need
 * exactly this reading: the API searches with it and the worker writes with
 * it, and a deployment that embedded under one model and searched under
 * another would return nothing while looking perfectly healthy. `null` is the
 * ordinary "off" answer, not an error: search then behaves as it always did.
 *
 * The return shape is what `HybridSearchAdapter` in `@exocortex/database`
 * declares as `SemanticOptions`; this package cannot import it (contracts is a
 * leaf), so the two are matched structurally at the call sites.
 */
export function semanticSearchOptions(
  settings: Settings,
): { model: string; weight: number } | null {
  if (!settings['search.semanticEnabled']) return null;
  return {
    model: settings['search.embeddingModelSlug'],
    weight: settings['search.semanticWeightPercent'] / 100,
  };
}

export const SETTING_KEYS = Object.keys(settingsSchema.shape) as readonly (keyof Settings)[];
export const settingKeySchema = z.enum(SETTING_KEYS as [keyof Settings, ...(keyof Settings)[]]);
export type SettingKey = z.infer<typeof settingKeySchema>;

/** The inclusive bounds of one numeric setting. */
export interface SettingNumberRange {
  readonly min: number;
  readonly max: number;
}

/**
 * The bounds of every numeric setting, read off `settingsSchema` itself.
 *
 * The admin form needs them twice -- as `min`/`max` on the input, so the
 * browser refuses an out-of-range value before it is ever sent, and as the
 * range printed in the help text. Deriving them here means neither copy can
 * drift from the schema the API actually validates against (issue #27).
 */
export const SETTING_NUMBER_RANGES: Readonly<Partial<Record<SettingKey, SettingNumberRange>>> =
  Object.fromEntries(
    SETTING_KEYS.flatMap((key) => {
      const inner = settingsSchema.shape[key].unwrap();
      if (!(inner instanceof z.ZodNumber)) return [];
      const { minValue, maxValue } = inner;
      if (minValue === null || maxValue === null) return [];
      return [[key, { min: minValue, max: maxValue }] as const];
    }),
  );

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
}): { settings: Settings; invalidKeys: SettingKey[] } {
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

  const invalidKeys: SettingKey[] = [];
  for (const key of Object.keys(candidate)) {
    if (!(SETTING_KEYS as readonly string[]).includes(key)) continue;
    const shape = settingsSchema.shape[key as SettingKey];
    const fieldResult = shape.safeParse(candidate[key]);
    if (!fieldResult.success) {
      // Narrowed by the guard above: only a known key ever gets this far, which
      // is what lets the admin API report these as settings rather than strings.
      invalidKeys.push(key as SettingKey);
      delete candidate[key];
    }
  }

  // Every remaining value has already been validated individually, so this
  // second parse can only fail if `settingsSchema` itself is inconsistent.
  const retried = settingsSchema.parse(candidate);
  return { settings: retried, invalidKeys };
}

export const settingsResponseSchema = z.object({
  settings: settingsSchema,
  /**
   * Stored rows that failed validation and are therefore being ignored, the
   * running deployment using the default in their place.
   *
   * Dropping them rather than throwing is deliberate (see `resolveSettings`): one
   * hand-edited row must never stop a process from booting. But until this list
   * reached the admin area, the only trace was a log line, so the form showed a
   * default while the table held something else and said nothing about it
   * (issue #27). Empty is the ordinary case.
   */
  invalidKeys: z.array(settingKeySchema),
});
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
