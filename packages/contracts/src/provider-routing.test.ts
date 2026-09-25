import { describe, expect, it } from 'vitest';

import {
  mergeProviderRouting,
  providerNameMatches,
  providerRoutingSchema,
  readProviderRoutingOverride,
} from './provider-routing';

describe('mergeProviderRouting', () => {
  it('lets a model replace single keys and inherit the rest', () => {
    expect(
      mergeProviderRouting({ sort: 'throughput', ignore: ['provider-x'] }, { sort: 'latency' }),
    ).toEqual({ sort: 'latency', ignore: ['provider-x'] });
  });

  it('inherits the global object unchanged without an override', () => {
    expect(mergeProviderRouting({ sort: 'throughput' }, null)).toEqual({ sort: 'throughput' });
  });

  it('removes a global key the model sets to null', () => {
    expect(mergeProviderRouting({ sort: 'throughput', ignore: ['a'] }, { sort: null })).toEqual({
      ignore: ['a'],
    });
  });

  it('replaces a list instead of extending it', () => {
    expect(mergeProviderRouting({ ignore: ['a', 'b'] }, { ignore: ['c'] })).toEqual({
      ignore: ['c'],
    });
  });

  it('carries options this repository does not know yet', () => {
    expect(
      mergeProviderRouting({ preferred_min_throughput: 50 }, { max_price: { completion: 3 } }),
    ).toEqual({ preferred_min_throughput: 50, max_price: { completion: 3 } });
  });
});

describe('providerRoutingSchema', () => {
  it('refuses a sort OpenRouter does not have', () => {
    expect(providerRoutingSchema.safeParse({ sort: 'fastest' }).success).toBe(false);
  });

  it('accepts the empty object as "no preferences"', () => {
    expect(providerRoutingSchema.parse({})).toEqual({});
  });
});

describe('readProviderRoutingOverride', () => {
  it('treats a stored value that no longer parses as no override', () => {
    expect(readProviderRoutingOverride({ sort: 42 })).toBeNull();
    expect(readProviderRoutingOverride(null)).toBeNull();
    expect(readProviderRoutingOverride({ sort: null })).toEqual({ sort: null });
  });
});

describe('providerNameMatches', () => {
  it('matches the tag, the part before the slash, and ignores case', () => {
    expect(providerNameMatches('deepinfra/fp8', 'deepinfra/fp8')).toBe(true);
    expect(providerNameMatches('deepinfra/fp8', 'DeepInfra')).toBe(true);
    expect(providerNameMatches('deepinfra/fp8', 'deep')).toBe(false);
  });
});
