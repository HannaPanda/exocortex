import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { API_ERROR_CODES } from '@exocortex/contracts';
import { messagesFor } from '@exocortex/i18n/catalog';

import { installErrorTranslator, messageForCode } from './error-messages';

const german = messagesFor('de').errors.codes;

describe('messageForCode', () => {
  beforeAll(() => installErrorTranslator((code) => german[code]));
  afterAll(() => installErrorTranslator(null));

  it('has a sentence for every code the API can return', () => {
    // The point of the test: a new code in `packages/contracts` without a
    // message would silently show the generic sentence in the UI, which
    // reads as a bug in the app rather than as the thing that actually went
    // wrong. The typed `t(code)` in the providers catches the same gap at
    // compile time; this says it in words.
    const missing = API_ERROR_CODES.filter((code) => typeof german[code] !== 'string');

    expect(missing).toEqual([]);
  });

  it('answers with the catalogue sentence, never with the developer message', () => {
    expect(messageForCode('forbidden')).toBe(german.forbidden);
  });

  it('falls back to the generic message for anything it does not know', () => {
    expect(messageForCode('teapot')).toBe(german.internal_error);
    expect(messageForCode(undefined)).toBe(german.internal_error);
    // A response body is untrusted input, so a prototype key must not resolve.
    expect(messageForCode('toString')).toBe(german.internal_error);
  });

  it('answers with the code itself before a translator is installed', () => {
    installErrorTranslator(null);
    expect(messageForCode('forbidden')).toBe('forbidden');
    installErrorTranslator((code) => german[code]);
  });
});
