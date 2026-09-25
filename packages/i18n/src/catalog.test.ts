import { describe, expect, it } from 'vitest';

import { SUPPORTED_LOCALES } from '@exocortex/contracts';

import { messagesFor, NAMESPACES, pickMessages } from './catalog.js';

function shape(value: unknown): unknown {
  if (typeof value === 'string') return 'text';
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, shape(child)]),
  );
}

describe('messagesFor', () => {
  it('gives every locale the German shape', () => {
    const german = shape(messagesFor('de'));
    for (const locale of SUPPORTED_LOCALES) expect(shape(messagesFor(locale))).toEqual(german);
  });

  it('answers in the locale asked for, not in German', () => {
    expect(messagesFor('en').settings.language.title).not.toBe(
      messagesFor('de').settings.language.title,
    );
  });
});

describe('pickMessages', () => {
  it('hands over only the namespaces named', () => {
    const [first] = NAMESPACES;
    if (first === undefined) return;
    expect(Object.keys(pickMessages('fr', [first]))).toEqual([first]);
  });
});
