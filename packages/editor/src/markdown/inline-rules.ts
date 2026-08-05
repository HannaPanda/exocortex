import type MarkdownIt from 'markdown-it';

/**
 * markdown-it ships a class merged with a namespace, and the CommonJS typings
 * only re-export the constructor. Every other type is therefore derived from the
 * instance so this module needs no `any` (CLAUDE.md rule 7).
 */
export type MarkdownItInstance = InstanceType<typeof MarkdownIt>;
type InlineRule = Parameters<MarkdownItInstance['inline']['ruler']['before']>[2];
type InlineState = Parameters<InlineRule>[0];

interface InlineMarkerDefinition {
  /** Delimiter that opens and closes the span, for example `==`. */
  marker: string;
  /** Token name; produces `<name>_open` and `<name>_close`. */
  token: string;
  /** HTML tag reported on the token, following the markdown-it convention. */
  tag: string;
  /**
   * Single-character delimiters (`^`, `~`) only wrap a run without whitespace,
   * which is what markdown-it-sup and markdown-it-sub do. Without that rule a
   * lone caret in prose would swallow the rest of the paragraph.
   */
  allowInnerWhitespace: boolean;
}

/**
 * The inline syntax Exocortex adds on top of CommonMark and GFM.
 *
 * These are implemented as real markdown-it rules rather than as a regular
 * expression over the parsed text, because only a rule sees the source before
 * the escape rule has run. That is what makes `\==nicht hervorgehoben\==` work.
 */
const INLINE_MARKERS: readonly InlineMarkerDefinition[] = [
  { marker: '==', token: 'highlight', tag: 'mark', allowInnerWhitespace: true },
  { marker: '++', token: 'underline', tag: 'u', allowInnerWhitespace: true },
  { marker: '^', token: 'superscript', tag: 'sup', allowInnerWhitespace: false },
  { marker: '~', token: 'subscript', tag: 'sub', allowInnerWhitespace: false },
];

/** Token type prefixes contributed here, keyed to the Exocortex mark name. */
export const EXOCORTEX_INLINE_MARK_TOKENS: Readonly<Record<string, string>> = {
  // A Markdown highlight is a background colour in the Exocortex schema.
  highlight: 'textColor',
  underline: 'underline',
  superscript: 'superscript',
  subscript: 'subscript',
};

/** True when the character at `index` is preceded by an odd number of backslashes. */
function isEscaped(source: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && source[cursor] === '\\'; cursor -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

function isWhitespace(character: string | undefined): boolean {
  return character === undefined || /\s/.test(character);
}

/**
 * Finds the closing delimiter, or `-1`. The content must be non-empty and must
 * not begin or end with whitespace, mirroring how emphasis behaves.
 */
function findClosingMarker(
  state: InlineState,
  contentStart: number,
  definition: InlineMarkerDefinition,
): number {
  const { marker, allowInnerWhitespace } = definition;
  if (isWhitespace(state.src[contentStart])) return -1;

  for (let index = contentStart + 1; index + marker.length <= state.posMax; index += 1) {
    if (!state.src.startsWith(marker, index)) continue;
    if (isEscaped(state.src, index)) continue;
    // A doubled single-character delimiter belongs to another rule (`~~`).
    if (marker.length === 1 && state.src.startsWith(marker.repeat(2), index)) continue;
    if (isWhitespace(state.src[index - 1])) continue;
    if (!allowInnerWhitespace && /\s/.test(state.src.slice(contentStart, index))) return -1;
    return index;
  }
  return -1;
}

function createInlineRule(definition: InlineMarkerDefinition): InlineRule {
  const { marker, token, tag } = definition;

  return (state: InlineState, silent: boolean): boolean => {
    // Validation mode (for example while scanning a link label) must not emit.
    if (silent) return false;

    const start = state.pos;
    if (!state.src.startsWith(marker, start)) return false;
    if (marker.length === 1 && state.src.startsWith(marker.repeat(2), start)) return false;

    const contentStart = start + marker.length;
    if (contentStart >= state.posMax) return false;

    const closing = findClosingMarker(state, contentStart, definition);
    if (closing === -1) return false;

    const previousMax = state.posMax;
    state.push(`${token}_open`, tag, 1);
    state.pos = contentStart;
    state.posMax = closing;
    state.md.inline.tokenize(state);
    state.push(`${token}_close`, tag, -1);
    state.pos = closing + marker.length;
    state.posMax = previousMax;
    return true;
  };
}

/** Token type of an inline mention; `info` carries the kind. */
export const MENTION_TOKEN = 'exocortex_mention';

/** The `@` that opens a mention. Kept here so this module has no imports. */
const MENTION_TRIGGER = '@';
const AT_SIGN = 0x40;

/**
 * Mention notation, one form per kind:
 *
 * ```markdown
 * @[[Seitentitel]]     eine Seite
 * @[Anna Beispiel]     eine Person
 * @(2026-08-04)        ein Datum
 * ```
 *
 * The page form deliberately echoes the `[[Seite]]` wiki link, so the two ways of
 * referring to a page look related in the source. The double bracket is tried
 * first, otherwise `@[[x]]` would parse as a person named `[x`.
 */
const MENTION_FORMS: readonly { kind: string; open: string; close: string }[] = [
  { kind: 'page', open: '[[', close: ']]' },
  { kind: 'user', open: '[', close: ']' },
  { kind: 'date', open: '(', close: ')' },
];

const mentionRule: InlineRule = (state: InlineState, silent: boolean): boolean => {
  if (silent) return false;
  if (state.src.charCodeAt(state.pos) !== AT_SIGN) return false;

  for (const form of MENTION_FORMS) {
    if (!state.src.startsWith(form.open, state.pos + 1)) continue;
    const contentStart = state.pos + 1 + form.open.length;

    const closing = state.src.indexOf(form.close, contentStart);
    if (closing === -1 || closing + form.close.length > state.posMax) continue;
    const label = state.src.slice(contentStart, closing).trim();
    if (label.length === 0) continue;

    const token = state.push(MENTION_TOKEN, 'span', 0);
    token.content = label;
    token.info = form.kind;
    token.markup = MENTION_TRIGGER;
    state.pos = closing + form.close.length;
    return true;
  }
  return false;
};

/**
 * Registers the Exocortex inline rules on a markdown-it instance.
 *
 * They are inserted before `emphasis`, which puts them after `escape` and after
 * `strikethrough`, so `\^` stays literal and `~~x~~` stays a strikethrough.
 */
export function applyExocortexInlineRules(md: MarkdownItInstance): void {
  for (const definition of INLINE_MARKERS) {
    md.inline.ruler.before(
      'emphasis',
      `exocortex_${definition.token}`,
      createInlineRule(definition),
    );
  }
  // Before `link`, so `@[Name]` is a mention and not a link label.
  md.inline.ruler.before('link', MENTION_TOKEN, mentionRule);
}
