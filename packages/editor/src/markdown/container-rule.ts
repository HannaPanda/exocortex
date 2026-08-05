import { type MarkdownItInstance } from './inline-rules';

type BlockRule = Parameters<MarkdownItInstance['block']['ruler']['before']>[2];

/**
 * The Exocortex container syntax for block nodes that CommonMark has no notation
 * for: toggles, columns, a table of contents, page links, media and embeds.
 *
 * ```markdown
 * :::toggle Zusammenfassung
 * Inhalt der Klappbox
 * :::
 * ```
 *
 * It follows the widely used generic-directive convention (`remark-directive`,
 * MkDocs, Docusaurus), so an exported file stays readable and stays diffable. Like
 * a code fence, the marker may be longer than three colons, which is how
 * containers nest:
 *
 * ```markdown
 * ::::columns
 * :::column
 * links
 * :::
 * :::column
 * rechts
 * :::
 * ::::
 * ```
 *
 * The rule only produces `container_open` / `container_close` tokens carrying the
 * name and the parameter string. Mapping a name onto a node is the job of the
 * extension that owns it, through its `tokens` adapter.
 */
const COLON = 0x3a;
const MIN_MARKER_LENGTH = 3;
const NAME_PATTERN = /^([a-z][a-z0-9-]*)[ \t]*(.*)$/;

/** Token type prefix; the name goes into `token.info`. */
export const CONTAINER_TOKEN = 'exocortex_container';

/** Reads the container name and parameters from an open token. */
export function readContainerToken(info: string): { name: string; params: string } {
  const match = NAME_PATTERN.exec(info.trim());
  if (match === null) return { name: '', params: '' };
  return { name: match[1] ?? '', params: (match[2] ?? '').trim() };
}

const containerRule: BlockRule = (state, startLine, endLine, silent) => {
  let start = state.bMarks[startLine]! + state.tShift[startLine]!;
  const max = state.eMarks[startLine]!;

  // Four spaces of indentation would be a code block.
  if (state.sCount[startLine]! - state.blkIndent >= 4) return false;
  if (state.src.charCodeAt(start) !== COLON) return false;

  let pos = start;
  while (pos < max && state.src.charCodeAt(pos) === COLON) pos += 1;
  const markerLength = pos - start;
  if (markerLength < MIN_MARKER_LENGTH) return false;

  const match = NAME_PATTERN.exec(state.src.slice(pos, max).trim());
  if (match === null) return false;
  if (silent) return true;

  const marker = ':'.repeat(markerLength);

  // Find the closing line: the same number of colons and nothing else on it.
  let nextLine = startLine;
  let closed = false;
  while (nextLine + 1 < endLine) {
    nextLine += 1;
    start = state.bMarks[nextLine]! + state.tShift[nextLine]!;
    const lineMax = state.eMarks[nextLine]!;
    if (state.sCount[nextLine]! - state.blkIndent >= 4) continue;
    if (state.src.slice(start, lineMax).trim() !== marker) continue;
    closed = true;
    break;
  }
  // An unclosed container runs to the end of the block, like an unclosed fence.
  if (!closed) nextLine = endLine;

  const previousMax = state.lineMax;
  const previousParent = state.parentType;
  state.parentType = 'exocortexContainer';
  state.lineMax = nextLine;

  const open = state.push(`${CONTAINER_TOKEN}_open`, 'div', 1);
  open.markup = marker;
  open.info = state.src.slice(pos, state.eMarks[startLine]!).trim();
  open.map = [startLine, nextLine];

  state.md.block.tokenize(state, startLine + 1, nextLine);

  const close = state.push(`${CONTAINER_TOKEN}_close`, 'div', -1);
  close.markup = marker;
  // The name is repeated on the closing token so the importer can close exactly
  // the nodes this container opened without keeping its own stack.
  close.info = open.info;

  state.lineMax = previousMax;
  state.parentType = previousParent;
  state.line = closed ? nextLine + 1 : nextLine;
  return true;
};

/** Token type of a display math block. */
export const MATH_BLOCK_TOKEN = 'exocortex_math_block';
/** Token type of an inline math span. */
export const MATH_INLINE_TOKEN = 'exocortex_math_inline';

const DOLLAR = 0x24;

/**
 * `$$ … $$` on its own lines, the notation every Markdown dialect with maths
 * support uses. The LaTeX source lands in `token.content` verbatim: it is code, so
 * nothing inside it is parsed.
 */
const mathBlockRule: BlockRule = (state, startLine, endLine, silent) => {
  const start = state.bMarks[startLine]! + state.tShift[startLine]!;
  const max = state.eMarks[startLine]!;

  if (state.sCount[startLine]! - state.blkIndent >= 4) return false;
  if (state.src.charCodeAt(start) !== DOLLAR || state.src.charCodeAt(start + 1) !== DOLLAR) {
    return false;
  }

  const firstLineRest = state.src.slice(start + 2, max).trim();
  let nextLine = startLine;
  let latex = firstLineRest;
  let closed = firstLineRest.endsWith('$$') && firstLineRest.length > 1;

  if (closed) {
    latex = firstLineRest.slice(0, -2).trim();
  } else {
    const lines: string[] = firstLineRest.length > 0 ? [firstLineRest] : [];
    while (nextLine + 1 < endLine) {
      nextLine += 1;
      const lineStart = state.bMarks[nextLine]! + state.tShift[nextLine]!;
      const lineMax = state.eMarks[nextLine]!;
      const text = state.src.slice(lineStart, lineMax);
      if (text.trim() === '$$') {
        closed = true;
        break;
      }
      lines.push(text);
    }
    if (!closed) return false;
    latex = lines.join('\n').trim();
  }
  if (silent) return true;

  const token = state.push(MATH_BLOCK_TOKEN, 'math', 0);
  token.content = latex;
  token.markup = '$$';
  token.map = [startLine, nextLine + 1];
  state.line = nextLine + 1;
  return true;
};

type InlineRule = Parameters<MarkdownItInstance['inline']['ruler']['before']>[2];
type InlineState = Parameters<InlineRule>[0];

/**
 * `$ … $` inline maths.
 *
 * Requires a non-space directly after the opening dollar and before the closing
 * one, and refuses a digit immediately after the closing dollar, so prices such
 * as `$5 und $9` are not read as a formula.
 */
const mathInlineRule: InlineRule = (state: InlineState, silent: boolean): boolean => {
  if (silent) return false;
  const start = state.pos;
  if (state.src.charCodeAt(start) !== DOLLAR) return false;
  if (state.src.charCodeAt(start + 1) === DOLLAR) return false;

  const contentStart = start + 1;
  if (contentStart >= state.posMax) return false;
  if (/\s/.test(state.src[contentStart] ?? ' ')) return false;

  for (let index = contentStart + 1; index < state.posMax; index += 1) {
    if (state.src.charCodeAt(index) !== DOLLAR) continue;
    if (isEscaped(state.src, index)) continue;
    if (/\s/.test(state.src[index - 1] ?? ' ')) continue;
    if (/\d/.test(state.src[index + 1] ?? '')) continue;

    const token = state.push(MATH_INLINE_TOKEN, 'math', 0);
    token.content = state.src.slice(contentStart, index);
    token.markup = '$';
    state.pos = index + 1;
    return true;
  }
  return false;
};

function isEscaped(source: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && source[cursor] === '\\'; cursor -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

/** Registers the container and mathematics rules on a markdown-it instance. */
export function applyExocortexBlockRules(md: MarkdownItInstance): void {
  md.block.ruler.before('fence', CONTAINER_TOKEN, containerRule, {
    alt: ['paragraph', 'reference', 'blockquote', 'list'],
  });
  md.block.ruler.before('fence', MATH_BLOCK_TOKEN, mathBlockRule, {
    alt: ['paragraph', 'reference', 'blockquote', 'list'],
  });
  md.inline.ruler.before('escape', MATH_INLINE_TOKEN, mathInlineRule);
}
