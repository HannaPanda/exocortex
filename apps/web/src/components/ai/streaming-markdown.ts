/**
 * Keeping an answer that is still arriving from rewriting what is already on
 * screen (issue #242).
 *
 * Two things made a streamed answer look nervous. The whole text was parsed
 * again on every update, so every block was rebuilt although only the last
 * one could still change. And the last line, while it was half written, was
 * read as something it was not yet: a lone `-` under a sentence turned that
 * sentence into a heading for a moment, `**bo` printed its asterisks and then
 * swallowed them, a link showed its address and then hid it.
 *
 * `splitSettledMarkdown` answers the first: it cuts the text where a block is
 * over for good, so the blocks before the cut are parsed once and kept. The
 * cut is only made where Markdown guarantees that nothing written later can
 * reach back across it. `stabilizeStreamingTail` answers the second: it holds
 * back the syntax that has not decided yet what it is, and closes an emphasis
 * or a code span that is still open. Neither of them delays a word: what is
 * held back is markup, never text, and it is held only while it is the very
 * last thing that arrived.
 *
 * Only the live bubble goes through either of them. A finished answer is
 * parsed whole, as it always was, so the stored text stays the one truth.
 */

/** An opening or closing code fence: three or more backticks or tildes. */
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const LIST_MARKER = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/;
/** Indented enough to continue a list item or to be indented code. */
const INDENTED = /^(?: {2,}|\t)/;
const BLANK = /^[ \t]*$/;

interface OpenFence {
  char: string;
  length: number;
}

function openingFence(line: string): OpenFence | null {
  const match = FENCE.exec(line);
  if (match === null) return null;
  const run = match[1]!;
  // A backtick fence may not carry a backtick in its info string; that line
  // is inline code, not a fence.
  if (run.startsWith('`') && line.slice(match[0].length).includes('`')) return null;
  return { char: run[0]!, length: run.length };
}

function closesFence(line: string, fence: OpenFence): boolean {
  const match = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
  return match !== null && match[1]![0] === fence.char && match[1]!.length >= fence.length;
}

/**
 * Splits `markdown` into the blocks that are over (`settled`, each a piece of
 * source that parses the same on its own as inside the whole) and what may
 * still change (`tail`). Joining `settled` and `tail` gives back the input.
 *
 * A cut is made at a blank line that something new has already followed,
 * outside a fenced code block, and never where the new line could still
 * belong to what stood above it: an item or an indented line after a list
 * continues that list, and an indented line after indented code continues
 * that code.
 */
export function splitSettledMarkdown(markdown: string): { settled: string[]; tail: string } {
  const settled: string[] = [];
  let segmentStart = 0;
  let segmentHasContent = false;
  let segmentHasList = false;
  let lastContentIndented = false;
  let blankSinceContent = false;
  let fence: OpenFence | null = null;

  let offset = 0;
  while (offset < markdown.length) {
    const newline = markdown.indexOf('\n', offset);
    const end = newline === -1 ? markdown.length : newline + 1;
    const line = markdown.slice(offset, newline === -1 ? markdown.length : newline);

    if (fence !== null) {
      if (closesFence(line, fence)) fence = null;
      lastContentIndented = false;
      offset = end;
      continue;
    }

    if (BLANK.test(line)) {
      if (segmentHasContent) blankSinceContent = true;
      offset = end;
      continue;
    }

    const indented = INDENTED.test(line);
    const listItem = LIST_MARKER.test(line);
    const continues =
      (segmentHasList && (listItem || indented)) || (indented && lastContentIndented);
    if (blankSinceContent && !continues) {
      settled.push(markdown.slice(segmentStart, offset));
      segmentStart = offset;
      segmentHasList = false;
    }

    blankSinceContent = false;
    segmentHasContent = true;
    if (listItem) segmentHasList = true;
    lastContentIndented = indented;
    fence = openingFence(line);
    offset = end;
  }

  return { settled, tail: markdown.slice(segmentStart) };
}

/**
 * A last line that is nothing but syntax which has not decided yet what it
 * is: a list marker, a rule or setext underline, an empty heading or quote,
 * the start of a code fence, a table's delimiter row in the making.
 */
const UNDECIDED_LINE =
  /^ {0,3}(?:[-*+_=]+|#{1,6}|>|\d{1,9}[.)]?|`{1,2}|(?:`{3,}|~{3,})[^`]*|\|?[ \t]*:?-[-:| \t]*)[ \t]*$/;
/** A partial closing fence inside open code, which would otherwise print as code. */
const PARTIAL_CLOSING_FENCE = /^ {0,3}[`~]+[ \t]*$/;

/** Whether `markdown` ends inside a fenced code block. */
function endsInsideFence(markdown: string): boolean {
  let fence: OpenFence | null = null;
  for (const line of markdown.split('\n')) {
    if (fence === null) fence = openingFence(line);
    else if (closesFence(line, fence)) fence = null;
  }
  return fence !== null;
}

/** Without the code spans, whose contents are never emphasis. */
function withoutCodeSpans(text: string): string {
  return text.replace(/`[^`\n]*`/g, '');
}

/** Closes `marker` before any trailing whitespace, where a closing marker has to sit. */
function closeBeforeTrailingSpace(text: string, marker: string): string {
  const match = /[ \t]*$/.exec(text);
  const cut = match === null ? text.length : match.index;
  return `${text.slice(0, cut)}${marker}${text.slice(cut)}`;
}

/**
 * The open inline constructs of the paragraph that is being written: a
 * marker that has just been typed is dropped, an emphasis or code span that
 * has content is closed, and a link that is still being written shows its
 * words without the brackets and the address that would vanish a moment
 * later.
 */
function closeOpenInlines(text: string): string {
  // An opener with nothing after it yet: dropping it shows nothing less.
  let result = text.replace(/(^|[\s(])(?:\*{1,3}|_{1,3}|~{1,2}|`+)$/, '$1');

  result = result.replace(/\[\[([^[\]\n]*)\]?$/, '[[$1]]');
  result = result.replace(/(^|[^[\]])\[([^[\]\n]*)\]\([^)\s]*$/, '$1$2');
  result = result.replace(/(^|[^[\]])\[([^[\]\n]*)\]?$/, '$1$2');

  const paragraph = result.slice(result.search(/[^\n]*(?:\n[^\n]+)*$/));
  const backticks = (paragraph.match(/`/g) ?? []).length;
  if (backticks % 2 === 1) return closeBeforeTrailingSpace(result, '`');

  const prose = withoutCodeSpans(paragraph);
  const strong = (prose.match(/\*\*/g) ?? []).length;
  if (strong % 2 === 1) result = closeBeforeTrailingSpace(result, '**');

  // A single asterisk that is neither a list marker nor standing alone
  // between spaces (a multiplication) opens or closes emphasis.
  const single = prose
    .replace(/\*\*/g, '')
    .replace(/^[ \t]*\*[ \t]/gm, '')
    .replace(/[ \t]\*[ \t]/g, ' ');
  if ((single.match(/\*/g) ?? []).length % 2 === 1) {
    result = closeBeforeTrailingSpace(result, '*');
  }
  return result;
}

/**
 * The tail of a streaming answer, as it should be parsed right now so that
 * nothing on screen has to be taken back when the next fragment arrives.
 */
export function stabilizeStreamingTail(tail: string): string {
  const lineStart = tail.lastIndexOf('\n') + 1;
  const lastLine = tail.slice(lineStart);
  const head = tail.slice(0, lineStart);

  if (endsInsideFence(head)) {
    // The open code block shows what it has; a closing fence on its way in is
    // not code and would otherwise print as a line of backticks.
    return PARTIAL_CLOSING_FENCE.test(lastLine) ? head : tail;
  }
  if (lastLine.length === 0) return tail;
  if (UNDECIDED_LINE.test(lastLine)) return head;
  return closeOpenInlines(tail);
}
