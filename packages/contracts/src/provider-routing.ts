import { z } from 'zod';

/**
 * OpenRouter's provider preferences, as configuration (issue #135, ADR-063).
 *
 * The object is sent as the request's `provider` field, so its keys are
 * OpenRouter's own. The ones this repository reads itself are typed: `only`
 * and `ignore` filter the endpoint snapshot before eligibility is planned, and
 * `sort` is the reason the setting exists. Everything else OpenRouter accepts
 * (`max_price`, `quantizations`, `preferred_min_throughput`, and whatever it
 * adds next) passes through untouched, so a new routing option is a change to
 * the configuration and never to the request code.
 */
const providerNameListSchema = z.array(z.string().trim().min(1).max(120)).max(100);

export const PROVIDER_SORTS = ['price', 'throughput', 'latency'] as const;

export const providerRoutingSchema = z
  .object({
    sort: z.enum(PROVIDER_SORTS).optional(),
    only: providerNameListSchema.optional(),
    ignore: providerNameListSchema.optional(),
    order: providerNameListSchema.optional(),
    allow_fallbacks: z.boolean().optional(),
    require_parameters: z.boolean().optional(),
    data_collection: z.enum(['allow', 'deny']).optional(),
  })
  .catchall(z.json());
export type ProviderRouting = z.infer<typeof providerRoutingSchema>;

/**
 * A model's override of the global preferences.
 *
 * The same keys, plus `null` for each of them: a model that must not inherit
 * the global `sort` says `"sort": null`, which is different from not saying
 * anything about it. Absent inherits, `null` removes, a value replaces. Arrays
 * are values like any other and replace the global list instead of extending
 * it, because a merged allowlist is one nobody wrote down.
 */
export const providerRoutingOverrideSchema = z
  .object({
    sort: z.enum(PROVIDER_SORTS).nullable().optional(),
    only: providerNameListSchema.nullable().optional(),
    ignore: providerNameListSchema.nullable().optional(),
    order: providerNameListSchema.nullable().optional(),
    allow_fallbacks: z.boolean().nullable().optional(),
    require_parameters: z.boolean().nullable().optional(),
    data_collection: z.enum(['allow', 'deny']).nullable().optional(),
  })
  .catchall(z.json());
export type ProviderRoutingOverride = z.infer<typeof providerRoutingOverrideSchema>;

/**
 * The preferences in force for one model: the global object, with the model's
 * explicit keys laid over it one by one.
 */
export function mergeProviderRouting(
  global: ProviderRouting,
  override: ProviderRoutingOverride | null | undefined,
): ProviderRouting {
  const merged: Record<string, unknown> = { ...global };
  for (const [key, value] of Object.entries(override ?? {})) {
    if (value === undefined) continue;
    if (value === null) delete merged[key];
    else merged[key] = value;
  }
  return providerRoutingSchema.parse(merged);
}

/**
 * Whether a configured provider name means this endpoint.
 *
 * An endpoint's key is its tag (`deepinfra/fp8`); OpenRouter accepts both the
 * tag and the part before the slash in `only` and `ignore`, and so does this.
 * Case is ignored, because the names in its interface are capitalised and the
 * slugs are not.
 */
export function providerNameMatches(endpointKey: string, name: string): boolean {
  const key = endpointKey.toLowerCase();
  const wanted = name.trim().toLowerCase();
  return key === wanted || key.split('/')[0] === wanted;
}

/**
 * A model row's stored override, read defensively.
 *
 * The column is JSON that a person may have edited by hand, so a value that no
 * longer parses is treated as no override instead of stopping the request: the
 * global preferences still apply, which is the safer of the two readings.
 */
export function readProviderRoutingOverride(value: unknown): ProviderRoutingOverride | null {
  if (value === null || value === undefined) return null;
  const parsed = providerRoutingOverrideSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
