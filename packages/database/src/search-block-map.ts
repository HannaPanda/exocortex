import { type SearchResult } from '@exocortex/contracts';

/**
 * Where every stretch of a page's search projection came from (issue #280).
 *
 * A keyword hit is a position in `document_search_index.plainText`, and until
 * this existed nothing mapped that position back onto the page: the search
 * named the page and left the caller to guess where on it the words were. The
 * indexer now stores this map beside the text, in the same write, so the text
 * a snippet is cut from and the map a hit is located with can never belong to
 * two different versions of the page.
 *
 * A hit belongs to the last unit starting at or before its offset. A unit is a
 * top-level block, a list point (at any depth, since #274 made them
 * addressable on their own), or the text of one attachment appended behind
 * the page (issue #101).
 */
export interface SearchBlockMapInput {
  /** The whole projected text, page and attachment text together. */
  text: string;
  /** Ascending by offset. Offsets are JavaScript (UTF-16) indices into `text`. */
  units: readonly SearchBlockMapUnit[];
  headings: readonly { blockId: string | null; path: readonly string[] }[];
  attachments: readonly { attachmentId: string; filename: string }[];
}

export interface SearchBlockMapUnit {
  offset: number;
  /** The block to read the hit with; for attachment text, the block showing the file. */
  blockId: string | null;
  /** Index into `headings`, or `null` for text under no heading. */
  heading: number | null;
  /** Index into `attachments` for attachment text, `null` for the page's own text. */
  attachment: number | null;
}

/**
 * The stored shape: parallel arrays, because a page of three thousand list
 * points would otherwise repeat four key names three thousand times, and short
 * keys for the same reason. `o` is in characters (code points), which is what
 * PostgreSQL's `strpos` and `length` count, not in UTF-16 units: one emoji
 * before a hit would otherwise move every offset after it by one.
 *
 * Offsets: `o`; block ids: `b`; section index: `s`; attachment index: `a`;
 * headings: `h` (`b` block id, `p` path); attachments: `f` (`id`, `n` name).
 */
export interface StoredSearchBlockMap {
  o: number[];
  b: (string | null)[];
  s: (number | null)[];
  a: (number | null)[];
  h: { b: string | null; p: string[] }[];
  f: { id: string; n: string }[];
}

/** The map as the `blockMap` column stores it. */
export function toStoredBlockMap(input: SearchBlockMapInput): StoredSearchBlockMap {
  const offsets = codePointOffsets(
    input.text,
    input.units.map((unit) => unit.offset),
  );
  return {
    o: offsets,
    b: input.units.map((unit) => unit.blockId),
    s: input.units.map((unit) => unit.heading),
    a: input.units.map((unit) => unit.attachment),
    h: input.headings.map((heading) => ({ b: heading.blockId, p: [...heading.path] })),
    f: input.attachments.map((file) => ({ id: file.attachmentId, n: file.filename })),
  };
}

/**
 * The same positions counted in code points rather than UTF-16 units, in one
 * pass over the text. `offsets` must be ascending.
 */
export function codePointOffsets(text: string, offsets: readonly number[]): number[] {
  const result: number[] = [];
  let index = 0;
  let points = 0;
  for (const offset of offsets) {
    const target = Math.min(offset, text.length);
    while (index < target) {
      const code = text.charCodeAt(index);
      const next = text.charCodeAt(index + 1);
      const pair = code >= 0xd800 && code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff;
      index += pair ? 2 : 1;
      points += 1;
    }
    result.push(points);
  }
  return result;
}

/** What one search row's lookup in the map produced, as raw SQL hands it back. */
export interface LocatedRow {
  hitBlockId: string | null;
  hitHeading: unknown;
  hitAttachment: unknown;
}

/** Where on the page a keyword hit stands, in the contract's words. */
export function hitLocation(
  row: LocatedRow,
): Pick<SearchResult, 'blockId' | 'section' | 'attachment'> {
  return {
    blockId: row.hitBlockId ?? null,
    section: headingOf(row.hitHeading),
    attachment: attachmentOf(row.hitAttachment),
  };
}

function headingOf(value: unknown): SearchResult['section'] {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as { b?: unknown; p?: unknown };
  if (!Array.isArray(record.p) || record.p.length === 0) return null;
  return {
    blockId: typeof record.b === 'string' ? record.b : null,
    path: record.p.filter((entry): entry is string => typeof entry === 'string'),
  };
}

function attachmentOf(value: unknown): SearchResult['attachment'] {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as { id?: unknown; n?: unknown };
  if (typeof record.id !== 'string') return null;
  return { attachmentId: record.id, filename: typeof record.n === 'string' ? record.n : '' };
}

/** Whether a hit says anything about where on its page it stands. */
export function isLocated(hit: Pick<SearchResult, 'blockId' | 'section' | 'attachment'>): boolean {
  return hit.section !== null || hit.blockId !== null || hit.attachment !== null;
}
