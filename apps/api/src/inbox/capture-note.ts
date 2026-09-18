import { type CaptureRequest } from '@exocortex/contracts';

/**
 * What a captured scrap becomes (issue #71, ADR-036).
 *
 * Capture asks for one thing, text, and a page needs two, a title and a body.
 * Deriving the first from the second is the whole trick, and it is kept here as
 * plain functions because it is the part with rules worth testing: a page whose
 * title repeats its own first line is the failure this avoids, and it is the
 * one every "quick note" feature ships with.
 */

/** Titles are capped well below the column limit: a title is a label, not the note. */
const MAX_TITLE_CHARS = 120;

/** Below this, cutting on a word boundary would throw away most of the title. */
const MIN_WORD_BOUNDARY = 60;

const HEADING_OR_LIST = /^\s{0,3}(?:#{1,6}\s+|[-*+]\s+|>\s*|\d+[.)]\s+)/;

/** Bold, italic and inline code around a whole line, which a title does not need. */
const SURROUNDING_EMPHASIS = /^[*_`]{1,3}(.*?)[*_`]{1,3}$/;

export interface CaptureNote {
  title: string;
  /** Markdown body; empty when the text was a single line that became the title. */
  markdown: string;
}

/** Lines, without the empty ones at either end. */
function lines(text: string): string[] {
  return text.replace(/\r\n?/g, '\n').split('\n');
}

function tidy(line: string): string {
  const withoutMarkers = line.replace(HEADING_OR_LIST, '').trim();
  const match = SURROUNDING_EMPHASIS.exec(withoutMarkers);
  return (match?.[1] ?? withoutMarkers).trim();
}

/** `https://example.com/blog/post?x=1` -> `example.com/blog/post`. */
export function titleFromUrl(candidate: string): string | null {
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const host = url.host.replace(/^www\./, '');
  const path = url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '');
  return `${host}${path}`;
}

export function shortenTitle(title: string): string {
  const collapsed = title.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= MAX_TITLE_CHARS) return collapsed;
  const cut = collapsed.slice(0, MAX_TITLE_CHARS);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace >= MIN_WORD_BOUNDARY ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/** `Notiz vom 18.09.2026, 14:32` -- the title a wordless capture gets. */
export function fallbackTitle(at: Date): string {
  const two = (value: number): string => String(value).padStart(2, '0');
  return (
    `Notiz vom ${two(at.getDate())}.${two(at.getMonth() + 1)}.${at.getFullYear()}, ` +
    `${two(at.getHours())}:${two(at.getMinutes())}`
  );
}

/**
 * The line a capture names itself after, and whether the body keeps it.
 *
 * The first line is the title when there is one, and it is then removed from
 * the body: showing it twice is what makes a captured one-liner look like a
 * mistake. A caller-supplied title leaves the text alone -- it said something
 * *about* the note rather than repeating it.
 */
export function buildCaptureNote(request: CaptureRequest, at: Date): CaptureNote {
  const all = lines(request.text);
  const firstIndex = all.findIndex((line) => line.trim().length > 0);
  const rest = firstIndex === -1 ? [] : all.slice(firstIndex + 1);
  const firstLine = firstIndex === -1 ? '' : tidy(all[firstIndex] ?? '');

  const explicit = request.title?.trim();
  const derived =
    firstLine.length === 0 ? null : (titleFromUrl(firstLine) ?? shortenTitle(firstLine));

  const body = explicit !== undefined && explicit.length > 0 ? all.slice(firstIndex) : rest;

  return {
    title:
      explicit !== undefined && explicit.length > 0
        ? shortenTitle(explicit)
        : (derived ?? fallbackTitle(at)),
    markdown: renderBody(body, request),
  };
}

function renderBody(body: string[], request: CaptureRequest): string {
  const text = body.join('\n').replace(/^\n+/, '').replace(/\s+$/, '');
  const source = renderSource(request);
  if (source === null) return text;
  return text.length === 0 ? source : `${text}\n\n${source}`;
}

/**
 * Provenance as one ordinary Markdown line.
 *
 * Not frontmatter and not a property: a capture has to survive being moved
 * anywhere, and a line of text is the only shape that does. Issue #72 adds the
 * fields a clipped page carries; this is the sentence a human wrote down.
 */
function renderSource(request: CaptureRequest): string | null {
  const label = request.source?.trim();
  const url = request.sourceUrl?.trim();
  if (url !== undefined && url.length > 0) {
    const text = label !== undefined && label.length > 0 ? label : (titleFromUrl(url) ?? url);
    // Brackets in the label would end the link early and leave the rest of the
    // line as stray text, so they are dropped rather than escaped: a source
    // label is a name, and a name that needs brackets is not one.
    return `Quelle: [${text.replace(/[[\]]/g, '')}](${url})`;
  }
  if (label !== undefined && label.length > 0) return `Quelle: ${label}`;
  return null;
}
