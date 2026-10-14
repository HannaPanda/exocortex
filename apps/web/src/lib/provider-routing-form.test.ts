import { describe, expect, it } from 'vitest';

import {
  addProviderName,
  formFromRouting,
  routingFromForm,
  sameRouting,
} from './provider-routing-form';

describe('formFromRouting and routingFromForm', () => {
  it('round-trips a setting, unknown keys included', () => {
    const stored = {
      sort: 'throughput' as const,
      ignore: ['relace'],
      allow_fallbacks: false,
      max_price: { prompt: 1 },
      quantizations: ['fp8'],
    };
    const result = routingFromForm(formFromRouting(stored), 'setting');
    expect(result).toEqual({ ok: true, value: stored });
    expect(result.ok && sameRouting(result.value, stored)).toBe(true);
  });

  it('keeps the three states of an override apart', () => {
    const stored = { sort: null, only: ['deepinfra/fp8'], data_collection: 'deny' as const };
    const form = formFromRouting(stored);
    expect(form.sort).toEqual({ state: 'remove' });
    expect(form.lists.ignore).toEqual({ state: 'unset' });
    expect(routingFromForm(form, 'override')).toEqual({ ok: true, value: stored });
  });

  it('round-trips an empty list as an empty list', () => {
    const stored = { only: [] };
    expect(routingFromForm(formFromRouting(stored), 'override')).toEqual({
      ok: true,
      value: stored,
    });
  });

  it('writes nothing for an empty form', () => {
    expect(routingFromForm(formFromRouting(null), 'override')).toEqual({ ok: true, value: {} });
  });

  it('never writes null into the setting', () => {
    const form = formFromRouting({ sort: null });
    expect(routingFromForm(form, 'setting')).toEqual({ ok: true, value: {} });
  });

  it('puts unknown keys into the extra text', () => {
    expect(formFromRouting({ sort: 'price', max_price: { prompt: 1 } }).extra).toBe(
      JSON.stringify({ max_price: { prompt: 1 } }, null, 2),
    );
    expect(formFromRouting({ sort: 'price' }).extra).toBe('');
  });

  it('refuses extra text that is no object, or names a field', () => {
    const form = formFromRouting(null);
    expect(routingFromForm({ ...form, extra: '{ broken' }, 'setting')).toEqual({
      ok: false,
      reason: 'extraInvalid',
    });
    expect(routingFromForm({ ...form, extra: '[1]' }, 'setting')).toEqual({
      ok: false,
      reason: 'extraInvalid',
    });
    expect(routingFromForm({ ...form, extra: '{"sort": "price"}' }, 'setting')).toEqual({
      ok: false,
      reason: 'extraKnownKey',
    });
  });

  it('refuses a list the schema refuses', () => {
    const form = formFromRouting(null);
    form.lists.only = { state: 'set', value: [''] };
    expect(routingFromForm(form, 'setting')).toEqual({ ok: false, reason: 'invalid' });
  });
});

describe('sameRouting', () => {
  it('ignores key order, not values', () => {
    expect(sameRouting({ a: 1, b: { c: 2, d: 3 } }, { b: { d: 3, c: 2 }, a: 1 })).toBe(true);
    expect(sameRouting({ only: ['a', 'b'] }, { only: ['b', 'a'] })).toBe(false);
  });
});

describe('addProviderName', () => {
  it('adds a trimmed name once, ignoring case', () => {
    expect(addProviderName(['DeepInfra'], ' deepinfra ')).toEqual(['DeepInfra']);
    expect(addProviderName(['a'], ' b ')).toEqual(['a', 'b']);
    expect(addProviderName(['a'], '  ')).toEqual(['a']);
  });
});
