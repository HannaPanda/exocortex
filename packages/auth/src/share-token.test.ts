import { describe, expect, it } from 'vitest';

import { API_TOKEN_PREFIX } from './api-token';
import { generateShareToken, hashShareToken, looksLikeShareToken, shareUrl } from './share-token';

/**
 * Share-link tokens (issue #83, ADR-044).
 *
 * The properties worth pinning are the ones a rewrite could quietly lose: the
 * raw value is not derivable from what is stored, two links never collide, and
 * the value cannot be mistaken for a bearer credential.
 */
describe('generateShareToken', () => {
  it('stores only a hash of a value it returns once', () => {
    const token = generateShareToken();
    expect(hashShareToken(token.secret)).toBe(token.tokenHash);
    expect(token.tokenHash).not.toContain(token.secret);
    expect(token.tokenHash).toHaveLength(64);
  });

  it('gives a prefix long enough to recognise and too short to use', () => {
    const token = generateShareToken();
    expect(token.prefix).toHaveLength(8);
    expect(token.secret.startsWith(token.prefix)).toBe(true);
  });

  it('does not look like a bearer token', () => {
    // `exo_` means "Authorization: Bearer" everywhere else in this system, and
    // this value authenticates nobody: it names a grant.
    expect(generateShareToken().secret.startsWith(API_TOKEN_PREFIX)).toBe(false);
  });

  it('does not repeat itself', () => {
    const seen = new Set(Array.from({ length: 50 }, () => generateShareToken().secret));
    expect(seen.size).toBe(50);
  });
});

describe('looksLikeShareToken', () => {
  it('accepts what the generator produces', () => {
    expect(looksLikeShareToken(generateShareToken().secret)).toBe(true);
  });

  it('rejects obvious nonsense without a database round trip', () => {
    expect(looksLikeShareToken('')).toBe(false);
    expect(looksLikeShareToken('short')).toBe(false);
    expect(looksLikeShareToken(`${'a'.repeat(43)}/../etc/passwd`)).toBe(false);
    expect(looksLikeShareToken('a'.repeat(200))).toBe(false);
  });
});

describe('shareUrl', () => {
  it('builds the address a person opens', () => {
    expect(shareUrl('https://exocortex.app', 'abc-DEF_123')).toBe(
      'https://exocortex.app/freigabe/abc-DEF_123',
    );
  });
});
