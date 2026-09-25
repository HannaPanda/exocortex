import { describe, expect, it } from 'vitest';

import { createProviderRoutingResolver } from './provider-routing';

describe('createProviderRoutingResolver', () => {
  it('merges the model override over the setting', async () => {
    const resolve = createProviderRoutingResolver({
      readGlobal: async () => ({ sort: 'throughput', ignore: ['relace'] }),
      readOverride: async (model) => (model === 'fast/model' ? { sort: 'latency' } : null),
    });

    expect(await resolve('fast/model')).toEqual({ sort: 'latency', ignore: ['relace'] });
    expect(await resolve('other/model')).toEqual({ sort: 'throughput', ignore: ['relace'] });
  });

  it('reads once per model while the answer is fresh', async () => {
    let now = 0;
    let reads = 0;
    const resolve = createProviderRoutingResolver({
      readGlobal: async () => {
        reads += 1;
        return {};
      },
      readOverride: async () => null,
      now: () => now,
    });

    await resolve('a/model');
    await resolve('a/model');
    expect(reads).toBe(1);

    now = 20_000;
    await resolve('a/model');
    expect(reads).toBe(2);
  });

  it('ignores a stored override that does not parse', async () => {
    const resolve = createProviderRoutingResolver({
      readGlobal: async () => ({ sort: 'price' }),
      readOverride: async () => ({ sort: 'fastest' }),
    });

    expect(await resolve('a/model')).toEqual({ sort: 'price' });
  });
});
