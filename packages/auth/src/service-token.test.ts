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
    const result = verifyServiceToken({ secret, token, expectedPurpose: 'ai-tools' });
    expect(result.valid).toBe(true);
    expect(result.valid && result.claims.userId).toBe('user_1');
    expect(result.valid && result.claims.purpose).toBe('ai-tools');
    expect(expiresAt).toBeGreaterThan(Date.now());
  });

  it('carries the run it was minted for, and nothing when minted for none (issue #140)', () => {
    const withRun = verifyServiceToken({
      secret,
      token: issue({ runId: 'run_1' }).token,
      expectedPurpose: 'ai-tools',
    });
    expect(withRun.valid && withRun.claims.runId).toBe('run_1');
    const without = verifyServiceToken({
      secret,
      token: issue().token,
      expectedPurpose: 'ai-tools',
    });
    expect(without.valid && 'runId' in without.claims).toBe(false);
  });

  it('produces a different token every time', () => {
    expect(issue().token).not.toBe(issue().token);
  });

  it('rejects a token signed with a different secret', () => {
    const { token } = issue();
    const result = verifyServiceToken({ secret: otherSecret, token, expectedPurpose: 'ai-tools' });
    expect(result.valid).toBe(false);
    expect(result.valid === false && result.reason).toBe('bad_signature');
  });

  it('rejects an expired token', () => {
    const { token } = issue({ ttlSeconds: 60, now: Date.now() - 120_000 });
    const result = verifyServiceToken({ secret, token, expectedPurpose: 'ai-tools' });
    expect(result.valid).toBe(false);
    expect(result.valid === false && result.reason).toBe('expired');
  });

  it('rejects malformed tokens', () => {
    for (const token of ['', 'no-dot', `${SERVICE_TOKEN_PREFIX}a.b.c`, 'not-base64.signature']) {
      const result = verifyServiceToken({ secret, token, expectedPurpose: 'ai-tools' });
      expect(result.valid).toBe(false);
    }
  });

  it('verifies a token whether or not the caller strips the prefix first', () => {
    const { token } = issue();
    const withoutPrefix = token.slice(SERVICE_TOKEN_PREFIX.length);
    expect(
      verifyServiceToken({ secret, token: withoutPrefix, expectedPurpose: 'ai-tools' }).valid,
    ).toBe(true);
    expect(verifyServiceToken({ secret, token, expectedPurpose: 'ai-tools' }).valid).toBe(true);
  });

  /**
   * The two service paths (worker -> API, API -> collaboration server) use the
   * same format with different secrets. Should they ever be given the same one,
   * the purpose still has to keep them apart.
   */
  it('rejects a correctly signed token issued for a different purpose', () => {
    const { token } = issue({ purpose: 'collaboration-write' });
    const result = verifyServiceToken({ secret, token, expectedPurpose: 'ai-tools' });
    expect(result.valid).toBe(false);
    expect(result.valid === false && result.reason).toBe('wrong_purpose');
    expect(
      verifyServiceToken({ secret, token, expectedPurpose: 'collaboration-write' }).valid,
    ).toBe(true);
  });
});
