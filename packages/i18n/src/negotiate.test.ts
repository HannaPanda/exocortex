import { describe, expect, it } from 'vitest';

import { matchLocale, negotiateLocale, resolveLocale } from './negotiate.js';

describe('matchLocale', () => {
  it('takes an exact tag regardless of case', () => {
    expect(matchLocale('pt-br')).toBe('pt-BR');
    expect(matchLocale('FR')).toBe('fr');
  });

  it('falls back from a region we do not have to its language', () => {
    expect(matchLocale('en-GB')).toBe('en');
    expect(matchLocale('pt-PT')).toBe('pt-BR');
    expect(matchLocale('de-AT')).toBe('de');
  });

  it('answers null for a language this deployment does not speak', () => {
    expect(matchLocale('ja-JP')).toBeNull();
  });
});

describe('negotiateLocale', () => {
  it('follows quality before order', () => {
    expect(negotiateLocale('en;q=0.5, pl;q=0.9')).toBe('pl');
  });

  it('keeps the browser order for equal weights', () => {
    expect(negotiateLocale('nl, en')).toBe('nl');
  });

  it('skips unsupported languages, wildcards and zero weights', () => {
    expect(negotiateLocale('ja, *, fr;q=0, it;q=0.3')).toBe('it');
  });

  it('answers null for no header and for nothing usable', () => {
    expect(negotiateLocale(null)).toBeNull();
    expect(negotiateLocale('ja, zh')).toBeNull();
  });
});

describe('resolveLocale', () => {
  it('prefers the account choice over cookie and browser', () => {
    expect(resolveLocale({ preference: 'es', cookie: 'fr', acceptLanguage: 'en' })).toBe('es');
  });

  it('uses the cookie while the account has not chosen', () => {
    expect(resolveLocale({ preference: null, cookie: 'fr', acceptLanguage: 'en' })).toBe('fr');
  });

  it('ignores a cookie that names no supported locale', () => {
    expect(resolveLocale({ cookie: 'xx', acceptLanguage: 'en-US' })).toBe('en');
  });

  it('ends in German when nothing is known', () => {
    expect(resolveLocale({})).toBe('de');
  });
});
