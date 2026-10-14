import {
  PROVIDER_SORTS,
  type ProviderRouting,
  type ProviderRoutingOverride,
  providerRoutingOverrideSchema,
  providerRoutingSchema,
} from '@exocortex/contracts';

/**
 * The routing form's state and its conversion to and from the stored object
 * (issue #201, ADR-063).
 *
 * One form serves the deployment setting and the two overrides (a model, an
 * agent profile). The stored format is unchanged: the form reads an object and
 * writes an object, and what it does not know stays as JSON beside it.
 *
 * A known key is in one of three states. `unset` is the key being absent:
 * the setting falls back to OpenRouter's default, an override inherits.
 * `remove` is an override's `null`, which drops the inherited value; the
 * setting has no such state. `set` is a value.
 */

export const ROUTING_LIST_KEYS = ['only', 'ignore', 'order'] as const;
export type RoutingListKey = (typeof ROUTING_LIST_KEYS)[number];

export const ROUTING_FLAG_KEYS = ['allow_fallbacks', 'require_parameters'] as const;
export type RoutingFlagKey = (typeof ROUTING_FLAG_KEYS)[number];

export const DATA_COLLECTION_VALUES = ['allow', 'deny'] as const;
export type DataCollection = (typeof DATA_COLLECTION_VALUES)[number];
export type ProviderSort = (typeof PROVIDER_SORTS)[number];

const KNOWN_KEYS: ReadonlySet<string> = new Set([
  'sort',
  'data_collection',
  ...ROUTING_LIST_KEYS,
  ...ROUTING_FLAG_KEYS,
]);

export type RoutingField<TValue> =
  { state: 'unset' } | { state: 'remove' } | { state: 'set'; value: TValue };

export type RoutingMode = 'setting' | 'override';

export interface RoutingForm {
  sort: RoutingField<ProviderSort>;
  dataCollection: RoutingField<DataCollection>;
  lists: Record<RoutingListKey, RoutingField<string[]>>;
  flags: Record<RoutingFlagKey, RoutingField<boolean>>;
  /** The keys the form has no field for, as JSON text; empty when there are none. */
  extra: string;
}

const UNSET = { state: 'unset' } as const;

function fieldOf<TValue>(
  source: Record<string, unknown>,
  key: string,
  read: (value: unknown) => TValue | undefined,
): RoutingField<TValue> {
  if (!(key in source) || source[key] === undefined) return UNSET;
  if (source[key] === null) return { state: 'remove' };
  const value = read(source[key]);
  return value === undefined ? UNSET : { state: 'set', value };
}

const readSort = (value: unknown): ProviderSort | undefined =>
  (PROVIDER_SORTS as readonly unknown[]).includes(value) ? (value as ProviderSort) : undefined;

const readDataCollection = (value: unknown): DataCollection | undefined =>
  (DATA_COLLECTION_VALUES as readonly unknown[]).includes(value)
    ? (value as DataCollection)
    : undefined;

const readList = (value: unknown): string[] | undefined =>
  Array.isArray(value) && value.every((entry) => typeof entry === 'string')
    ? [...value]
    : undefined;

const readFlag = (value: unknown): boolean | undefined =>
  typeof value === 'boolean' ? value : undefined;

/** The form for a stored object; `null` (no override) is the empty form. */
export function formFromRouting(
  routing: ProviderRouting | ProviderRoutingOverride | null | undefined,
): RoutingForm {
  const source: Record<string, unknown> = { ...routing };
  const extra = Object.fromEntries(Object.entries(source).filter(([key]) => !KNOWN_KEYS.has(key)));
  return {
    sort: fieldOf(source, 'sort', readSort),
    dataCollection: fieldOf(source, 'data_collection', readDataCollection),
    lists: {
      only: fieldOf(source, 'only', readList),
      ignore: fieldOf(source, 'ignore', readList),
      order: fieldOf(source, 'order', readList),
    },
    flags: {
      allow_fallbacks: fieldOf(source, 'allow_fallbacks', readFlag),
      require_parameters: fieldOf(source, 'require_parameters', readFlag),
    },
    extra: Object.keys(extra).length === 0 ? '' : JSON.stringify(extra, null, 2),
  };
}

/** The extra keys as an object, or `undefined` when the text is not one. */
export function parseExtra(text: string): Record<string, unknown> | undefined {
  if (text.trim().length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
  return parsed as Record<string, unknown>;
}

export type RoutingResult<TMode extends RoutingMode> =
  | { ok: true; value: TMode extends 'setting' ? ProviderRouting : ProviderRoutingOverride }
  | { ok: false; reason: 'extraInvalid' | 'extraKnownKey' | 'invalid' };

/**
 * The object the form describes, checked against the schema it is stored
 * under. The known keys come first in a fixed order, then the extra ones; an
 * extra key that names a field is refused instead of silently winning or
 * losing against it.
 */
export function routingFromForm<TMode extends RoutingMode>(
  form: RoutingForm,
  mode: TMode,
): RoutingResult<TMode> {
  const extra = parseExtra(form.extra);
  if (extra === undefined) return { ok: false, reason: 'extraInvalid' };
  if (Object.keys(extra).some((key) => KNOWN_KEYS.has(key))) {
    return { ok: false, reason: 'extraKnownKey' };
  }
  const out: Record<string, unknown> = {};
  const put = <TValue>(key: string, field: RoutingField<TValue>): void => {
    if (field.state === 'set') out[key] = field.value;
    else if (field.state === 'remove' && mode === 'override') out[key] = null;
  };
  put('sort', form.sort);
  for (const key of ROUTING_LIST_KEYS) put(key, form.lists[key]);
  for (const key of ROUTING_FLAG_KEYS) put(key, form.flags[key]);
  put('data_collection', form.dataCollection);
  Object.assign(out, extra);
  const schema = mode === 'setting' ? providerRoutingSchema : providerRoutingOverrideSchema;
  const parsed = schema.safeParse(out);
  if (!parsed.success) return { ok: false, reason: 'invalid' };
  return { ok: true, value: parsed.data } as RoutingResult<TMode>;
}

/**
 * Whether two routing objects say the same thing, whatever order their keys
 * were written in. A value loaded and saved again comes back in the form's
 * order, which is not a change.
 */
export function sameRouting(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) =>
    typeof entry === 'object' && entry !== null && !Array.isArray(entry)
      ? Object.fromEntries(
          // A fresh array from `entries`, so sorting it in place touches nothing.
          Object.entries(entry as Record<string, unknown>).sort(([x], [y]) =>
            x < y ? -1 : x > y ? 1 : 0,
          ),
        )
      : entry,
  );
}

/** Adds a provider name to a list unless it is already there, ignoring case. */
export function addProviderName(list: readonly string[], name: string): string[] {
  const trimmed = name.trim();
  if (trimmed.length === 0) return [...list];
  const wanted = trimmed.toLowerCase();
  return list.some((entry) => entry.toLowerCase() === wanted) ? [...list] : [...list, trimmed];
}
