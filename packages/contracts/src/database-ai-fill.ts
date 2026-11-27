import { z } from 'zod';

import { aiRunStatusSchema } from './ai';
import { type DatabasePropertyType, type DatabaseRowPropertyValue } from './database-views';
import { idSchema, isoDateTimeSchema } from './primitives';
import { instantFromIsoInput } from './zoned-time';

/**
 * A database column that a model fills in (issue #237, ADR-099), the way
 * Notion's "AI autofill" does: a column carries an instruction, a preset or
 * its own words, and a person, an agent or the column itself asks for cells to
 * be filled from what each row holds.
 *
 * Three rules shape everything here:
 *
 *   - A fill is one completion per cell and no tools. Whatever the model read,
 *     an uploaded PDF included, can only ever become the value of that one
 *     cell, and that value is checked against the column's type before it is
 *     written (`coerceAiFillAnswer`).
 *   - Nothing is overwritten unless the request said so (`mode`), and a value
 *     a fill wrote carries the run that wrote it until anybody else writes the
 *     cell.
 *   - Every batch is an `ai_run` of kind `fill`, paid for with the workspace's
 *     key and counted in the usage report like any run.
 */

/** Column types a model can fill. Files, relations and computed columns cannot be. */
export const AI_FILLABLE_PROPERTY_TYPES = [
  'TEXT',
  'NUMBER',
  'SELECT',
  'MULTI_SELECT',
  'DATE',
  'CHECKBOX',
  'URL',
  'EMAIL',
  'PHONE',
  'PERSON',
] as const satisfies readonly DatabasePropertyType[];
export type AiFillablePropertyType = (typeof AI_FILLABLE_PROPERTY_TYPES)[number];

export function isAiFillableType(type: DatabasePropertyType): type is AiFillablePropertyType {
  return (AI_FILLABLE_PROPERTY_TYPES as readonly DatabasePropertyType[]).includes(type);
}

export const AI_FILL_PRESETS = [
  'summary',
  'key_points',
  'tags',
  'translate',
  'document_date',
  'sender',
  'recipient',
  'custom',
] as const;
export const aiFillPresetSchema = z.enum(AI_FILL_PRESETS);
export type AiFillPreset = z.infer<typeof aiFillPresetSchema>;

/** Which column types each preset makes sense for. `custom` fits every fillable type. */
export const AI_FILL_PRESET_TYPES: Record<AiFillPreset, readonly AiFillablePropertyType[]> = {
  summary: ['TEXT'],
  key_points: ['TEXT'],
  tags: ['SELECT', 'MULTI_SELECT'],
  translate: ['TEXT'],
  document_date: ['DATE'],
  sender: ['TEXT', 'PERSON', 'EMAIL'],
  recipient: ['TEXT', 'PERSON', 'EMAIL'],
  custom: AI_FILLABLE_PROPERTY_TYPES,
};

export function presetsForType(type: DatabasePropertyType): AiFillPreset[] {
  if (!isAiFillableType(type)) return [];
  return AI_FILL_PRESETS.filter((preset) => AI_FILL_PRESET_TYPES[preset].includes(type));
}

/**
 * When a column fills itself (issue #237). `off` is the default and the only
 * value nobody has to decide on: an automatic run is a standing decision.
 * `on_change` includes `on_create`.
 */
export const AI_AUTO_FILL = ['off', 'on_create', 'on_change'] as const;
export const aiAutoFillSchema = z.enum(AI_AUTO_FILL);
export type AiAutoFill = z.infer<typeof aiAutoFillSchema>;

/**
 * Which cells a batch may write. `empty_only` is the default, `replace_ai`
 * also renews values a fill wrote that nobody changed since, `replace_all`
 * overwrites a person's value too and is what a confirmation in the browser
 * stands for.
 */
export const AI_FILL_MODES = ['empty_only', 'replace_ai', 'replace_all'] as const;
export const aiFillModeSchema = z.enum(AI_FILL_MODES);
export type AiFillMode = z.infer<typeof aiFillModeSchema>;

export const AI_FILL_ORIGINS = ['manual', 'automatic'] as const;
export const aiFillOriginSchema = z.enum(AI_FILL_ORIGINS);
export type AiFillOrigin = z.infer<typeof aiFillOriginSchema>;

/** The longest instruction a column may carry. */
export const AI_FILL_INSTRUCTION_MAX = 4_000;

/** A column's AI instruction as every reader sees it. */
export const databasePropertyAiSchema = z.object({
  preset: aiFillPresetSchema,
  /** The whole instruction for `custom`; for a preset, what is added to it. */
  instruction: z.string().nullable(),
  /** `translate` only. */
  targetLanguage: z.string().nullable(),
  /** SELECT and MULTI_SELECT only: whether an answer may add an option. */
  allowNewOptions: z.boolean(),
  useContent: z.boolean(),
  useProperties: z.boolean(),
  useAttachments: z.boolean(),
  autoFill: aiAutoFillSchema,
  updatedById: idSchema.nullable(),
  updatedAt: isoDateTimeSchema,
});
export type DatabasePropertyAi = z.infer<typeof databasePropertyAiSchema>;

/**
 * Sets or changes a column's AI instruction. A field left out keeps what the
 * column says already, so switching `autoFill` on names nothing else; a
 * column without an instruction needs at least the `preset`.
 */
export const setDatabasePropertyAiRequestSchema = z.object({
  preset: aiFillPresetSchema.optional(),
  instruction: z.string().trim().max(AI_FILL_INSTRUCTION_MAX).nullable().optional(),
  targetLanguage: z.string().trim().max(60).nullable().optional(),
  allowNewOptions: z.boolean().optional(),
  useContent: z.boolean().optional(),
  useProperties: z.boolean().optional(),
  useAttachments: z.boolean().optional(),
  autoFill: aiAutoFillSchema.optional(),
});
export type SetDatabasePropertyAiRequest = z.infer<typeof setDatabasePropertyAiRequestSchema>;

/** Why an instruction cannot be stored on a column, as a code (`details.reason`). */
export const AI_FILL_CONFIG_PROBLEMS = [
  'type_unsupported',
  'preset_type',
  'instruction_required',
  'language_required',
  'options_type',
  'no_source',
] as const;
export type AiFillConfigProblem = (typeof AI_FILL_CONFIG_PROBLEMS)[number];

/**
 * What is wrong with an instruction for a column of `type`, or nothing. One
 * function for the API, which refuses, and the browser, which says so before
 * anybody presses save.
 */
export function aiFillConfigProblems(
  type: DatabasePropertyType,
  config: Pick<
    SetDatabasePropertyAiRequest,
    'instruction' | 'targetLanguage' | 'allowNewOptions'
  > & {
    preset: AiFillPreset;
    useContent: boolean;
    useProperties: boolean;
    useAttachments: boolean;
  },
): AiFillConfigProblem[] {
  if (!isAiFillableType(type)) return ['type_unsupported'];
  const problems: AiFillConfigProblem[] = [];
  if (!AI_FILL_PRESET_TYPES[config.preset].includes(type)) problems.push('preset_type');
  if (config.preset === 'custom' && (config.instruction ?? '').trim().length === 0) {
    problems.push('instruction_required');
  }
  if (config.preset === 'translate' && (config.targetLanguage ?? '').trim().length === 0) {
    problems.push('language_required');
  }
  if (config.allowNewOptions === true && type !== 'SELECT' && type !== 'MULTI_SELECT') {
    problems.push('options_type');
  }
  if (!config.useContent && !config.useProperties && !config.useAttachments) {
    problems.push('no_source');
  }
  return problems;
}

/**
 * The instruction the model reads, from a preset and the person's words. German
 * like the rest of what the built-in AI is told; the answer follows the
 * material's language unless the instruction names another.
 */
export function aiFillInstructionText(config: {
  preset: AiFillPreset;
  instruction: string | null;
  targetLanguage: string | null;
}): string {
  const extra = (config.instruction ?? '').trim();
  const base = PRESET_INSTRUCTIONS[config.preset](config.targetLanguage?.trim() ?? '');
  if (base.length === 0) return extra;
  return extra.length === 0 ? base : `${base}\n\nZusätzlich: ${extra}`;
}

const PRESET_INSTRUCTIONS: Record<AiFillPreset, (language: string) => string> = {
  summary: () =>
    'Fasse zusammen, worum es in diesem Eintrag geht, in zwei bis drei Sätzen. Nenne das ' +
    'Wesentliche, keine Einleitung.',
  key_points: () =>
    'Nenne die wichtigsten Punkte dieses Eintrags als kurze Stichpunkte, höchstens fünf, ' +
    'jeder in einer eigenen Zeile mit "- " davor.',
  tags: () => 'Wähle die Optionen, die zu diesem Eintrag passen. Nimm nur, was wirklich zutrifft.',
  translate: (language) =>
    `Übersetze den Inhalt dieses Eintrags ins ${language.length > 0 ? language : 'Englische'}. ` +
    'Ist er kurz, übersetze ihn vollständig, sonst seinen Kern in wenigen Sätzen.',
  document_date: () =>
    'Bestimme das maßgebliche Datum des Dokuments: bei einem Brief das Briefdatum, bei einer ' +
    'Rechnung das Rechnungsdatum, sonst das Datum, auf das sich der Inhalt bezieht.',
  sender: () =>
    'Bestimme, wer das Dokument geschickt oder verfasst hat: eine Person oder eine ' +
    'Organisation, so wie sie im Dokument genannt ist.',
  recipient: () =>
    'Bestimme, an wen das Dokument gerichtet ist: eine Person oder eine Organisation, so wie ' +
    'sie im Dokument genannt ist.',
  custom: () => '',
};

// ---------------------------------------------------------------------------
// Runs and cells
// ---------------------------------------------------------------------------

/** A batch may name at most this many rows, whatever the setting says. */
export const AI_FILL_MAX_ROWS_CEILING = 500;

export const AI_FILL_CELL_STATUSES = [
  'queued',
  'running',
  'filled',
  'empty',
  'skipped',
  'failed',
  'cancelled',
] as const;
export const aiFillCellStatusSchema = z.enum(AI_FILL_CELL_STATUSES);
export type AiFillCellStatus = z.infer<typeof aiFillCellStatusSchema>;

/**
 * Why a cell failed or was skipped. Codes, never sentences: every reader words
 * them in its own language (the `database.aiFill.errors` messages).
 */
export const AI_FILL_CELL_ERROR_CODES = [
  /** The model call failed. */
  'model_failed',
  /** The provider refused the key that pays (401/402). */
  'key_refused',
  /** The workspace's own key cannot be read (ADR-091). */
  'key_unreadable',
  /** The answer was not the JSON it was asked for. */
  'answer_unreadable',
  /** The answer does not fit the column's type. */
  'answer_invalid',
  /** The answer named an option the column does not have, and none may be added. */
  'option_unknown',
  /** A new option was wanted, but the material was foreign (ADR-030, ADR-096). */
  'option_untrusted',
  /** A new option was wanted, but the requester may not change the columns. */
  'option_forbidden',
  /** The answer named somebody who is not a member of the workspace. */
  'person_unknown',
  /** The row is gone, or the requester can no longer read it. */
  'row_unavailable',
  /** The requester may not change the row. */
  'forbidden',
  /** Skipped: the cell has a value and the mode keeps it. */
  'not_empty',
  /** Skipped: the cell holds a person's value and the mode keeps it. */
  'not_ai_value',
  /** The run's budget ran out before this cell. */
  'budget_exceeded',
  /** The run's time ran out before this cell. */
  'timed_out',
  /** The run ended before this cell, for another reason. */
  'run_ended',
] as const;
export const aiFillCellErrorCodeSchema = z.enum(AI_FILL_CELL_ERROR_CODES);
export type AiFillCellErrorCode = z.infer<typeof aiFillCellErrorCodeSchema>;

export const startAiFillRequestSchema = z.object({
  propertyId: idSchema,
  /** The rows to fill; absent means every row of the database. */
  rowIds: z.array(idSchema).min(1).max(AI_FILL_MAX_ROWS_CEILING).optional(),
  mode: aiFillModeSchema.default('empty_only'),
  /** Counts what would be filled and starts nothing. */
  dryRun: z.boolean().default(false),
});
export type StartAiFillRequest = z.input<typeof startAiFillRequestSchema>;

export const aiFillCountsSchema = z.object({
  total: z.number().int().nonnegative(),
  queued: z.number().int().nonnegative(),
  running: z.number().int().nonnegative(),
  filled: z.number().int().nonnegative(),
  empty: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  cancelled: z.number().int().nonnegative(),
});
export type AiFillCounts = z.infer<typeof aiFillCountsSchema>;

export const aiFillRunSchema = z.object({
  id: idSchema,
  databaseId: idSchema,
  propertyId: idSchema,
  propertyName: z.string(),
  mode: aiFillModeSchema,
  origin: aiFillOriginSchema,
  status: aiRunStatusSchema,
  errorCode: z.string().nullable(),
  createdById: idSchema,
  model: z.string(),
  createdAt: isoDateTimeSchema,
  startedAt: isoDateTimeSchema.nullable(),
  finishedAt: isoDateTimeSchema.nullable(),
  counts: aiFillCountsSchema,
  /** Reported, or estimated from the registry's prices when nothing was reported. */
  costMicroUsd: z.number().int().nonnegative().nullable(),
  usedOwnKey: z.boolean(),
});
export type AiFillRun = z.infer<typeof aiFillRunSchema>;

export const aiFillCellSchema = z.object({
  id: idSchema,
  rowId: idSchema,
  rowTitle: z.string(),
  status: aiFillCellStatusSchema,
  errorCode: aiFillCellErrorCodeSchema.nullable(),
  finishedAt: isoDateTimeSchema.nullable(),
});
export type AiFillCell = z.infer<typeof aiFillCellSchema>;

export const aiFillRunDetailSchema = aiFillRunSchema.extend({ cells: z.array(aiFillCellSchema) });
export type AiFillRunDetail = z.infer<typeof aiFillRunDetailSchema>;

export const aiFillRunListResponseSchema = z.object({ runs: z.array(aiFillRunSchema) });
export type AiFillRunListResponse = z.infer<typeof aiFillRunListResponseSchema>;

export const aiFillStartResponseSchema = z.object({
  /** The batch that was started; null for a dry run or when nothing was left to fill. */
  run: aiFillRunSchema.nullable(),
  /** Rows the mode lets this batch fill, before the limit. */
  candidates: z.number().int().nonnegative(),
  /** Cells in the batch. */
  queued: z.number().int().nonnegative(),
  /** Rows left out because their cell has a value the mode keeps. */
  skippedNotEmpty: z.number().int().nonnegative(),
  /** Rows of the whole column that the requester may not change. */
  skippedForbidden: z.number().int().nonnegative(),
  /** Rows whose cell another batch is already filling. */
  skippedActive: z.number().int().nonnegative(),
  /** Candidates beyond the limit, left for the next batch. */
  remaining: z.number().int().nonnegative(),
  /** Rows one batch may hold here (`ai.fillMaxRowsPerRun`). */
  limit: z.number().int().positive(),
});
export type AiFillStartResponse = z.infer<typeof aiFillStartResponseSchema>;

// ---------------------------------------------------------------------------
// Between the worker and the API
// ---------------------------------------------------------------------------

/**
 * What the model may read for one cell. Served by the API to the worker's
 * service token of that run only, assembled with the requester's rights: a
 * file they may not open is not in it.
 */
export const aiFillMaterialSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ready'),
    instruction: z.string(),
    property: z.object({
      name: z.string(),
      type: z.enum(AI_FILLABLE_PROPERTY_TYPES),
      options: z.array(z.string()),
      allowNewOptions: z.boolean(),
      isRange: z.boolean(),
      includeTime: z.boolean(),
    }),
    /** PERSON only: who may be named. */
    members: z.array(z.object({ id: idSchema, name: z.string(), email: z.string() })),
    row: z.object({
      title: z.string(),
      /** The row's other values as text, when the column reads them. */
      properties: z.array(z.object({ name: z.string(), value: z.string() })),
      /** The row's page as Markdown, when the column reads it. */
      content: z.string().nullable(),
      contentTruncated: z.boolean(),
    }),
    attachments: z.array(
      z.object({
        filename: z.string(),
        mimeType: z.string(),
        /** Null when the file has no text (yet). */
        text: z.string().nullable(),
        truncated: z.boolean(),
        /** The requester's own upload, screened clean (ADR-096). */
        trusted: z.boolean(),
      }),
    ),
  }),
  z.object({
    status: z.literal('unavailable'),
    /** What happened to the cell instead: it is recorded by the API already. */
    cellStatus: aiFillCellStatusSchema,
  }),
]);
export type AiFillMaterial = z.infer<typeof aiFillMaterialSchema>;

/** What a model may answer for a cell, before it is checked against the column. */
export const aiFillAnswerValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.union([z.string(), z.number()])),
  z.object({ start: z.string(), end: z.string().nullable().optional() }),
  z.null(),
]);
export type AiFillAnswerValue = z.infer<typeof aiFillAnswerValueSchema>;

export const aiFillCellResultRequestSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('answer'), value: aiFillAnswerValueSchema }),
  z.object({ outcome: z.literal('failed'), errorCode: aiFillCellErrorCodeSchema }),
]);
export type AiFillCellResultRequest = z.infer<typeof aiFillCellResultRequestSchema>;

export const aiFillCellResultResponseSchema = z.object({
  status: aiFillCellStatusSchema,
  errorCode: aiFillCellErrorCodeSchema.nullable(),
});
export type AiFillCellResultResponse = z.infer<typeof aiFillCellResultResponseSchema>;

// ---------------------------------------------------------------------------
// Reading and checking an answer
// ---------------------------------------------------------------------------

/**
 * The `value` out of a model's answer, which was asked to be `{"value": …}`.
 * Lenient about the wrapping models add (a code fence, a sentence before it),
 * strict about the JSON itself: a reply that is not that object is
 * `answer_unreadable`, never a guess.
 */
export function parseAiFillAnswerText(
  text: string,
): { ok: true; value: AiFillAnswerValue } | { ok: false } {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return { ok: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return { ok: false };
  }
  if (typeof parsed !== 'object' || parsed === null || !('value' in parsed)) return { ok: false };
  const value = aiFillAnswerValueSchema.safeParse((parsed as { value: unknown }).value);
  return value.success ? { ok: true, value: value.data } : { ok: false };
}

/** The longest text a fill writes into a cell. */
export const AI_FILL_TEXT_MAX = 5_000;
/** The most options one MULTI_SELECT answer may name. */
const MAX_OPTIONS_PER_ANSWER = 20;
const OPTION_LABEL_MAX = 100;

export interface AiFillColumn {
  type: AiFillablePropertyType;
  isRange: boolean;
  includeTime: boolean;
  timeZone: string | null;
  options: readonly { id: string; label: string }[];
  members: readonly { id: string; name: string | null; email: string }[];
  allowNewOptions: boolean;
}

export type AiFillCoercion =
  | {
      ok: true;
      /** `null` means the model found nothing: the cell stays as it is. */
      value: DatabaseRowPropertyValue['value'];
      /**
       * SELECT and MULTI_SELECT: labels to add as options first, in order. Their
       * ids join `value` once they exist; non-empty only when new options are allowed.
       */
      newOptions: string[];
    }
  | {
      ok: false;
      code: Extract<AiFillCellErrorCode, 'answer_invalid' | 'option_unknown' | 'person_unknown'>;
    };

const invalid: AiFillCoercion = { ok: false, code: 'answer_invalid' };

function isBlank(raw: AiFillAnswerValue): boolean {
  if (raw === null) return true;
  if (typeof raw === 'string') return raw.trim().length === 0;
  if (Array.isArray(raw)) return raw.every((entry) => String(entry).trim().length === 0);
  return false;
}

/**
 * A model's answer as the value of one cell, or why it cannot be one. Pure, so
 * every type's rules are a table in the test; the API calls it against the
 * column as it is when the answer arrives, not when the batch started.
 */
export function coerceAiFillAnswer(column: AiFillColumn, raw: AiFillAnswerValue): AiFillCoercion {
  if (isBlank(raw)) return { ok: true, value: null, newOptions: [] };
  switch (column.type) {
    case 'TEXT':
    case 'PHONE':
      return textValue(raw, column.type === 'PHONE' ? 100 : AI_FILL_TEXT_MAX);
    case 'URL':
      return urlValue(raw);
    case 'EMAIL':
      return emailValue(raw);
    case 'NUMBER':
      return numberValue(raw);
    case 'CHECKBOX':
      return checkboxValue(raw);
    case 'DATE':
      return dateValue(column, raw);
    case 'SELECT':
    case 'MULTI_SELECT':
      return optionValue(column, raw);
    case 'PERSON':
      return personValue(column, raw);
  }
}

function asText(raw: AiFillAnswerValue): string | null {
  if (typeof raw === 'string') return raw.trim();
  if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw);
  if (Array.isArray(raw)) return raw.map((entry) => `- ${String(entry).trim()}`).join('\n');
  return null;
}

function textValue(raw: AiFillAnswerValue, max: number): AiFillCoercion {
  const text = asText(raw);
  if (text === null) return invalid;
  return { ok: true, value: text.slice(0, max), newOptions: [] };
}

function urlValue(raw: AiFillAnswerValue): AiFillCoercion {
  const text = asText(raw);
  if (text === null || text.includes('\n')) return invalid;
  try {
    const url = new URL(text);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return invalid;
  } catch {
    return invalid;
  }
  return { ok: true, value: text, newOptions: [] };
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

function emailValue(raw: AiFillAnswerValue): AiFillCoercion {
  const text = asText(raw);
  if (text === null || !EMAIL_PATTERN.test(text)) return invalid;
  return { ok: true, value: text, newOptions: [] };
}

function numberValue(raw: AiFillAnswerValue): AiFillCoercion {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? { ok: true, value: raw, newOptions: [] } : invalid;
  }
  if (typeof raw !== 'string') return invalid;
  const compact = raw.replace(/[\s ]/gu, '');
  // "1.234,50" and "1,234.50" both happen; the last separator is the decimal one.
  const normalized = /,\d{1,2}$/u.test(compact)
    ? compact.replace(/\./gu, '').replace(',', '.')
    : compact.replace(/,/gu, '');
  if (!/^-?\d+(\.\d+)?$/u.test(normalized)) return invalid;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? { ok: true, value: parsed, newOptions: [] } : invalid;
}

const TRUE_WORDS = new Set(['true', 'ja', 'yes', 'wahr', 'x']);
const FALSE_WORDS = new Set(['false', 'nein', 'no', 'falsch']);

function checkboxValue(raw: AiFillAnswerValue): AiFillCoercion {
  if (typeof raw === 'boolean') return { ok: true, value: raw, newOptions: [] };
  if (typeof raw !== 'string') return invalid;
  const word = raw.trim().toLowerCase();
  if (TRUE_WORDS.has(word)) return { ok: true, value: true, newOptions: [] };
  if (FALSE_WORDS.has(word)) return { ok: true, value: false, newOptions: [] };
  return invalid;
}

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

/** One written date as the string a cell stores, or null when it is no date. */
function isoDate(text: string, column: AiFillColumn): string | null {
  const trimmed = text.trim();
  if (DAY_PATTERN.test(trimmed)) {
    const day = new Date(`${trimmed}T00:00:00Z`);
    return Number.isNaN(day.getTime()) || day.toISOString().slice(0, 10) !== trimmed
      ? null
      : trimmed;
  }
  const instant = instantFromIsoInput(trimmed, column.timeZone);
  if (instant === null) return null;
  // A column without a time keeps the day the model named, never a shifted one.
  return column.includeTime ? instant.toISOString() : trimmed.slice(0, 10);
}

function dateValue(column: AiFillColumn, raw: AiFillAnswerValue): AiFillCoercion {
  let start: string | null = null;
  let end: string | null = null;
  if (typeof raw === 'string') {
    start = isoDate(raw, column);
  } else if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    start = isoDate(raw.start, column);
    if (raw.end !== undefined && raw.end !== null && raw.end.trim().length > 0) {
      end = isoDate(raw.end, column);
      if (end === null) return invalid;
    }
  }
  if (start === null) return invalid;
  if (!column.isRange) return { ok: true, value: start, newOptions: [] };
  if (end !== null && end < start) return invalid;
  const allDay = DAY_PATTERN.test(start);
  return { ok: true, value: { start, end, allDay }, newOptions: [] };
}

function labelsOf(raw: AiFillAnswerValue): string[] | null {
  const list =
    typeof raw === 'string'
      ? raw.split(/[,;\n]/u)
      : Array.isArray(raw)
        ? raw.map((entry) => String(entry))
        : null;
  if (list === null) return null;
  const labels: string[] = [];
  const seen = new Set<string>();
  for (const entry of list) {
    const label = entry.trim().replace(/^-\s*/u, '');
    const key = label.toLowerCase();
    if (label.length === 0 || seen.has(key)) continue;
    seen.add(key);
    labels.push(label.slice(0, OPTION_LABEL_MAX));
  }
  return labels;
}

function optionValue(column: AiFillColumn, raw: AiFillAnswerValue): AiFillCoercion {
  const labels = labelsOf(raw);
  if (labels === null) return invalid;
  const wanted =
    column.type === 'SELECT' ? labels.slice(0, 1) : labels.slice(0, MAX_OPTIONS_PER_ANSWER);
  const byLabel = new Map(column.options.map((option) => [option.label.toLowerCase(), option.id]));
  const ids: string[] = [];
  const newOptions: string[] = [];
  for (const label of wanted) {
    const id = byLabel.get(label.toLowerCase());
    if (id !== undefined) ids.push(id);
    else if (column.allowNewOptions) newOptions.push(label);
    else return { ok: false, code: 'option_unknown' };
  }
  if (column.type === 'SELECT') {
    return { ok: true, value: ids[0] ?? null, newOptions };
  }
  return { ok: true, value: ids, newOptions };
}

function personValue(column: AiFillColumn, raw: AiFillAnswerValue): AiFillCoercion {
  const names = labelsOf(raw);
  if (names === null) return invalid;
  const ids: string[] = [];
  for (const name of names) {
    const key = name.toLowerCase();
    const member = column.members.find(
      (candidate) =>
        candidate.id === name ||
        candidate.email.toLowerCase() === key ||
        (candidate.name !== null && candidate.name.toLowerCase() === key),
    );
    if (member === undefined) return { ok: false, code: 'person_unknown' };
    if (!ids.includes(member.id)) ids.push(member.id);
  }
  return { ok: true, value: ids, newOptions: [] };
}

/** Whether a stored value counts as empty for `empty_only`. */
export function isEmptyCellValue(value: DatabaseRowPropertyValue['value'] | undefined): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim().length === 0;
  if (Array.isArray(value)) return value.length === 0;
  return false;
}
