import { describe, expect, it } from 'vitest';

import { signInErrorMessage } from './sign-in-error';

const WRONG_CREDENTIALS = 'E-Mail-Adresse oder Passwort ist falsch.';

describe('signInErrorMessage', () => {
  it('names the rate limiter instead of blaming the password', () => {
    // The whole point: the limit counts requests per client address, so the
    // credentials were never looked at and a person told to check them will
    // spend more attempts on the limiter that is already blocking them.
    const message = signInErrorMessage(429);

    expect(message).not.toBe(WRONG_CREDENTIALS);
    expect(message).toContain('Zu viele Anmeldeversuche');
  });

  it('keeps the wrong-credentials sentence for a refusal that looked at them', () => {
    expect(signInErrorMessage(401)).toBe(WRONG_CREDENTIALS);
    expect(signInErrorMessage(403)).toBe(WRONG_CREDENTIALS);
  });

  it('does not blame the password for a broken deployment or a lost request', () => {
    for (const status of [undefined, 0, 500, 502, 503]) {
      expect(signInErrorMessage(status)).not.toBe(WRONG_CREDENTIALS);
    }
  });

  it('leaves open which half was wrong', () => {
    // Naming the half would turn the form into an account lookup, so the two
    // stay joined by "oder".
    expect(signInErrorMessage(401)).toMatch(/E-Mail-Adresse oder Passwort/);
  });
});
