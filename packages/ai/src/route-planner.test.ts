import { describe, expect, it } from 'vitest';

import { couldCompactionHelp, planRoute, type RoutingEndpoint } from './route-planner';

/**
 * Provider eligibility (issue #68, ADR-032).
 *
 * The numbers are the real ones: GLM 5.3 is served with a 262k window by one
 * provider and a 1.05M window by others, which is the case the whole mechanism
 * exists for.
 */
function endpoint(overrides: Partial<RoutingEndpoint> & { providerKey: string }): RoutingEndpoint {
  return {
    contextWindowTokens: 1_048_576,
    maxPromptTokens: null,
    maxOutputTokens: 131_072,
    supportsTools: true,
    supportsReasoningEffort: true,
    ...overrides,
  };
}

const SMALL = endpoint({ providerKey: 'reka/fp8', contextWindowTokens: 262_144 });
const LARGE = endpoint({ providerKey: 'together' });
const HUGE = endpoint({ providerKey: 'cloudflare', contextWindowTokens: 1_310_720 });

function plan(input: {
  endpoints: RoutingEndpoint[];
  inputTokens: number;
  reservedOutputTokens?: number;
  requiresTools?: boolean;
  requiresReasoningEffort?: boolean;
}) {
  return planRoute({
    endpoints: input.endpoints,
    inputTokens: input.inputTokens,
    reservedOutputTokens: input.reservedOutputTokens ?? 8_000,
    usableSharePercent: 90,
    requiresTools: input.requiresTools ?? false,
    requiresReasoningEffort: input.requiresReasoningEffort ?? false,
  });
}

describe('planRoute', () => {
  it('lets a small request go to every provider', () => {
    const result = plan({ endpoints: [SMALL, LARGE, HUGE], inputTokens: 120_000 });

    expect(result.allowedProviderKeys).toEqual(['reka/fp8', 'together', 'cloudflare']);
    expect(result.known).toBe(true);
  });

  it('drops the small provider once the prompt outgrows it', () => {
    const result = plan({ endpoints: [SMALL, LARGE, HUGE], inputTokens: 300_000 });

    expect(result.allowedProviderKeys).toEqual(['together', 'cloudflare']);
    // The point of the whole exercise: the big providers are still reachable.
    expect(result.largestUsableInputTokens).toBeGreaterThan(1_000_000);
  });

  it('keeps the last few percent of a window out of reach, because tokens are estimates', () => {
    // 90% of 262,144 is 235,929; minus the reserved answer leaves 227,929.
    expect(plan({ endpoints: [SMALL], inputTokens: 227_929 }).allowedProviderKeys).toEqual([
      'reka/fp8',
    ]);
    expect(plan({ endpoints: [SMALL], inputTokens: 227_930 }).allowedProviderKeys).toEqual([]);
  });

  it('honours a separate input cap where an endpoint states one', () => {
    const capped = endpoint({ providerKey: 'capped', maxPromptTokens: 100_000 });

    expect(plan({ endpoints: [capped], inputTokens: 95_000 }).allowedProviderKeys).toEqual([]);
    expect(plan({ endpoints: [capped], inputTokens: 89_000 }).allowedProviderKeys).toEqual([
      'capped',
    ]);
  });

  it('excludes a provider that cannot return the requested answer length', () => {
    const shortOutput = endpoint({ providerKey: 'short', maxOutputTokens: 4_000 });
    const result = plan({
      endpoints: [shortOutput, LARGE],
      inputTokens: 1_000,
      reservedOutputTokens: 8_000,
    });

    expect(result.allowedProviderKeys).toEqual(['together']);
    expect(result.capableEndpoints).toBe(1);
  });

  it('sends no preference at all when no provider can do what the run needs', () => {
    // The registry says the model can think; its only provider says otherwise.
    // Restricting to nothing would break a model that worked yesterday, so the
    // request goes out unrestricted instead.
    const noEffort = endpoint({ providerKey: 'no-effort', supportsReasoningEffort: false });
    const result = plan({
      endpoints: [noEffort],
      inputTokens: 1_000,
      requiresReasoningEffort: true,
    });

    expect(result.known).toBe(false);
    expect(result.allowedProviderKeys).toEqual([]);
  });

  it('excludes providers that cannot do what the run needs', () => {
    const noTools = endpoint({ providerKey: 'no-tools', supportsTools: false });
    const noEffort = endpoint({ providerKey: 'no-effort', supportsReasoningEffort: false });

    expect(
      plan({ endpoints: [noTools, LARGE], inputTokens: 1_000, requiresTools: true })
        .allowedProviderKeys,
    ).toEqual(['together']);
    expect(
      plan({ endpoints: [noEffort, LARGE], inputTokens: 1_000, requiresReasoningEffort: true })
        .allowedProviderKeys,
    ).toEqual(['together']);
  });

  it('says nothing is known for a model without a snapshot', () => {
    const result = plan({ endpoints: [], inputTokens: 1_000 });

    expect(result.known).toBe(false);
    expect(result.allowedProviderKeys).toEqual([]);
  });
});

describe('couldCompactionHelp', () => {
  it('is true when size is the only thing in the way', () => {
    const tooBig = plan({ endpoints: [SMALL], inputTokens: 500_000 });

    expect(couldCompactionHelp({ plan: tooBig, floorInputTokens: 20_000 })).toBe(true);
  });

  it('is false when even the smallest possible prompt would not fit', () => {
    const tooBig = plan({ endpoints: [SMALL], inputTokens: 500_000 });

    expect(couldCompactionHelp({ plan: tooBig, floorInputTokens: 400_000 })).toBe(false);
  });

  it('is false when the reason is a capability, not a size', () => {
    const noTools = endpoint({ providerKey: 'no-tools', supportsTools: false });
    const refused = plan({
      endpoints: [noTools, endpoint({ providerKey: 'tiny', contextWindowTokens: 1_000 })],
      inputTokens: 100_000,
      requiresTools: true,
    });

    expect(refused.allowedProviderKeys).toEqual([]);
    expect(couldCompactionHelp({ plan: refused, floorInputTokens: 90_000 })).toBe(false);
  });

  it('is false while something is still eligible, and for a model without a snapshot', () => {
    expect(
      couldCompactionHelp({
        plan: plan({ endpoints: [LARGE], inputTokens: 1_000 }),
        floorInputTokens: 10,
      }),
    ).toBe(false);
    expect(
      couldCompactionHelp({
        plan: plan({ endpoints: [], inputTokens: 1_000 }),
        floorInputTokens: 10,
      }),
    ).toBe(false);
  });
});
