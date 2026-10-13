import {
  type AiModel,
  type AiModelCatalogEntry,
  type DatabaseProperty,
  EMBEDDING_MODELS_FITTING_COLUMN,
  ENTITY_PROPERTY_NAMES,
  type SettingKey,
} from '@exocortex/contracts';

/**
 * The settings that name something by id, a model or the entity database,
 * and the lists they pick from (issue #171). Pure, so the unit suite can hold
 * it; the pickers in `components/settings` render what this decides.
 */

export interface ReferenceOption {
  /** `null` is the setting's empty value, offered when the setting allows it. */
  value: string | null;
  label: string;
  /** Second line: the slug or id, and a status or place where there is one. */
  detail: string;
}

/** Every word of the query somewhere in the name or the second line. */
export function matchesReferenceQuery(option: ReferenceOption, query: string): boolean {
  const haystack = `${option.label} ${option.detail}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word.length > 0)
    .every((word) => haystack.includes(word));
}

/**
 * The options as the list shows them: a stored value nobody offers any more
 * is added as its own row, so the field never shows something other than what
 * is saved.
 */
export function withStoredValue(
  options: readonly ReferenceOption[],
  value: string | null,
  notListed: string,
): { options: ReferenceOption[]; missing: boolean } {
  if (value === null || options.some((option) => option.value === value)) {
    return { options: [...options], missing: false };
  }
  return { options: [...options, { value, label: value, detail: notListed }], missing: true };
}

/**
 * Which list a model setting picks from, and what its empty value means
 * (issue #171).
 *
 * Three kinds of field name a model. The chat ones name a registry row and
 * fall back to another setting when empty; the vector model names an
 * OpenRouter embedding model that has to fill the 1536-wide column, and has no
 * empty value; the image model names an OpenRouter image model, and empty
 * switches the cover generation off. Listed by key rather than found by a
 * `ModelSlug` suffix, because `overview.modelSlug` has none and was a text
 * field for that reason alone.
 */
export type ModelField =
  | { source: 'registry'; empty: ModelEmpty }
  | { source: 'embeddings' }
  | { source: 'image'; empty: 'off' };

/** What a model setting's `null` falls back to; each one is a sentence in the catalogue. */
export type ModelEmpty = 'automatic' | 'chat' | 'defaultModel' | 'compaction' | 'capture';

const MODEL_FIELDS: Partial<Record<SettingKey, ModelField>> = {
  'ai.defaultModelSlug': { source: 'registry', empty: 'automatic' },
  'ai.compactionModelSlug': { source: 'registry', empty: 'chat' },
  'ai.pdfExtractionModelSlug': { source: 'registry', empty: 'defaultModel' },
  'memory.captureModelSlug': { source: 'registry', empty: 'compaction' },
  'memory.consolidationModelSlug': { source: 'registry', empty: 'capture' },
  'overview.modelSlug': { source: 'registry', empty: 'defaultModel' },
  'search.embeddingModelSlug': { source: 'embeddings' },
  'ai.imageModelSlug': { source: 'image', empty: 'off' },
};

export function modelFieldOf(key: SettingKey): ModelField | undefined {
  return MODEL_FIELDS[key];
}

/** The provider's list for a field that names an OpenRouter slug, as far as it arrived. */
export interface ModelCatalogState {
  entries: readonly AiModelCatalogEntry[];
  loading: boolean;
  /** The list could not be read, or this form has no right to read it. */
  unavailable: boolean;
}

export type ModelCatalogs = Partial<Record<'embeddings' | 'image', ModelCatalogState>>;

export function registryOptions(
  models: readonly AiModel[],
  value: string | null,
  disabledLabel: string,
): ReferenceOption[] {
  // A switched-off model is offered only when it is the one stored: it should
  // not be picked, but the field has to say what is saved and why it is grey.
  return models
    .filter((model) => model.enabled || model.slug === value)
    .map((model) => ({
      value: model.slug,
      label: model.displayName,
      detail: model.enabled ? model.slug : `${model.slug} · ${disabledLabel}`,
    }));
}

/**
 * The embedding models that fit the column. Ordered by the measured list,
 * named by the catalogue when it has answered; without it the slugs alone
 * still make a list, because which models fit does not depend on the request.
 */
export function embeddingOptions(entries: readonly AiModelCatalogEntry[]): ReferenceOption[] {
  const bySlug = new Map(entries.map((entry) => [entry.slug, entry]));
  return EMBEDDING_MODELS_FITTING_COLUMN.filter(
    (slug) => entries.length === 0 || bySlug.has(slug),
  ).map((slug) => ({ value: slug, label: bySlug.get(slug)?.displayName ?? slug, detail: slug }));
}

export function catalogOptions(entries: readonly AiModelCatalogEntry[]): ReferenceOption[] {
  return entries.map((entry) => ({
    value: entry.slug,
    label: entry.displayName,
    detail: entry.slug,
  }));
}

/**
 * Whether a model setting has a list to pick from in this form. The image
 * model has none where the provider's catalogue cannot be read (the workspace
 * form, or a failed request), and keeps its text field there.
 */
export function modelFieldHasList(field: ModelField, catalogs: ModelCatalogs | undefined): boolean {
  return field.source !== 'image' || catalogs?.image?.unavailable === false;
}

/** Which of the two columns the matcher reads a database lacks, by name. */
export function missingEntityColumns(properties: readonly DatabaseProperty[]): string[] {
  const has = (name: string, type: DatabaseProperty['type']): boolean =>
    properties.some((property) => property.name === name && property.type === type);
  return [
    ...(has(ENTITY_PROPERTY_NAMES.type, 'SELECT') ? [] : [ENTITY_PROPERTY_NAMES.type]),
    ...(has(ENTITY_PROPERTY_NAMES.aliases, 'TEXT') ? [] : [ENTITY_PROPERTY_NAMES.aliases]),
  ];
}
