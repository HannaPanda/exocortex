import { describe, expect, it } from 'vitest';

import {
  boundEmbeddingInputByBytes,
  EMBEDDING_MAX_INPUT_TOKENS,
  EMBEDDING_TOKEN_BUDGET,
  estimateEmbeddingTokens,
  fitEmbeddingInput,
} from './embedding-budget';

/**
 * Texts whose real token count is known.
 *
 * Each one is generated from a fixed seed, and the count beside it is what
 * `openai/text-embedding-3-small` reported as `usage.prompt_tokens` for exactly
 * this string on 2026-11-28 (issue #329). They are the reason the estimate can
 * be called conservative: lowering a weight until one of them is
 * underestimated turns this file red.
 */
function generator(seed: number): {
  int: (below: number) => number;
  pick: (from: string) => string;
} {
  let state = seed;
  const next = (): number => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
  const int = (below: number): number => Math.floor(next() * below);
  const pick = (from: string): string => from[int(from.length)] ?? '';
  return { int, pick };
}

function filled(seed: number, chars: number, part: (g: ReturnType<typeof generator>) => string) {
  const g = generator(seed);
  let text = '';
  while (text.length < chars) text += part(g);
  return text.slice(0, chars);
}

const pad = (value: number, width: number): string => String(value).padStart(width, '0');

/** A line of a bank statement as a PDF extraction hands it over. */
const statementLine = ({ int, pick }: ReturnType<typeof generator>): string =>
  `${pad(1 + int(28), 2)}.${pad(1 + int(12), 2)}.2026 ${pick('LGUD')}${pick('aeiou')}${pick('srtn')}ift ` +
  `Kd.-Nr. ${int(100_000)}-${pad(int(1000), 3)} ${int(2) === 0 ? '-' : ''}${int(10)}.${pad(int(1000), 3)},${pad(int(100), 2)} EUR ` +
  `Saldo ${int(100)}.${pad(int(1000), 3)},${pad(int(100), 2)} | ${int(100)},${int(10)} % | Bel. ${int(1e6)}\n`;

const GERMAN =
  'Die Seite beschreibt, wie der Kalender Erinnerungen verschickt und warum eine Wiederholung ' +
  'am Monatsende anders gerechnet wird als in der Mitte des Monats. Wer einen Termin verschiebt, ' +
  'verschiebt auch die Erinnerung, außer sie wurde schon zugestellt; dann bleibt sie, wie sie war. ' +
  'Für Feiertage gibt es keine Sonderregel, weil die Kalender, aus denen sie kommen, sich darin ' +
  'nicht einig sind. Größere Änderungen an der Zeitzone übernimmt der Server beim nächsten Abgleich.\n';

const MEASURED: readonly { name: string; text: string; tokens: number }[] = [
  { name: 'German prose', text: filled(1, 6000, () => GERMAN), tokens: 1602 },
  { name: 'bank statement', text: filled(2, 6000, statementLine), tokens: 3157 },
  {
    name: 'single digits',
    text: filled(3, 6000, ({ int }) => `${int(10)} `),
    tokens: 6000,
  },
  {
    name: 'hex digests',
    text: filled(
      4,
      6000,
      ({ pick }) => `${Array.from({ length: 32 }, () => pick('0123456789abcdef')).join('')}\n`,
    ),
    tokens: 3543,
  },
  {
    name: 'Base64',
    text: filled(5, 6000, ({ pick }) =>
      pick('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'),
    ),
    tokens: 4280,
  },
  {
    name: 'random letters',
    text: filled(6, 6000, ({ pick }) =>
      pick('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'),
    ),
    tokens: 3973,
  },
  {
    name: 'CJK',
    text: filled(7, 3000, ({ int }) => String.fromCodePoint(0x4e00 + int(0x51a5))),
    tokens: 7034,
  },
  {
    name: 'emoji',
    text: filled(8, 2000, ({ int }) => String.fromCodePoint(0x1f600 + int(0x50))),
    tokens: 2171,
  },
  {
    name: 'accented letters',
    text: filled(9, 6000, ({ int, pick }) =>
      int(5) === 0 ? ' ' : pick('áàâäãåæçéèêëíìîïñóòôöõøœúùûüýÿßđħŧ'),
    ),
    tokens: 6257,
  },
  {
    name: 'punctuation',
    text: filled(
      10,
      6000,
      ({ int, pick }) => `${pick('!"#$%&()*+,-./:;<=>?@[\\]^_`{|}~')}${int(4) === 0 ? ' ' : ''}`,
    ),
    tokens: 3559,
  },
  {
    name: 'mathematical symbols',
    text: filled(
      11,
      3000,
      ({ int }) => `${String.fromCodePoint(0x2200 + int(0x100))}${int(3) === 0 ? ' ' : ''}`,
    ),
    tokens: 5406,
  },
  {
    name: 'Arabic',
    text: filled(12, 6000, ({ int }) =>
      int(5) === 0 ? ' ' : String.fromCodePoint(0x627 + int(25)),
    ),
    tokens: 6176,
  },
];

describe('estimateEmbeddingTokens', () => {
  it.each(MEASURED)('never counts fewer tokens than the model did: $name', ({ text, tokens }) => {
    expect(estimateEmbeddingTokens(text)).toBeGreaterThanOrEqual(tokens);
  });

  it('stays close enough on prose that a page keeps most of its reach', () => {
    const prose = MEASURED[0];
    if (prose === undefined) throw new Error('expected the prose sample');
    expect(estimateEmbeddingTokens(prose.text)).toBeLessThan(prose.tokens * 1.5);
  });

  it('counts nothing for nothing', () => {
    expect(estimateEmbeddingTokens('')).toBe(0);
  });
});

describe('fitEmbeddingInput', () => {
  // 24000 characters of figures: the length the character limit let through.
  // The provider refuses exactly this string ("maximum input length is 8192
  // tokens"); fitted, it is 13936 characters and 7324 real tokens.
  const statement = filled(13, 24_000, statementLine);

  it('cuts a figure-heavy text that the character limit let through', () => {
    expect(estimateEmbeddingTokens(statement)).toBeGreaterThan(EMBEDDING_MAX_INPUT_TOKENS);

    const fitted = fitEmbeddingInput(statement);

    expect(fitted.length).toBeLessThan(statement.length);
    expect(estimateEmbeddingTokens(fitted)).toBeLessThanOrEqual(EMBEDDING_TOKEN_BUDGET);
    expect(statement.startsWith(fitted)).toBe(true);
  });

  // 24000 characters of this prose are 6409 real tokens; fitted, 22894
  // characters remain.
  it('leaves prose of the old length nearly whole', () => {
    const prose = filled(14, 24_000, () => GERMAN);

    expect(fitEmbeddingInput(prose).length).toBeGreaterThan(20_000);
  });

  it('returns a text inside the budget unchanged', () => {
    expect(fitEmbeddingInput('Termine am Freitag.')).toBe('Termine am Freitag.');
  });

  it('cuts between pieces, never through a number', () => {
    const fitted = fitEmbeddingInput('Betrag 123456789 '.repeat(50), 40);

    expect(fitted).toMatch(/(?:Betrag|\d{3})$/u);
    expect(estimateEmbeddingTokens(fitted)).toBeLessThanOrEqual(40);
  });

  it('gives the same answer every time, because the answer is hashed', () => {
    expect(fitEmbeddingInput(statement)).toBe(fitEmbeddingInput(statement));
  });
});

describe('boundEmbeddingInputByBytes', () => {
  const bytes = (text: string): number => new TextEncoder().encode(text).length;

  it('keeps a text no longer than the bound', () => {
    expect(boundEmbeddingInputByBytes('kurz')).toBe('kurz');
  });

  it('cuts to the bound in UTF-8 bytes, whatever the characters are', () => {
    for (const text of ['ä'.repeat(9000), '€'.repeat(9000), '😀'.repeat(9000), 'x'.repeat(9000)]) {
      const bounded = boundEmbeddingInputByBytes(text);
      expect(bytes(bounded)).toBeLessThanOrEqual(EMBEDDING_MAX_INPUT_TOKENS);
      expect(bytes(bounded)).toBeGreaterThan(EMBEDDING_MAX_INPUT_TOKENS - 4);
    }
  });

  it('never splits a character that takes two UTF-16 units', () => {
    const bounded = boundEmbeddingInputByBytes('😀'.repeat(10), 10);

    expect(bounded).toBe('😀😀');
  });
});
