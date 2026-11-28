/**
 * When a typed `:` starts looking for an emoji (issue #269).
 *
 * The rule is the same in the editor and in the chat field, so it is written
 * once: a colon opens the emoji list only where somebody types it as the start
 * of a word, and only once a letter follows it. A colon is far more often
 * punctuation than a shortcode, and every case below is one where opening a
 * list would get in the way of what was actually being written:
 *
 * - `12:30`, `3:1`: after a digit, a time or a ratio
 * - `https://`, `C:\`, `Hinweis:`: after a letter, an address or a label
 * - `::`, `/:`, `.:`, `@:`, `#:`: inside some notation
 * - `:)`, `:-(`, `: `: no letter after it, an emoticon or a plain colon
 * - anything inside code, which the callers judge themselves
 *
 * The query may carry digits, `_`, `+` and `-` after its first letter, which
 * is what shortcodes are made of (`thumbs_up`, `+1`).
 */
const QUERY = /^(?:\p{L}|[+-]\d)[\p{L}\p{N}_+-]*$/u;

/** A character that makes the colon after it part of a word or a notation. */
const BLOCKING_PREVIOUS = /[\p{L}\p{N}_:/\\.@#]/u;

/** Whether the text typed after a `:` reads as the start of an emoji's name. */
export function isEmojiQuery(query: string): boolean {
  return QUERY.test(query);
}

/**
 * Whether a colon after `previous` may open the list. `previous` is the single
 * character before the colon, or `''` at the start of a line. Half of a
 * surrogate pair (an emoji typed just before) matches nothing and so allows it,
 * which is what lets two emoji be typed in a row.
 */
export function colonMayOpenAfter(previous: string): boolean {
  return previous.length === 0 || !BLOCKING_PREVIOUS.test(previous);
}

/**
 * Whether the end of `text` sits inside Markdown code: a fenced block that is
 * still open, or an inline code span on the last line whose closing backticks
 * have not been typed yet. The chat field is plain Markdown, so this is how it
 * knows what the editor reads off its schema.
 */
export function endsInsideMarkdownCode(text: string): boolean {
  const lines = text.split('\n');
  let fence: string | null = null;
  for (const line of lines.slice(0, -1)) {
    const opener = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (opener === undefined) continue;
    if (fence === null) fence = opener;
    else if (opener[0] === fence[0] && opener.length >= fence.length) fence = null;
  }
  const last = lines.at(-1) ?? '';
  if (fence !== null) {
    // The last line may be the closing fence itself; nothing after it is code.
    const closing = /^ {0,3}(`{3,}|~{3,})/.exec(last)?.[1];
    return !(closing !== undefined && closing[0] === fence[0] && closing.length >= fence.length);
  }

  // Inline code: a run of backticks opens a span that only a run of the same
  // length closes (CommonMark), so count runs rather than characters.
  let open = 0;
  for (const run of last.match(/`+/g) ?? []) {
    if (open === 0) open = run.length;
    else if (run.length === open) open = 0;
  }
  return open > 0;
}

/** A shortcode being typed: where its colon is, and what follows it. */
export interface EmojiQuery {
  /** Index of the `:`. */
  from: number;
  /** Index just past the query, which is the caret. */
  to: number;
  query: string;
}

/**
 * The shortcode the caret is at the end of in a plain text field, or `null`.
 *
 * Only the text before the caret counts: the list follows the word being
 * typed, as it does in the editor.
 */
export function emojiQueryBefore(text: string, caret: number): EmojiQuery | null {
  const before = text.slice(0, caret);
  const colon = before.lastIndexOf(':');
  if (colon < 0) return null;
  const query = before.slice(colon + 1);
  if (!isEmojiQuery(query)) return null;
  if (!colonMayOpenAfter(before.slice(Math.max(0, colon - 1), colon))) return null;
  if (endsInsideMarkdownCode(before.slice(0, colon))) return null;
  return { from: colon, to: caret, query };
}

/**
 * Whether Enter takes the highlighted emoji.
 *
 * Not after a single character the highlight was never moved from: `:D`, `:P`
 * and `:o` are emoticons far more often than the start of a search, and Enter
 * after them means a new line or sending the message. Tab, a click and an
 * arrow key followed by Enter still choose.
 */
export function enterChoosesEmoji(query: string, moved: boolean): boolean {
  return moved || query.length >= 2;
}
