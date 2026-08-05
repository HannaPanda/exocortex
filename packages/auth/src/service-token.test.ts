import { describe, expect, it } from 'vitest';

import { SERVICE_TOKEN_PREFIX } from './api-token';
import { issueServiceToken, verifyServiceToken } from './service-token';

const secret = 'a'.repeat(64);
const otherSecret = 'b'.repeat(64);

function issue(overrides: Partial<Parameters<typeof issueServiceToken>[0]> = {}) {
  return issueServiceToken({
    secret,
    userId: 'user_1',
    purpose: 'ai-tools',
    ttlSeconds: 300,
    ...overrides,
  });
}

describe('service tokens', () => {
  it('issues a verifiable token, prefixed for readability', () => {
    const { token, expiresAt } = issue();
    expect(token.startsWith(SERVICE_TOKEN_PREFIX)).toBe(true);
    const result = verifyServiceToken({ secret, token });
    expect(result.valid).toBe(true);
    expect(result.valid && result.claims.userId).toBe('user_1');
    expect(result.valid && result.claims.purpose).toBe('ai-tools');
    expect(expiresAt).toBeGreaterThan(Date.now());
  });

  it('produces a different token every time', () => {
    expect(issue().token).not.toBe(issue().token);
  });

  it('rejects a token signed with a different secret', () => {
    const { token } = issue();
    const result = verifyServiceToken({ secret: otherSecret, token });
    expect(result.valid).toBe(false);
    expect(result.valid === false && result.reason).toBe('bad_signature');
  });

  it('rejects an expired token', () => {
    const { token } = issue({ ttlSeconds: 60, now: Date.now() - 120_000 });
    const result = verifyServiceToken({ secret, token });
    expect(result.valid).toBe(false);
    expect(result.valid === false && result.reason).toBe('expired');
  });

  it('rejects malformed tokens', () => {
    for (const token of ['', 'no-dot', `${SERVICE_TOKEN_PREFIX}a.b.c`, 'not-base64.signature']) {
      const result = verifyServiceToken({ secret, token });
      expect(result.valid).toBe(false);
    }
  });

  it('verifies a token whether or not the caller strips the prefix first', () => {
    const { token } = issue();
    const withoutPrefix = token.slice(SERVICE_TOKEN_PREFIX.length);
    expect(verifyServiceToken({ secret, token: withoutPrefix }).valid).toBe(true);
    expect(verifyServiceToken({ secret, token }).valid).toBe(true);
  });
});
