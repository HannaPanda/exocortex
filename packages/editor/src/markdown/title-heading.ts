import { BLOCK_ID_SUFFIX_PATTERN } from './document-builder';
import { FRONTMATTER_PATTERN } from './frontmatter';

/**
 * A page's title lives in its metadata, never in its body: the Markdown
 * serializer writes it into the frontmatter and never as a heading (ADR-007).
 * A first-level heading at the top of a page that only repeats the title is
 * therefore always redundant -- and agents write it constantly, because that is
 * what a Markdown file looks like everywhere else.
 *
 * These helpers find that one heading and nothing else. They work on the
 * Markdown text rather than on the parsed document so the stored Markdown and
 * the canonical Yjs state are produced from exactly the same string.
 */

/** ATX form: `# Titel`, up to three leading spaces, optional closing hashes. */
const ATX_HEADING_1 = /^[ \t]{0,3}#[ \t]+(.*?)[ \t]*#*[ \t]*$/;

/** Setext form: the underline below `Titel`. */
const SETEXT_UNDERLINE_1 = /^[ \t]{0,3}=+[ \t]*$/;

/** Inline emphasis, code and link syntax, which say nothing about sameness. */
const INLINE_MARKUP = /[*_`~[\]]/gu;

/** Everything that is neither a letter, a number nor a space. */
const NOISE = /[^\p{L}\p{N} ]/gu;

/**
 * The comparison form of a title.
 *
 * Case, punctuation, emoji and repeated whitespace are noise when the question
 * is "did something write the title twice"; the words are the signal. „Schritt
 * 1: Setup“ and „Schritt 1 – Setup“ are the same title written by two
 * different writers.
 */
export function normalizeTitleForComparison(value: string): string {
  return value
    .normalize('NFC')
    .toLowerCase()
    .replace(INLINE_MARKUP, '')
    .replace(NOISE, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

export interface StrippedTitleHeading {
  /** The Markdown to use, unchanged when nothing was removed. */
  markdown: string;
  /** Text of the heading that was removed, `null` when none was. */
  removed: string | null;
}

interface LeadingHeading {
  text: string;
  /** Index of the first body line after the heading. */
  end: number;
}

function splitFrontmatter(markdown: string): { head: string; body: string } {
  const match = FRONTMATTER_PATTERN.exec(markdown);
  if (match === null) return { head: '', body: markdown };
  return { head: match[0], body: markdown.slice(match[0].length) };
}

function withoutBlockId(text: string): string {
  const match = BLOCK_ID_SUFFIX_PATTERN.exec(text);
  return (match === null ? text : text.slice(0, match.index)).trim();
}

function findLeadingHeading(lines: readonly string[], first: number): LeadingHeading | null {
  const line = lines[first];
  if (line === undefined) return null;

  const atx = ATX_HEADING_1.exec(line);
  if (atx !== null) return { text: withoutBlockId(atx[1] ?? ''), end: first + 1 };

  const underline = lines[first + 1];
  if (underline !== undefined && SETEXT_UNDERLINE_1.test(underline)) {
    return { text: withoutBlockId(line.trim()), end: first + 2 };
  }
  return null;
}

/**
 * Reads the first-level heading a Markdown body opens with, if it opens with
 * one. Used where a title has to be derived from content that is about to lose
 * that heading.
 */
export function leadingTitleHeading(markdown: string): string | null {
  const lines = splitFrontmatter(markdown).body.split('\n');
  let first = 0;
  while (first < lines.length && (lines[first] ?? '').trim().length === 0) first += 1;
  const heading = findLeadingHeading(lines, first);
  if (heading === null || heading.text.length === 0) return null;
  return heading.text;
}

/**
 * Removes a first-level heading at the top of `markdown` when it only repeats
 * `title`.
 *
 * Deliberately narrow: only the very first block, only level one, only an exact
 * match once both sides are normalized. A heading that merely resembles the
 * title is left alone -- guessing there would be deleting somebody's content on
 * a hunch. A page whose entire body is that heading keeps it too, because
 * emptying a page is a worse outcome than a repeated line.
 */
export function stripRedundantTitleHeading(markdown: string, title: string): StrippedTitleHeading {
  const normalizedTitle = normalizeTitleForComparison(title);
  if (normalizedTitle.length === 0) return { markdown, removed: null };

  const { head, body } = splitFrontmatter(markdown);
  const lines = body.split('\n');
  let first = 0;
  while (first < lines.length && (lines[first] ?? '').trim().length === 0) first += 1;

  const heading = findLeadingHeading(lines, first);
  if (heading === null) return { markdown, removed: null };
  if (normalizeTitleForComparison(heading.text) !== normalizedTitle) {
    return { markdown, removed: null };
  }

  const rest = lines.slice(heading.end);
  if (rest.every((line) => line.trim().length === 0)) return { markdown, removed: null };
  while ((rest[0] ?? '').trim().length === 0) rest.shift();

  return { markdown: `${head}${rest.join('\n')}`, removed: heading.text };
}
