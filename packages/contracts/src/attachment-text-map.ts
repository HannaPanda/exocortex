import { z } from 'zod';

/**
 * Reading a long attachment text within a budget (issue #133, ADR-101).
 *
 * The same contract a page read keeps (ADR-056), for text that has no blocks:
 * under the budget the text comes back, over it a map of the text's parts
 * instead, never a prefix. A part is addressed by characters (`fromChar`,
 * `toChar`), and by pages wherever the extraction knew them (`fromPage`,
 * `toPage`). Handing a part back in maps that part, one level finer:
 *
 *     pages -> headings -> paragraph windows -> content
 *
 * The floor is a window no larger than the budget, cut at a blank line, a line
 * break or, failing both, a space, so every character is reachable and no
 * recursion can answer with itself. Pure functions over a string: no engine,
 * no model, nothing computed that the stored text does not already say.
 *
 * Offsets are UTF-16 code units, which is what every reader of them (the API,
 * the tool, the browser) indexes a string by.
 */

/** One addressable part of an attachment's text, as a map lists it. */
export const attachmentTextMapEntrySchema = z.object({
  /** A run of whole pages, a heading's section, or a window of paragraphs. */
  kind: z.enum(['pages', 'section', 'window']),
  /** The heading, or the part's first line. Text of the document, not of this deployment. */
  title: z.string(),
  /** The heading's level for a section; null otherwise. */
  level: z.number().int().min(1).max(6).nullable(),
  fromChar: z.number().int().nonnegative(),
  toChar: z.number().int().nonnegative(),
  chars: z.number().int().nonnegative(),
  /** The pages the part lies on, when the extraction knew pages; null otherwise. */
  fromPage: z.number().int().positive().nullable(),
  toPage: z.number().int().positive().nullable(),
  /** How many neighbouring parts this entry stands for; above one when the map merged them. */
  parts: z.number().int().positive(),
});
export type AttachmentTextMapEntry = z.infer<typeof attachmentTextMapEntrySchema>;

export const attachmentTextMapSchema = z.object({
  mode: z.enum(['pages', 'sections', 'windows']),
  entries: z.array(attachmentTextMapEntrySchema),
  /** True when neighbours were merged to keep the map within its entry limit. */
  coarsened: z.boolean(),
});
export type AttachmentTextMap = z.infer<typeof attachmentTextMapSchema>;

/** Which stretch of the text an answer covers. */
export const attachmentTextRangeSchema = z.object({
  fromChar: z.number().int().nonnegative(),
  toChar: z.number().int().nonnegative(),
  fromPage: z.number().int().positive().nullable(),
  toPage: z.number().int().positive().nullable(),
});
export type AttachmentTextRange = z.infer<typeof attachmentTextRangeSchema>;

/**
 * Where a word the caller looked for stands (issue #133): its offset, its page
 * when pages are known, and the line around it. A map shows each part's first
 * line only, so a fact in the middle of page 27 is invisible in it; this is the
 * literal way to it, no index and no model, over the stored text.
 */
export const attachmentTextMatchSchema = z.object({
  at: z.number().int().nonnegative(),
  page: z.number().int().positive().nullable(),
  /** Text of the document around the match, not of this deployment. */
  excerpt: z.string(),
});
export type AttachmentTextMatch = z.infer<typeof attachmentTextMatchSchema>;

/** Matches a `find` lists; the count beside them says how many there were. */
export const ATTACHMENT_TEXT_FIND_MAX_MATCHES = 20;

/** Entries a map lists before it merges neighbours, when the caller names no limit. */
export const ATTACHMENT_TEXT_MAP_DEFAULT_ENTRIES = 40;

/**
 * One or more pages as one stretch of text. More than one page only where a
 * page's start was not known (`-1`): it is joined to the page before it, so
 * the answer says "pages 4 to 5" rather than putting page 5 under page 4.
 */
export interface AttachmentPageUnit {
  fromPage: number;
  toPage: number;
  fromChar: number;
  toChar: number;
}

/**
 * Page starts as stored for a text cut at `keptChars`: only pages that begin
 * inside the kept text, anything that is not an offset treated as unknown.
 */
export function keptPageStarts(
  pageStarts: readonly number[] | null | undefined,
  keptChars: number,
): number[] {
  if (pageStarts === null || pageStarts === undefined) return [];
  const kept: number[] = [];
  for (const start of pageStarts) {
    if (start >= keptChars) break;
    kept.push(Number.isInteger(start) && start >= 0 ? start : -1);
  }
  if (kept.length > 0) kept[0] = 0;
  return kept;
}

/** The pages of a text of `length` characters, from its stored page starts. */
export function attachmentPageUnits(
  pageStarts: readonly number[],
  length: number,
): AttachmentPageUnit[] {
  const units: AttachmentPageUnit[] = [];
  pageStarts.forEach((stored, index) => {
    const page = index + 1;
    const previous = units.at(-1);
    const start = index === 0 ? 0 : stored;
    if (previous !== undefined && (start < 0 || start <= previous.fromChar || start >= length)) {
      previous.toPage = page;
      return;
    }
    if (previous !== undefined) previous.toChar = start;
    units.push({ fromPage: page, toPage: page, fromChar: start, toChar: length });
  });
  return units;
}

/** What a caller asked for; every field optional, as on the wire. */
export interface AttachmentTextReadRequest {
  maxChars?: number;
  maxEntries?: number;
  fromPage?: number;
  toPage?: number;
  fromChar?: number;
  toChar?: number;
  /** A word or phrase to find in the stretch, case ignored; answers where it stands. */
  find?: string;
}

export type AttachmentTextRead =
  | {
      ok: true;
      view: 'content' | 'map' | 'matches';
      /** The range's text for `content`; empty otherwise, never a prefix. */
      text: string;
      map: AttachmentTextMap | null;
      matches: AttachmentTextMatch[] | null;
      /** How many times `find` occurs in the stretch; null without `find`. */
      matchCount: number | null;
      range: AttachmentTextRange;
    }
  | { ok: false; reason: string };

/** Moves an offset off the second half of a surrogate pair, so a cut never splits a character. */
function snap(text: string, offset: number): number {
  if (offset <= 0 || offset >= text.length) return offset;
  const code = text.charCodeAt(offset);
  return code >= 0xdc00 && code <= 0xdfff ? offset - 1 : offset;
}

function unitAt(units: readonly AttachmentPageUnit[], offset: number): AttachmentPageUnit | null {
  return (
    units.find((unit) => offset >= unit.fromChar && offset < unit.toChar) ?? units.at(-1) ?? null
  );
}

/** The pages `[fromChar, toChar)` lies on, or nulls when no pages are known. */
function pagesOf(
  units: readonly AttachmentPageUnit[],
  fromChar: number,
  toChar: number,
): { fromPage: number | null; toPage: number | null } {
  if (units.length === 0) return { fromPage: null, toPage: null };
  return {
    fromPage: unitAt(units, fromChar)?.fromPage ?? null,
    toPage: unitAt(units, Math.max(fromChar, toChar - 1))?.toPage ?? null,
  };
}

/** The stretch a request names, or why it names none. */
export function resolveAttachmentTextRange(
  text: string,
  units: readonly AttachmentPageUnit[],
  request: AttachmentTextReadRequest,
): { ok: true; range: AttachmentTextRange } | { ok: false; reason: string } {
  const byPage = request.fromPage !== undefined || request.toPage !== undefined;
  const byChar = request.fromChar !== undefined || request.toChar !== undefined;
  if (byPage && byChar) {
    return { ok: false, reason: 'Name pages or characters, not both' };
  }
  if (byPage) {
    const last = units.at(-1);
    if (last === undefined) {
      return {
        ok: false,
        reason:
          'No page boundaries are known for this text; read it by fromChar and toChar from its map',
      };
    }
    const first = request.fromPage ?? 1;
    const wanted = request.toPage ?? request.fromPage ?? first;
    if (first > wanted) return { ok: false, reason: 'fromPage is after toPage' };
    if (first > last.toPage) {
      return { ok: false, reason: `Page ${first} is past the last known page, ${last.toPage}` };
    }
    const from = units.find((unit) => first <= unit.toPage) ?? last;
    const to = units.find((unit) => Math.min(wanted, last.toPage) <= unit.toPage) ?? last;
    return {
      ok: true,
      range: {
        fromChar: from.fromChar,
        toChar: to.toChar,
        fromPage: from.fromPage,
        toPage: to.toPage,
      },
    };
  }
  const fromChar = snap(text, Math.min(Math.max(request.fromChar ?? 0, 0), text.length));
  const toChar = snap(text, Math.min(Math.max(request.toChar ?? text.length, 0), text.length));
  if (byChar && fromChar >= toChar) {
    return { ok: false, reason: 'fromChar must be before toChar and inside the text' };
  }
  return { ok: true, range: { fromChar, toChar, ...pagesOf(units, fromChar, toChar) } };
}

const TITLE_CHARS = 80;

/** The first line with something on it, without its Markdown, as a title. */
function firstLine(text: string, fromChar: number, toChar: number): string {
  const head = text.slice(fromChar, Math.min(toChar, fromChar + 2_000));
  for (const line of head.split('\n')) {
    const cleaned = line
      .replace(/^\s*(?:#{1,6}\s+|[-*+>]\s+|\|)/, '')
      .replace(/\s*\|\s*/g, ' | ')
      .replace(/[\s|]+$/, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (cleaned.length === 0 || /^[-:| ]+$/.test(cleaned)) continue;
    return cleaned.length > TITLE_CHARS ? `${cleaned.slice(0, TITLE_CHARS - 1)}…` : cleaned;
  }
  return '';
}

interface Part {
  fromChar: number;
  toChar: number;
  title: string;
  level: number | null;
}

/** Where fenced code begins and ends, so a `# comment` inside it is not a heading. */
function fencedRanges(text: string, fromChar: number, toChar: number): [number, number][] {
  const ranges: [number, number][] = [];
  const fence = /^(?:```|~~~)/gm;
  fence.lastIndex = fromChar;
  let open: number | null = null;
  for (
    let match = fence.exec(text);
    match !== null && match.index < toChar;
    match = fence.exec(text)
  ) {
    if (open === null) open = match.index;
    else {
      ranges.push([open, match.index]);
      open = null;
    }
  }
  if (open !== null) ranges.push([open, toChar]);
  return ranges;
}

/** The range cut at its shallowest heading level that divides it, or null when none does. */
function sectionParts(text: string, fromChar: number, toChar: number): Part[] | null {
  const fenced = fencedRanges(text, fromChar, toChar);
  const headings: { at: number; level: number; title: string }[] = [];
  const pattern = /^(#{1,6})[ \t]+(.+?)[ \t#]*$/gm;
  pattern.lastIndex = fromChar;
  for (
    let match = pattern.exec(text);
    match !== null && match.index < toChar;
    match = pattern.exec(text)
  ) {
    const at = match.index;
    if (fenced.some(([start, end]) => at > start && at < end)) continue;
    headings.push({ at, level: match[1]?.length ?? 1, title: firstLine(text, at, toChar) });
  }
  for (let level = 1; level <= 6; level += 1) {
    const cuts = headings.filter((heading) => heading.level <= level);
    const head = cuts[0];
    if (head === undefined) continue;
    const parts: Part[] = [];
    const preamble = text.slice(fromChar, head.at).trim().length > 0;
    if (preamble) {
      parts.push({
        fromChar,
        toChar: head.at,
        title: firstLine(text, fromChar, head.at),
        level: null,
      });
    }
    cuts.forEach((cut, index) => {
      parts.push({
        // A blank preamble belongs to the first section rather than to nobody.
        fromChar: index === 0 && !preamble ? fromChar : cut.at,
        toChar: cuts[index + 1]?.at ?? toChar,
        title: cut.title,
        level: cut.level,
      });
    });
    if (parts.length >= 2) return parts;
  }
  return null;
}

/** Splits `[fromChar, toChar)` at `separator`, keeping every character in exactly one piece. */
function splitAt(
  text: string,
  fromChar: number,
  toChar: number,
  separator: RegExp,
): [number, number][] {
  const pieces: [number, number][] = [];
  let start = fromChar;
  const pattern = new RegExp(separator.source, 'g');
  pattern.lastIndex = fromChar;
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    const end = match.index + match[0].length;
    if (end >= toChar) break;
    if (end > start) pieces.push([start, end]);
    start = end;
    if (match[0].length === 0) pattern.lastIndex += 1;
  }
  pieces.push([start, toChar]);
  return pieces;
}

/** A piece no larger than `maxChars`, cut at the last space before the limit where there is one. */
function hardCut(
  text: string,
  fromChar: number,
  toChar: number,
  maxChars: number,
): [number, number][] {
  const pieces: [number, number][] = [];
  let start = fromChar;
  while (toChar - start > maxChars) {
    const limit = start + maxChars;
    let cut = limit;
    for (let index = limit; index > start + maxChars / 2; index -= 1) {
      if (/\s/.test(text[index - 1] ?? '')) {
        cut = index;
        break;
      }
    }
    cut = snap(text, cut);
    if (cut <= start) cut = limit;
    pieces.push([start, cut]);
    start = cut;
  }
  pieces.push([start, toChar]);
  return pieces;
}

/** Windows of whole paragraphs, each at most `maxChars`, so each one reads as content. */
function windowParts(text: string, fromChar: number, toChar: number, maxChars: number): Part[] {
  const pieces: [number, number][] = [];
  for (const paragraph of splitAt(text, fromChar, toChar, /\n[ \t]*\n/)) {
    if (paragraph[1] - paragraph[0] <= maxChars) {
      pieces.push(paragraph);
      continue;
    }
    for (const line of splitAt(text, paragraph[0], paragraph[1], /\n/)) {
      pieces.push(...hardCut(text, line[0], line[1], maxChars));
    }
  }
  const windows: [number, number][] = [];
  for (const [start, end] of pieces) {
    const open = windows.at(-1);
    if (open !== undefined && end - open[0] <= maxChars) open[1] = end;
    else windows.push([start, end]);
  }
  return windows.map(([start, end]) => ({
    fromChar: start,
    toChar: end,
    title: firstLine(text, start, end),
    level: null,
  }));
}

/** Neighbours merged so the map lists at most `maxEntries`, nothing dropped. */
function coarsen(
  entries: AttachmentTextMapEntry[],
  maxEntries: number,
): { entries: AttachmentTextMapEntry[]; coarsened: boolean } {
  if (entries.length <= maxEntries) return { entries, coarsened: false };
  const size = Math.ceil(entries.length / maxEntries);
  const merged: AttachmentTextMapEntry[] = [];
  for (let index = 0; index < entries.length; index += size) {
    const group = entries.slice(index, index + size);
    const first = group[0];
    const last = group.at(-1);
    if (first === undefined || last === undefined) continue;
    merged.push({
      ...first,
      toChar: last.toChar,
      chars: last.toChar - first.fromChar,
      toPage: last.toPage,
      parts: group.reduce((sum, entry) => sum + entry.parts, 0),
    });
  }
  return { entries: merged, coarsened: true };
}

/** The map of `range`: its pages, else its sections, else its paragraph windows. */
export function buildAttachmentTextMap(
  text: string,
  units: readonly AttachmentPageUnit[],
  range: AttachmentTextRange,
  limits: { maxChars: number; maxEntries: number },
): AttachmentTextMap {
  const { fromChar, toChar } = range;
  const pages = units
    .filter((unit) => unit.toChar > fromChar && unit.fromChar < toChar)
    .map((unit) => ({
      ...unit,
      fromChar: Math.max(unit.fromChar, fromChar),
      toChar: Math.min(unit.toChar, toChar),
    }));

  let mode: AttachmentTextMap['mode'];
  let entries: AttachmentTextMapEntry[];
  if (pages.length >= 2) {
    mode = 'pages';
    entries = pages.map((unit) => ({
      kind: 'pages',
      title: firstLine(text, unit.fromChar, unit.toChar),
      level: null,
      fromChar: unit.fromChar,
      toChar: unit.toChar,
      chars: unit.toChar - unit.fromChar,
      fromPage: unit.fromPage,
      toPage: unit.toPage,
      parts: 1,
    }));
  } else {
    const sections = sectionParts(text, fromChar, toChar);
    mode = sections === null ? 'windows' : 'sections';
    const parts = sections ?? windowParts(text, fromChar, toChar, limits.maxChars);
    entries = parts.map((part) => ({
      kind: sections === null ? 'window' : 'section',
      title: part.title,
      level: part.level,
      fromChar: part.fromChar,
      toChar: part.toChar,
      chars: part.toChar - part.fromChar,
      ...pagesOf(units, part.fromChar, part.toChar),
      parts: 1,
    }));
  }
  return { mode, ...coarsen(entries, limits.maxEntries) };
}

const EXCERPT_CHARS = 80;

/** Where `phrase` occurs in the stretch, case ignored, whitespace matched loosely. */
function findInAttachmentText(
  text: string,
  units: readonly AttachmentPageUnit[],
  range: AttachmentTextRange,
  phrase: string,
): { matches: AttachmentTextMatch[]; matchCount: number } {
  const words = phrase
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0);
  if (words.length === 0) return { matches: [], matchCount: 0 };
  const pattern = new RegExp(
    words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+'),
    'giu',
  );
  const stretch = text.slice(range.fromChar, range.toChar);
  const matches: AttachmentTextMatch[] = [];
  let matchCount = 0;
  for (const match of stretch.matchAll(pattern)) {
    matchCount += 1;
    if (matches.length >= ATTACHMENT_TEXT_FIND_MAX_MATCHES) continue;
    const at = range.fromChar + match.index;
    const from = snap(text, Math.max(range.fromChar, at - EXCERPT_CHARS));
    const to = snap(text, Math.min(range.toChar, at + match[0].length + EXCERPT_CHARS));
    matches.push({
      at,
      page: units.length === 0 ? null : (unitAt(units, at)?.fromPage ?? null),
      excerpt: `${from > range.fromChar ? '…' : ''}${text.slice(from, to).replace(/\s+/g, ' ').trim()}${to < range.toChar ? '…' : ''}`,
    });
  }
  return { matches, matchCount };
}

/**
 * One read: the stretch the request names, as content when it fits the
 * budget and as its map when it does not. Without `maxChars` the stretch is
 * the answer whatever its size, which is what a caller that names no budget
 * has always had.
 */
export function readAttachmentText(
  text: string,
  pageStarts: readonly number[],
  request: AttachmentTextReadRequest,
): AttachmentTextRead {
  const units = attachmentPageUnits(pageStarts, text.length);
  const resolved = resolveAttachmentTextRange(text, units, request);
  if (!resolved.ok) return resolved;
  const { range } = resolved;
  if (request.find !== undefined) {
    const found = findInAttachmentText(text, units, range, request.find);
    return { ok: true, view: 'matches', text: '', map: null, ...found, range };
  }
  const { maxChars } = request;
  if (maxChars === undefined || range.toChar - range.fromChar <= maxChars) {
    return {
      ok: true,
      view: 'content',
      text: text.slice(range.fromChar, range.toChar),
      map: null,
      matches: null,
      matchCount: null,
      range,
    };
  }
  return {
    ok: true,
    view: 'map',
    text: '',
    matches: null,
    matchCount: null,
    map: buildAttachmentTextMap(text, units, range, {
      maxChars,
      maxEntries: request.maxEntries ?? ATTACHMENT_TEXT_MAP_DEFAULT_ENTRIES,
    }),
    range,
  };
}
