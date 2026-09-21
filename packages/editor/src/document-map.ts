import { BLOCK_ID_ATTRIBUTE, isValidBlockId } from './block-id';
import { type ProseMirrorDocument, type ProseMirrorNode } from './contract';
import { serializeMarkdown } from './markdown';
import { serializePlainText } from './plain-text';
import { extractBlockFragment } from './transclusion-fragment';

/**
 * Reading a page by address instead of by the pound (issue #118).
 *
 * A page can grow without a bound -- this deployment already holds one of
 * 2.9 million characters -- while every agent reading it has a fixed context.
 * Answering such a page with its first N characters is what produced the
 * failure this module exists for: the section somebody asked about sat behind
 * the cut, the answer said only "gekürzt", and the model spent twenty tool
 * calls guessing at addresses until the run hit its iteration limit.
 *
 * So above a budget a page does not answer with its text. It answers with a
 * *map*: what is in it, how big each part is, and the address to read that part
 * with. A map is bounded by construction, which is the whole point -- it costs
 * the same thirty lines whether the page holds 20 thousand characters or 3
 * million.
 *
 * The recursion has a floor, and it needs one. Sections are cut at headings,
 * and a page may simply not have them: the 2.9 million character page has 26
 * headings, so its sections average 112 thousand characters of flat
 * paragraphs. A map of headings would bottom out there with nothing to offer,
 * so a part without an inner heading is mapped as **block ranges** instead:
 *
 *     page -> heading map -> subheading map -> block-range map -> content
 *
 * Everything here is a pure function over ProseMirror JSON, like
 * `transclusion-fragment.ts`, so the API can answer with a map and the editor's
 * tests can prove one without a database.
 *
 * Only the top level of a document is mapped. A heading nested inside a column
 * or a toggle is content of that block, not a section of the page, and
 * `extractBlockFragment` still addresses it directly for anyone who knows it is
 * there.
 */

/** Entries one map offers before it coarsens rather than grows. */
export const DEFAULT_MAX_MAP_ENTRIES = 40;

/** Characters of the first block a range entry shows, so two ranges read apart. */
const RANGE_PREVIEW_CHARS = 80;

/** What an entry addresses: a heading's section, or a window of sibling blocks. */
export type DocumentMapEntryKind = 'section' | 'range';

/** One addressable part of a document, as a map lists it. */
export interface DocumentMapEntry {
  kind: DocumentMapEntryKind;
  /**
   * Address of the part: the block to read from. `null` for a part whose
   * blocks carry no identifier yet, which is a page the editor has not
   * touched since identifiers existed. Such a part is named but cannot be
   * opened, and saying so is better than offering an address that resolves
   * somewhere else.
   */
  fromBlockId: string | null;
  /** Last block of the range. `null` when the entry is one section or one block. */
  toBlockId: string | null;
  /** Heading level for a section, `null` for a range. */
  level: number | null;
  /** The heading, or a description of the window. */
  title: string;
  /** Characters of Markdown this part holds. */
  chars: number;
  /** Top-level blocks this part covers. */
  blocks: number;
}

export interface DocumentMap {
  /** How the parts were cut: at headings, or into windows of blocks. */
  mode: 'sections' | 'ranges';
  totalChars: number;
  totalBlocks: number;
  entries: DocumentMapEntry[];
  /**
   * `true` when neighbouring parts had to be merged to stay inside the entry
   * budget. The reader is then one level coarser than the document is, and
   * opening an entry maps it further.
   */
  coarsened: boolean;
}

export interface BuildDocumentMapOptions {
  maxEntries?: number;
  /**
   * The document's own Markdown length, when the caller already has it.
   *
   * A caller reaches for a map *because* it just serialized something too
   * large; serializing it again here would double the cost of the answer for
   * a number that is already in hand.
   */
  totalChars?: number;
}

interface Measured {
  node: ProseMirrorNode;
  chars: number;
  blockId: string | null;
  level: number | null;
}

function blockIdOf(node: ProseMirrorNode): string | null {
  const value: unknown = node.attrs?.[BLOCK_ID_ATTRIBUTE];
  return isValidBlockId(value) ? value : null;
}

function headingLevel(node: ProseMirrorNode): number | null {
  if (node.type !== 'heading') return null;
  const level = node.attrs?.level;
  return typeof level === 'number' ? level : 1;
}

function textOf(node: ProseMirrorNode): string {
  return serializePlainText({ type: 'doc', content: [node] })
    .replace(/\s+/g, ' ')
    .trim();
}

function measure(nodes: readonly ProseMirrorNode[]): Measured[] {
  return nodes.map((node) => ({
    node,
    // Measured one block at a time: the sum is a character or two off the
    // joined document per block boundary, and a map is a signpost rather than
    // an accountant. The document's own total below is exact.
    chars: serializeMarkdown({ type: 'doc', content: [node] }).length,
    blockId: blockIdOf(node),
    level: headingLevel(node),
  }));
}

function firstAddressable(items: readonly Measured[]): string | null {
  for (const item of items) if (item.blockId !== null) return item.blockId;
  return null;
}

function lastAddressable(items: readonly Measured[]): string | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const blockId = (items[index] as Measured).blockId;
    if (blockId !== null) return blockId;
  }
  return null;
}

function sumChars(items: readonly Measured[]): number {
  return items.reduce((total, item) => total + item.chars, 0);
}

/**
 * The range address of a group.
 *
 * `to` is always stated, even when it is `from`. A range of one block that
 * left its end open would be read with section semantics, and if that block is
 * a heading the answer would be the whole section again: the entry would map
 * to something larger than itself, which is how a map turns into a loop.
 */
function rangeOf(items: readonly Measured[]): { from: string | null; to: string | null } {
  return { from: firstAddressable(items), to: lastAddressable(items) };
}

/**
 * Groups top-level blocks at the shallowest heading level the document uses.
 *
 * The shallowest level rather than a fixed one, because a page whose sections
 * are `##` should be cut at `##` and not answer "no headings". Anything before
 * the first heading is its own group: it is content, and content nobody can
 * address is content nobody can read.
 */
function groupIntoSections(items: readonly Measured[], minLevel: number): Measured[][] {
  const groups: Measured[][] = [];
  let current: Measured[] = [];
  for (const item of items) {
    if (item.level !== null && item.level <= minLevel && current.length > 0) {
      groups.push(current);
      current = [];
    }
    current.push(item);
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

/**
 * One group as an entry.
 *
 * A group counts as a section only when it *starts* at the level the part was
 * cut at. That is the guard against a map containing what it is a map of: a
 * fragment that opens with its own heading (reading a section hands one back)
 * is cut one level deeper, and its opening heading then leads a group at a
 * shallower level. Addressed as a section, that group would resolve to the
 * whole fragment again and the next read would return this same map forever.
 * Addressed as a range, it resolves to exactly the blocks it names.
 */
function sectionEntry(group: readonly Measured[], cutLevel: number): DocumentMapEntry {
  const head = group[0] as Measured;
  const isSection = head.level === cutLevel;
  const { from, to } = rangeOf(group);
  return {
    kind: isSection ? 'section' : 'range',
    fromBlockId: from,
    // A heading already addresses everything under it (ADR-045), so a section
    // needs no end. Anything else is a plain span and needs one.
    toBlockId: isSection ? null : to,
    level: head.level,
    title:
      head.level === null
        ? 'Vor der ersten Überschrift'
        : isSection
          ? textOf(head.node)
          : `${textOf(head.node)} (Anfang)`,
    chars: sumChars(group),
    blocks: group.length,
  };
}

/** Merges neighbouring entries until there are at most `maxEntries` of them. */
function coarsen(entries: readonly DocumentMapEntry[], maxEntries: number): DocumentMapEntry[] {
  const perBucket = Math.ceil(entries.length / maxEntries);
  const merged: DocumentMapEntry[] = [];
  for (let start = 0; start < entries.length; start += perBucket) {
    const bucket = entries.slice(start, start + perBucket);
    const first = bucket[0] as DocumentMapEntry;
    const last = bucket[bucket.length - 1] as DocumentMapEntry;
    if (bucket.length === 1) {
      merged.push(first);
      continue;
    }
    merged.push({
      kind: 'range',
      fromBlockId: first.fromBlockId,
      toBlockId: last.toBlockId ?? last.fromBlockId,
      level: null,
      title: `${bucket.length} Abschnitte: „${first.title}“ bis „${last.title}“`,
      chars: bucket.reduce((total, entry) => total + entry.chars, 0),
      blocks: bucket.reduce((total, entry) => total + entry.blocks, 0),
    });
  }
  return merged;
}

/**
 * The floor of the recursion: windows of sibling blocks.
 *
 * Used when a part has no inner headings to cut at. The windows are sized from
 * the part's own length so their number stays inside the entry budget however
 * long it is, which is what keeps a map of a flat million characters the same
 * size as a map of a flat thousand.
 */
function rangeEntries(items: readonly Measured[], maxEntries: number): DocumentMapEntry[] {
  const total = sumChars(items);
  const target = Math.max(1, Math.ceil(total / maxEntries));
  const entries: DocumentMapEntry[] = [];
  let window: Measured[] = [];
  let startIndex = 0;

  const flush = (endIndex: number): void => {
    if (window.length === 0) return;
    const { from, to } = rangeOf(window);
    const preview = textOf((window[0] as Measured).node).slice(0, RANGE_PREVIEW_CHARS);
    entries.push({
      kind: 'range',
      fromBlockId: from,
      toBlockId: to,
      level: null,
      title:
        `Blöcke ${startIndex + 1} bis ${endIndex + 1}` + (preview.length > 0 ? `: ${preview}` : ''),
      chars: sumChars(window),
      blocks: window.length,
    });
    window = [];
  };

  for (let index = 0; index < items.length; index += 1) {
    if (window.length === 0) startIndex = index;
    window.push(items[index] as Measured);
    if (sumChars(window) >= target) flush(index);
  }
  flush(items.length - 1);
  return entries;
}

/**
 * The map of a document, or of a fragment of one.
 *
 * The same function answers both, which is what makes the recursion one rule
 * rather than three: a section handed back in is just a shorter document, and
 * it is mapped by its own inner headings, or by block ranges when it has none.
 */
export function buildDocumentMap(
  document: ProseMirrorDocument,
  options: BuildDocumentMapOptions = {},
): DocumentMap {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_MAP_ENTRIES;
  const items = measure(document.content ?? []);
  const totalChars = options.totalChars ?? serializeMarkdown(document).length;
  const base = { totalChars, totalBlocks: items.length };
  if (items.length === 0) {
    return { mode: 'sections', ...base, entries: [], coarsened: false };
  }

  /*
   * The level to cut at: the shallowest one that actually divides this part
   * into more than one piece.
   *
   * Not simply the shallowest level present, because a fragment that opens
   * with its own heading has exactly one block at that level and cutting
   * there would produce a single group covering everything -- the input back
   * as its own map. Going deeper is what makes reading a section a step
   * towards the text rather than a step sideways.
   */
  const levels = [
    ...new Set(items.map((item) => item.level).filter((level): level is number => level !== null)),
  ].sort((a, b) => a - b);
  const cut = levels
    .map((level) => ({ level, groups: groupIntoSections(items, level) }))
    .find(
      // A part before the first heading counts: it is content, and content that
      // no entry names is content nobody can reach.
      (candidate) => candidate.groups.length > 1,
    );

  if (cut === undefined) {
    const entries = rangeEntries(items, maxEntries);
    return { mode: 'ranges', ...base, entries, coarsened: entries.length < items.length };
  }

  const sections = cut.groups.map((group) => sectionEntry(group, cut.level));
  const coarsened = sections.length > maxEntries;
  return {
    mode: 'sections',
    ...base,
    entries: coarsened ? coarsen(sections, maxEntries) : sections,
    coarsened,
  };
}

/**
 * The content a range of sibling blocks addresses.
 *
 * `toBlockId` of `null` is one block, and a heading then brings its section
 * along exactly as everywhere else (`extractBlockFragment`). With both ends the
 * range is inclusive and the two must be siblings, the same rule the write side
 * applies in `resolveBlockRange`: two blocks in different parents describe a
 * shape, not a span.
 *
 * An end equal to the start is therefore *not* the same as no end: it means
 * that one block literally, heading or not. A map addresses its ranges that
 * way on purpose, so an entry can never resolve to more than it named.
 *
 * `null` when either end is gone. Reported as a dead address rather than
 * answered with the nearest surviving block, for the reason ADR-045 gives.
 */
export function extractBlockRange(
  document: ProseMirrorDocument,
  fromBlockId: string,
  toBlockId: string | null,
): ProseMirrorDocument | null {
  if (toBlockId === null) return extractBlockFragment(document, fromBlockId);

  const search = (siblings: readonly ProseMirrorNode[]): ProseMirrorDocument | null => {
    const from = siblings.findIndex((node) => blockIdOf(node) === fromBlockId);
    const to = siblings.findIndex((node) => blockIdOf(node) === toBlockId);
    if (from !== -1 && to !== -1) {
      return from <= to ? { type: 'doc', content: siblings.slice(from, to + 1) } : null;
    }
    for (const node of siblings) {
      const inside = search(node.content ?? []);
      if (inside !== null) return inside;
    }
    return null;
  };

  return search(document.content ?? []);
}
