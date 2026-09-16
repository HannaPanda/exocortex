import { describe, expect, it } from 'vitest';

import { API_ERROR_CODES } from '@exocortex/contracts';

import { messageForCode } from './error-messages';

describe('messageForCode', () => {
  it('has a German sentence for every code the API can return', () => {
    // The point of the test: a new code in `packages/contracts` without a
    // message here would silently show "Unerwarteter Fehler" in the UI, which
    // reads as a bug in the app rather than as the thing that actually went
    // wrong.
    const generic = messageForCode('internal_error');
    const missing = API_ERROR_CODES.filter(
      (code) => code !== 'internal_error' && messageForCode(code) === generic,
    );

    expect(missing).toEqual([]);
  });

  it('answers in German and never with the developer message', () => {
    expect(messageForCode('forbidden')).toBe('Dafür fehlen dir die Rechte.');
  });

  it('falls back to the generic message for anything it does not know', () => {
    const generic = 'Unerwarteter Fehler. Bitte versuche es erneut.';

    expect(messageForCode('teapot')).toBe(generic);
    expect(messageForCode(undefined)).toBe(generic);
    // A response body is untrusted input, so a prototype key must not resolve.
    expect(messageForCode('toString')).toBe(generic);
  });
});
