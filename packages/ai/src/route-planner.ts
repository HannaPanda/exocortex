/**
 * Which of a model's providers may serve one particular request (issue #68,
 * ADR-032).
 *
 * A model on OpenRouter is served by many providers at once, and they differ:
 * GLM 5.3 is offered with a 262k window by one and a 1.3M window by another.
 * The router picks one per request by its own price and reliability signals,
 * which is exactly what it should keep doing -- but it has to pick among
 * providers that can actually serve *this* prompt.
 *
 * So the plan is a technical eligibility filter and nothing else. No ranking
 * happens here: a plan is a set, never an order.
 */

/** One provider's offer, as the registry snapshot holds it. */
export interface RoutingEndpoint {
  /** Verbatim `provider.only` key. */
  providerKey: string;
  contextWindowTokens: number;
  /** Separate cap on the input alone, `null` when the endpoint states none. */
  maxPromptTokens: number | null;
  maxOutputTokens: number | null;
  supportsTools: boolean;
  supportsReasoningEffort: boolean;
}

export interface RoutePlanInput {
  endpoints: readonly RoutingEndpoint[];
  /** Estimated tokens of the messages this turn actually sends. */
  inputTokens: number;
  /** Tokens the answer is allowed to occupy. */
  reservedOutputTokens: number;
  /**
   * Share of an endpoint's window treated as usable, the same number
   * compaction triggers at (`ai.compactionThresholdPercent`). Token counts are
   * estimates, so the last few percent of a window are never planned for.
   */
  usableSharePercent: number;
  requiresTools: boolean;
  requiresReasoningEffort: boolean;
}

export interface RoutePlan {
  /** False when the model has no endpoint snapshot: routing then stays OpenRouter's business alone. */
  known: boolean;
  /** Providers that may serve this request. Empty with `known` means nothing fits. */
  allowedProviderKeys: string[];
  /** How many endpoints match the required capabilities, whatever their size. */
  capableEndpoints: number;
  /**
   * The largest input a capable endpoint could take, given the reserved output.
   * This is what compaction has to get under, and `0` when nothing is capable.
   */
  largestUsableInputTokens: number;
}

function usableTotal(endpoint: RoutingEndpoint, sharePercent: number): number {
  return Math.floor((endpoint.contextWindowTokens * sharePercent) / 100);
}

function usableInput(endpoint: RoutingEndpoint, input: RoutePlanInput): number {
  const fromTotal = usableTotal(endpoint, input.usableSharePercent) - input.reservedOutputTokens;
  if (endpoint.maxPromptTokens === null) return fromTotal;
  return Math.min(
    fromTotal,
    Math.floor((endpoint.maxPromptTokens * input.usableSharePercent) / 100),
  );
}

/** Capability and output-limit eligibility, which no amount of compaction changes. */
function isCapable(endpoint: RoutingEndpoint, input: RoutePlanInput): boolean {
  if (input.requiresTools && !endpoint.supportsTools) return false;
  if (input.requiresReasoningEffort && !endpoint.supportsReasoningEffort) return false;
  if (endpoint.maxOutputTokens !== null && endpoint.maxOutputTokens < input.reservedOutputTokens) {
    return false;
  }
  return true;
}

/**
 * The providers that may serve this turn.
 *
 * A model without a snapshot answers `known: false`: the request then goes out
 * without a provider preference, exactly as it did before endpoint data
 * existed. Degrading that way is deliberate -- an allowlist invented from
 * nothing would be worse than none.
 */
export function planRoute(input: RoutePlanInput): RoutePlan {
  if (input.endpoints.length === 0) {
    return { known: false, allowedProviderKeys: [], capableEndpoints: 0, largestUsableInputTokens: 0 };
  }

  const capable = input.endpoints.filter((endpoint) => isCapable(endpoint, input));
  const largestUsableInputTokens = capable.reduce(
    (largest, endpoint) => Math.max(largest, usableInput(endpoint, input)),
    0,
  );

  return {
    known: true,
    allowedProviderKeys: capable
      .filter((endpoint) => usableInput(endpoint, input) >= input.inputTokens)
      .map((endpoint) => endpoint.providerKey),
    capableEndpoints: capable.length,
    largestUsableInputTokens,
  };
}

/**
 * Whether making the prompt smaller would put a provider back in reach.
 *
 * Asked before compacting in response to an empty plan: compaction costs a
 * model call and throws away transcript, so it must not happen when the reason
 * nothing is eligible is a capability or an output limit rather than size.
 */
export function couldCompactionHelp(input: {
  plan: RoutePlan;
  /** The smallest input this conversation could possibly be reduced to. */
  floorInputTokens: number;
}): boolean {
  if (!input.plan.known) return false;
  if (input.plan.allowedProviderKeys.length > 0) return false;
  if (input.plan.capableEndpoints === 0) return false;
  return input.floorInputTokens <= input.plan.largestUsableInputTokens;
}
