import { z } from 'zod';

/**
 * Reading OpenRouter's public catalogue: what models exist, and which providers
 * serve each of them with what capacity.
 *
 * It lives beside the provider adapter rather than in an app because two of
 * them need the same answers: the API syncs the registry when an admin asks,
 * and the worker refreshes it on a schedule (issue #68). Neither endpoint needs
 * a key, so this module only ever reads.
 *
 * Nothing here touches a database. The shape of a registry row is the callers'
 * business; this maps the provider's vocabulary onto ours and stops.
 */

/** Thinking levels as the registry knows them, ascending. */
export const OPEN_ROUTER_REASONING_LEVELS = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;
export type OpenRouterReasoningLevel = (typeof OPEN_ROUTER_REASONING_LEVELS)[number];

/**
 * Narrow, lenient schema for `GET {baseUrl}/models`.
 *
 * `.loose()` on every object lets OpenRouter add a field at any time without
 * breaking the sync -- only the handful of properties actually read are named.
 */
const openRouterModelSchema = z
  .object({
    id: z.string(),
    name: z.string().optional(),
    description: z.string().optional(),
    /** Present on the `~vendor/model-latest` entries; names the model they currently resolve to. */
    alias_target: z
      .object({
        slug: z.string(),
      })
      .loose()
      .nullable()
      .optional(),
    context_length: z.number().optional(),
    architecture: z
      .object({
        input_modalities: z.array(z.string()).default([]),
      })
      .loose()
      .optional(),
    supported_parameters: z.array(z.string()).default([]),
    reasoning: z
      .object({
        supported_efforts: z.array(z.string()).default([]),
      })
      .loose()
      .nullable()
      .optional(),
    top_provider: z
      .object({
        max_completion_tokens: z.number().nullable().optional(),
      })
      .loose()
      .nullable()
      .optional(),
    pricing: z
      .object({
        prompt: z.string(),
        completion: z.string(),
      })
      .loose(),
  })
  .loose();

const openRouterModelListSchema = z.object({ data: z.array(openRouterModelSchema) });

export type OpenRouterModel = z.infer<typeof openRouterModelSchema>;

/**
 * Narrow, lenient schema for `GET {baseUrl}/models/{slug}/endpoints`.
 *
 * `tag` is the routing identifier: its value (`reka/fp8`) and its part before
 * the slash (`reka`) are both accepted by `provider.only`, and the set of tag
 * prefixes matches the provider slugs OpenRouter names in its own error
 * messages one for one. `provider_name` is a display string and must never be
 * sent back as a routing key.
 */
const openRouterEndpointSchema = z
  .object({
    tag: z.string().optional(),
    provider_name: z.string().optional(),
    context_length: z.number().optional(),
    /** Separate cap on the *input* alone; null on most endpoints. */
    max_prompt_tokens: z.number().nullable().optional(),
    max_completion_tokens: z.number().nullable().optional(),
    quantization: z.string().nullable().optional(),
    supported_parameters: z.array(z.string()).default([]),
    pricing: z
      .object({
        prompt: z.string(),
        completion: z.string(),
      })
      .loose(),
  })
  .loose();

const openRouterEndpointListSchema = z.object({
  data: z.object({ endpoints: z.array(openRouterEndpointSchema) }).loose(),
});

export type OpenRouterEndpoint = z.infer<typeof openRouterEndpointSchema>;

/** One provider's offer for one model, in the registry's vocabulary. */
export interface OpenRouterEndpointSnapshot {
  /** Verbatim `provider.only` key. */
  providerKey: string;
  providerName: string;
  contextWindowTokens: number;
  maxPromptTokens: number | null;
  maxOutputTokens: number | null;
  inputMicroUsdPerMTok: number;
  outputMicroUsdPerMTok: number;
  supportsTools: boolean;
  supportsReasoningEffort: boolean;
  quantization: string | null;
}

/** The registry columns a live entry fills in. */
export interface OpenRouterModelFields {
  contextWindowTokens: number;
  maxOutputTokens: number | null;
  supportsVision: boolean;
  supportsTools: boolean;
  reasoningLevels: OpenRouterReasoningLevel[];
  inputMicroUsdPerMTok: number;
  outputMicroUsdPerMTok: number;
}

export class OpenRouterCatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpenRouterCatalogError';
  }
}

const REQUEST_TIMEOUT_MS = 15_000;

/** Price strings are per token; the registry stores micro-USD per million tokens. */
function toMicroUsdPerMTok(price: string): number {
  return Math.round(Number(price) * 1e12);
}

/** The effort names OpenRouter uses, mapped onto the registry's levels. */
const EFFORT_NAME_TO_LEVEL: Record<string, OpenRouterReasoningLevel> = {
  none: 'none',
  minimal: 'minimal',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max',
};

/**
 * Derives the selectable thinking levels from what OpenRouter reports.
 *
 * `reasoning.supported_efforts` is the provider's own answer and is believed
 * whenever it is there: it is how `xhigh` and `max` became reachable at all, and
 * how the next level will. An effort with no level of ours is dropped rather
 * than guessed at, and `none` is always offered -- "do not think" is a choice no
 * model can take away.
 *
 * The fallback is the older heuristic, for an entry that reports no efforts. A
 * model that only lists `reasoning` thinks on its own terms and offers no level
 * to pick, so it gets `['none']`. `reasoning_effort` means the effort levels are
 * honoured; `verbosity` (Anthropic) does not add a level. `minimal` is only
 * offered where the provider documents it, which today is OpenAI.
 */
export function deriveReasoningLevels(input: {
  slug: string;
  supportedParameters: readonly string[];
  supportedEfforts?: readonly string[];
}): OpenRouterReasoningLevel[] {
  const reported = new Set(
    (input.supportedEfforts ?? [])
      .map((effort) => EFFORT_NAME_TO_LEVEL[effort.toLowerCase()])
      .filter((level): level is OpenRouterReasoningLevel => level !== undefined),
  );
  if (reported.size > 0) {
    reported.add('none');
    return OPEN_ROUTER_REASONING_LEVELS.filter((level) => reported.has(level));
  }

  if (!input.supportedParameters.includes('reasoning_effort')) return ['none'];
  const levels: OpenRouterReasoningLevel[] = ['none'];
  if (input.slug.startsWith('openai/')) levels.push('minimal');
  levels.push('low', 'medium', 'high');
  return levels;
}

/** Maps one live entry onto the registry's columns. Prices are integers: never store a float. */
export function mapModelFields(
  entry: OpenRouterModel,
  fallbackContextWindowTokens: number,
): OpenRouterModelFields {
  return {
    contextWindowTokens: entry.context_length ?? fallbackContextWindowTokens,
    maxOutputTokens: entry.top_provider?.max_completion_tokens ?? null,
    supportsVision: (entry.architecture?.input_modalities ?? []).includes('image'),
    supportsTools: entry.supported_parameters.includes('tools'),
    reasoningLevels: deriveReasoningLevels({
      slug: entry.id,
      supportedParameters: entry.supported_parameters,
      supportedEfforts: entry.reasoning?.supported_efforts,
    }),
    inputMicroUsdPerMTok: toMicroUsdPerMTok(entry.pricing.prompt),
    outputMicroUsdPerMTok: toMicroUsdPerMTok(entry.pricing.completion),
  };
}

/** Maps one endpoint onto a snapshot row, or `null` when it carries no routing key. */
export function mapEndpoint(endpoint: OpenRouterEndpoint): OpenRouterEndpointSnapshot | null {
  const providerKey = endpoint.tag?.trim() ?? '';
  const contextWindowTokens = endpoint.context_length ?? 0;
  if (providerKey.length === 0 || contextWindowTokens <= 0) return null;

  const inputMicroUsdPerMTok = toMicroUsdPerMTok(endpoint.pricing.prompt);
  const outputMicroUsdPerMTok = toMicroUsdPerMTok(endpoint.pricing.completion);
  if (Number.isNaN(inputMicroUsdPerMTok) || Number.isNaN(outputMicroUsdPerMTok)) return null;

  return {
    providerKey,
    providerName: endpoint.provider_name ?? providerKey,
    contextWindowTokens,
    maxPromptTokens: endpoint.max_prompt_tokens ?? null,
    maxOutputTokens: endpoint.max_completion_tokens ?? null,
    inputMicroUsdPerMTok,
    outputMicroUsdPerMTok,
    supportsTools: endpoint.supported_parameters.includes('tools'),
    supportsReasoningEffort: endpoint.supported_parameters.includes('reasoning_effort'),
    quantization: endpoint.quantization ?? null,
  };
}

/**
 * The model-level figures a set of endpoints implies.
 *
 * The context window is the *largest* an endpoint offers, because a request is
 * only ever sent to an endpoint that can serve it (`planRoute`): storing the
 * smallest would make compaction fire at a quarter of the usable window for no
 * gain. The prices are the *highest*, because the router picks among eligible
 * endpoints by its own rules and an estimate that is too high is the harmless
 * direction.
 */
export function modelFieldsFromEndpoints(
  endpoints: readonly OpenRouterEndpointSnapshot[],
): Pick<
  OpenRouterModelFields,
  'contextWindowTokens' | 'maxOutputTokens' | 'inputMicroUsdPerMTok' | 'outputMicroUsdPerMTok'
> | null {
  if (endpoints.length === 0) return null;
  const outputLimits = endpoints
    .map((endpoint) => endpoint.maxOutputTokens)
    .filter((value): value is number => value !== null && value > 0);

  return {
    contextWindowTokens: Math.max(
      ...endpoints.map((endpoint) =>
        endpoint.maxPromptTokens === null
          ? endpoint.contextWindowTokens
          : Math.min(endpoint.contextWindowTokens, endpoint.maxPromptTokens),
      ),
    ),
    maxOutputTokens: outputLimits.length === 0 ? null : Math.max(...outputLimits),
    inputMicroUsdPerMTok: Math.max(...endpoints.map((e) => e.inputMicroUsdPerMTok)),
    outputMicroUsdPerMTok: Math.max(...endpoints.map((e) => e.outputMicroUsdPerMTok)),
  };
}

/** The slug an entry's figures should be read from: an alias points at another model. */
export function aliasTargetOf(entry: OpenRouterModel): string | null {
  return entry.alias_target?.slug ?? null;
}

async function readJson(url: string, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(url, { signal: signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!response.ok) {
    throw new OpenRouterCatalogError(`${url} answered with status ${response.status}`);
  }
  return response.json();
}

/** The provider's current model list, keyed by slug. */
export async function fetchOpenRouterModels(
  baseUrl: string,
  signal?: AbortSignal,
): Promise<Map<string, OpenRouterModel>> {
  const parsed = openRouterModelListSchema.safeParse(await readJson(`${baseUrl}/models`, signal));
  if (!parsed.success) {
    throw new OpenRouterCatalogError('The model list did not match the expected shape');
  }
  return new Map(parsed.data.data.map((entry) => [entry.id, entry]));
}

/**
 * The providers serving one model.
 *
 * An alias slug answers with an empty list -- the endpoints route does not
 * resolve aliases -- so callers pass the target slug, never the alias.
 */
export async function fetchOpenRouterEndpoints(
  baseUrl: string,
  slug: string,
  signal?: AbortSignal,
): Promise<OpenRouterEndpointSnapshot[]> {
  const parsed = openRouterEndpointListSchema.safeParse(
    await readJson(`${baseUrl}/models/${slug}/endpoints`, signal),
  );
  if (!parsed.success) {
    throw new OpenRouterCatalogError(`The endpoint list for ${slug} did not match the shape`);
  }
  return parsed.data.data.endpoints
    .map(mapEndpoint)
    .filter((endpoint): endpoint is OpenRouterEndpointSnapshot => endpoint !== null);
}

/** What one model's route refresh found. */
export interface ModelRouteResolution {
  /** The model the figures and endpoints describe. Equals `slug` unless it is an alias. */
  targetSlug: string;
  /** Set only when `slug` is an alias; `null` says the model is its own target. */
  aliasTargetSlug: string | null;
  /** Empty when the provider could not be asked, or answered with nothing usable. */
  endpoints: OpenRouterEndpointSnapshot[];
  /** The model-level columns the live entry fills in, `null` when the provider no longer has the model. */
  fields: OpenRouterModelFields | null;
  /** Why the endpoint list is empty, for the log. `null` when it is not. */
  endpointFailure: string | null;
}

/**
 * Everything one registry row should learn from the provider: the alias
 * resolved, the model-level columns, and the endpoints that serve it.
 *
 * Persisting the result is the caller's business -- this module never sees a
 * database (ADR-020's port pattern, for the same reason: the decision belongs
 * with the provider vocabulary, the writing belongs with the schema).
 *
 * An endpoint list that cannot be read is an empty list plus a reason, never a
 * throw: a refresh that fails must leave the previous snapshot standing.
 */
export async function resolveModelRoutes(input: {
  baseUrl: string;
  slug: string;
  models: Map<string, OpenRouterModel>;
  fallbackContextWindowTokens: number;
  signal?: AbortSignal;
}): Promise<ModelRouteResolution> {
  const entry = input.models.get(input.slug);
  if (entry === undefined) {
    return {
      targetSlug: input.slug,
      aliasTargetSlug: null,
      endpoints: [],
      fields: null,
      endpointFailure: 'the provider no longer lists this model',
    };
  }

  const aliasTargetSlug = aliasTargetOf(entry);
  // An alias row carries the cheapest endpoint's figures rather than the
  // model's, and the endpoints route does not resolve aliases at all, so
  // everything past this point asks about the target.
  const source = aliasTargetSlug === null ? entry : (input.models.get(aliasTargetSlug) ?? entry);
  const targetSlug = source.id;
  const catalogFields = mapModelFields(source, input.fallbackContextWindowTokens);

  let endpoints: OpenRouterEndpointSnapshot[] = [];
  let endpointFailure: string | null = null;
  try {
    endpoints = await fetchOpenRouterEndpoints(input.baseUrl, targetSlug, input.signal);
  } catch (error) {
    endpointFailure = error instanceof Error ? error.message : String(error);
  }

  const fromEndpoints = modelFieldsFromEndpoints(endpoints);
  return {
    targetSlug,
    aliasTargetSlug,
    endpoints,
    fields: fromEndpoints === null ? catalogFields : { ...catalogFields, ...fromEndpoints },
    endpointFailure,
  };
}
