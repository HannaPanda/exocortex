/**
 * How much text one embedding may be built from, counted in tokens (issue #329).
 *
 * `text-embedding-3-small` refuses an input above 8191 tokens, and how many
 * tokens a character costs depends on what the character is. German prose
 * spends about 3.7 characters per token, a table of amounts and dates out of a
 * PDF about 1.7, a column of single digits one, a mathematical symbol less than
 * one. A limit in characters is therefore right for one kind of text and wrong
 * for the next: 24000 characters of prose are 6500 tokens, 24000 characters of
 * a bank statement are 15000, and the provider answers the second with a 400.
 *
 * So the budget is counted in tokens, by an estimate rather than the model's
 * own tokenizer. The tokenizer would be exact, but it is a vocabulary of a
 * hundred thousand entries shipped with every process that indexes, for a
 * question an estimate answers well enough once it is built to err on one side.
 * The estimate follows how the `cl100k` tokenizer cuts text before it looks
 * anything up: a run of letters, one to three digits, a run of punctuation, a
 * run of whitespace. A token never crosses those boundaries, so every piece is
 * at least one token, and the cost inside a piece is set per kind of character
 * from measurements against the real tokenizer (the `usage` the provider
 * reports). Across prose, code, tables, identifiers, hashes, Base64, emoji,
 * CJK, Cyrillic, Arabic, Thai and Devanagari it came out between 1.02 and 1.8
 * times the real count, never below it; German prose sits at about 1.3, so a
 * page of prose still reaches about 22000 characters.
 *
 * An estimate can still be wrong for a text nobody measured, which is what
 * `boundEmbeddingInputByBytes` is for: it is not a second estimate but a proof,
 * used only after the provider has refused for length.
 */

/** What `text-embedding-3-small` and `-large` accept in one input. */
export const EMBEDDING_MAX_INPUT_TOKENS = 8191;

/**
 * What the estimate may spend on one input. Below the model's limit so that the
 * estimate's own margin is not the only one.
 */
export const EMBEDDING_TOKEN_BUDGET = 8000;

/**
 * How `cl100k` pre-tokenizes, in JavaScript's dialect. Each match is one piece
 * the tokenizer looks up on its own.
 */
const PIECE =
  /'(?:[sdmt]|ll|ve|re)|[^\r\n\p{L}\p{N}]?\p{L}+|\p{N}{1,3}| ?[^\s\p{L}\p{N}]+[\r\n]*|\s*[\r\n]+|\s+(?!\S)|\s+/giu;

const WHITESPACE = /^\s+$/u;
const DIGITS = /^\p{N}+$/u;

/** ASCII letters per token while a run still looks like a word. */
const LETTERS_PER_TOKEN = 4;
/** Length beyond which a run of letters is no longer a word but a string. */
const WORD_LENGTH = 12;
/** ASCII letters per token in the part of a run beyond a word's length. */
const STRING_LETTERS_PER_TOKEN = 1.5;
/** Extra tokens per change between lower and upper case inside a word. */
const CASE_CHANGE_TOKENS = 0.75;
/** Tokens per ASCII punctuation character, and per repetition of the one before. */
const PUNCTUATION_TOKENS = 0.8;
const REPEATED_PUNCTUATION_TOKENS = 0.25;
/** Tokens per line break, and per other whitespace character, in a run of whitespace. */
const LINE_BREAK_TOKENS = 0.5;
const SPACES_PER_TOKEN = 16;
/** Tokens per character outside ASCII, by the length of its UTF-8 encoding. */
const TWO_BYTE_TOKENS = 1.3;
const THREE_BYTE_TOKENS = 2.4;
const FOUR_BYTE_TOKENS = 3.2;
/** Applied to the sum, so that the measured worst case still has room. */
const MARGIN = 1.1;

/** Cost of a character outside ASCII, or `null` for an ASCII one. */
function wideCharacterCost(codePoint: number): number | null {
  if (codePoint < 0x80) return null;
  if (codePoint < 0x800) return TWO_BYTE_TOKENS;
  if (codePoint < 0x10000) return THREE_BYTE_TOKENS;
  return FOUR_BYTE_TOKENS;
}

function isAsciiLetter(character: string): boolean {
  return (character >= 'a' && character <= 'z') || (character >= 'A' && character <= 'Z');
}

function whitespaceCost(piece: string): number {
  let breaks = 0;
  for (const character of piece) if (character === '\n' || character === '\r') breaks += 1;
  return Math.max(
    1,
    Math.ceil(breaks * LINE_BREAK_TOKENS + (piece.length - breaks) / SPACES_PER_TOKEN),
  );
}

function digitsCost(piece: string): number {
  // One to three ASCII digits are one token; `cl100k` holds every number up to 999.
  let wide = 0;
  for (const character of piece) wide += wideCharacterCost(character.codePointAt(0) ?? 0) ?? 0;
  return wide > 0 ? Math.ceil(wide) : 1;
}

/** A piece of letters, punctuation or symbols, with the optional character in front. */
function textCost(piece: string): number {
  let cost = 0;
  let run = 0;
  let caseChanges = 0;
  let previousUpper: boolean | null = null;
  let previousPunctuation = '';
  let first = true;

  const closeRun = (): void => {
    if (run === 0) return;
    const word = Math.min(run, WORD_LENGTH);
    cost +=
      Math.ceil(word / LETTERS_PER_TOKEN) +
      Math.max(0, run - WORD_LENGTH) / STRING_LETTERS_PER_TOKEN +
      caseChanges * CASE_CHANGE_TOKENS;
    run = 0;
    caseChanges = 0;
    previousUpper = null;
  };

  for (const character of piece) {
    const wide = wideCharacterCost(character.codePointAt(0) ?? 0);
    if (wide !== null) {
      closeRun();
      cost += wide;
      previousPunctuation = '';
    } else if (isAsciiLetter(character)) {
      const upper = character <= 'Z';
      // "Haus" and "HAUS" are ordinary words; a case change further in is
      // what an identifier or a random string looks like.
      if (previousUpper !== null && upper !== previousUpper && run >= 2 && run < WORD_LENGTH) {
        caseChanges += 1;
      }
      previousUpper = upper;
      run += 1;
      previousPunctuation = '';
    } else if (!(first && character === ' ')) {
      // A leading space rides along with the piece and costs nothing.
      closeRun();
      cost += character === previousPunctuation ? REPEATED_PUNCTUATION_TOKENS : PUNCTUATION_TOKENS;
      previousPunctuation = character;
    }
    first = false;
  }
  closeRun();
  return Math.max(1, Math.ceil(cost));
}

function pieceCost(piece: string): number {
  if (WHITESPACE.test(piece)) return whitespaceCost(piece);
  if (DIGITS.test(piece)) return digitsCost(piece);
  return textCost(piece);
}

/** Estimated tokens of a text for an embedding model, never meant as exact. */
export function estimateEmbeddingTokens(text: string): number {
  let total = 0;
  for (const match of text.matchAll(PIECE)) total += pieceCost(match[0]);
  return Math.ceil(total * MARGIN);
}

/**
 * The longest beginning of a text whose estimate stays within the budget, cut
 * between two pieces so no word or number is split.
 *
 * Deterministic, which the caller relies on: the search adapter hashes what
 * comes back to decide whether a page has to be embedded again. It stops
 * reading at the budget, so a page of two million characters costs what its
 * first few thousand do.
 */
export function fitEmbeddingInput(text: string, budget: number = EMBEDDING_TOKEN_BUDGET): string {
  const allowed = budget / MARGIN;
  let total = 0;
  for (const match of text.matchAll(PIECE)) {
    total += pieceCost(match[0]);
    if (total > allowed) return text.slice(0, match.index).trimEnd();
  }
  return text;
}

/** Bytes of one code point in UTF-8. */
function utf8Length(codePoint: number): number {
  if (codePoint < 0x80) return 1;
  if (codePoint < 0x800) return 2;
  if (codePoint < 0x10000) return 3;
  return 4;
}

/**
 * The beginning of a text that is at most `maxTokens` bytes long in UTF-8.
 *
 * Not an estimate. The tokenizers of OpenAI's embedding models are byte-pair
 * encodings over UTF-8, and every token stands for at least one byte, so a text
 * of n bytes is never more than n tokens. That makes this the cut that cannot
 * be refused for length, at the price of keeping only about a third of a page
 * of prose -- which is why it is the answer to a refusal, never the first try.
 */
export function boundEmbeddingInputByBytes(
  text: string,
  maxTokens: number = EMBEDDING_MAX_INPUT_TOKENS,
): string {
  // A character is at most three UTF-16 units for four bytes, so a text this
  // short in units cannot be longer in bytes than the bound.
  if (text.length * 3 <= maxTokens) return text;
  let bytes = 0;
  let end = 0;
  for (const character of text) {
    bytes += utf8Length(character.codePointAt(0) ?? 0);
    if (bytes > maxTokens) return text.slice(0, end);
    end += character.length;
  }
  return text;
}
