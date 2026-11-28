import { BLOCK_ID_ATTRIBUTE, isValidBlockId } from './block-id';
import { type ProseMirrorDocument, type ProseMirrorNode } from './contract';
import { buildPlainTextRegistry } from './extensions';
import { INLINE_CONTAINER_TYPES } from './plain-text-adapter';

/**
 * Derives the plain-text projection of a document.
 *
 * Deterministic: the same ProseMirror JSON always produces the same string, so
 * the search index only changes when the content actually changed.
 */
export function serializePlainText(document: ProseMirrorDocument): string {
  return assemble(renderParts(document)).text;
}

/**
 * Where a heading sits in the plain text a page is indexed as (issue #118).
 *
 * A semantic hit points at a passage of about two thousand characters
 * (ADR-034), and until now the answer could only name the page it came from.
 * That is what a caller already knew: the failing run searched fourteen times
 * and every hit named the page it had just read. A passage that carries the
 * heading above it can be opened instead of guessed at.
 *
 * The offset is into the string `serializePlainText` returns, because that is
 * what gets cut into passages. So both come out of one assembly rather than
 * two, and an offset cannot drift away from the text it points into.
 */
export interface PlainTextHeadingAnchor {
  /** Character offset of the heading's own line in the plain text. */
  offset: number;
  /**
   * Block to read the section with. `null` on a page the editor has not
   * touched since block identifiers existed: the section can be named, not
   * opened, which is what ADR-056 says about an unaddressable part too.
   */
  blockId: string | null;
  level: number;
  /** The heading and the headings it sits under, outermost first. */
  path: string[];
}

/**
 * Every top-level heading of a document, with the offset it starts at.
 *
 * Only the top level, for the reason `document-map.ts` gives: a heading inside
 * a column or a toggle is content of that block rather than a section of the
 * page.
 */
export function plainTextHeadingAnchors(document: ProseMirrorDocument): PlainTextHeadingAnchor[] {
  const parts = renderParts(document);
  const { offsets } = assemble(parts);
  const anchors: PlainTextHeadingAnchor[] = [];
  /** The headings this one sits under, by level, outermost first. */
  const open: { level: number; title: string }[] = [];

  for (const [index, part] of parts.entries()) {
    const level = headingLevel(part.node);
    if (level === null) continue;
    const title = part.text.replace(/\s+/g, ' ').trim();
    if (title.length === 0) continue;
    while (open.length > 0 && (open[open.length - 1]?.level ?? 0) >= level) open.pop();
    anchors.push({
      offset: offsets[index] ?? 0,
      blockId: blockIdOf(part.node),
      level,
      path: [...open.map((entry) => entry.title), title],
    });
    open.push({ level, title });
  }
  return anchors;
}

/**
 * One place in the plain text a hit can be attributed to (issue #280): a
 * top-level block, or a point of a list. A hit at some offset belongs to the
 * last unit that starts at or before it.
 */
export interface PlainTextBlockUnit {
  /** Character offset (UTF-16, like every JavaScript index) into the text. */
  offset: number;
  /**
   * The block to read the hit with. A list point without an identifier of
   * its own falls back to the nearest block around it that has one; `null`
   * when nothing up to the top level carries one.
   */
  blockId: string | null;
  /** Index into `headings` of the section the unit sits in, `-1` for none. */
  heading: number;
}

export interface PlainTextBlockMap {
  /** The plain text the offsets index: exactly what `serializePlainText` returns. */
  text: string;
  /** In ascending order of `offset`, no two at the same offset. */
  units: PlainTextBlockUnit[];
  /** The top-level headings, as `plainTextHeadingAnchors` names them. */
  headings: { blockId: string | null; path: string[] }[];
}

/** The containers whose children are list points. */
const LIST_TYPES = new Set(['bulletList', 'orderedList', 'taskList']);
const LIST_ITEM_TYPES = new Set(['listItem', 'taskItem']);

/**
 * Which block every stretch of the plain text came out of (issue #280).
 *
 * A keyword hit is a position in the text the search index holds, and until
 * this existed nothing could say which block that position belonged to: the
 * search named the page, and a reader looking for a word in the second of two
 * long lists read the first one and gave up. So the indexer stores this beside
 * the text, once per save, and a search only looks a position up in it.
 *
 * Top-level blocks are units, and so is every point of a list at any depth,
 * because since #274 a list point is addressable on its own and a long list
 * is exactly where "the block" is too coarse an answer. Other containers (a
 * table, a toggle, columns) stay one unit: the block that holds the words is
 * still named, never a wrong one. A child is only placed when the container's
 * text really is its children joined line by line; a node whose plain-text
 * adapter adds anything of its own keeps its children unplaced rather than
 * placed at a guessed offset.
 */
export function plainTextBlockMap(document: ProseMirrorDocument): PlainTextBlockMap {
  const render = createRenderer();
  const parts = renderParts(document, render);
  const units: PlainTextBlockUnit[] = [];
  const headings: PlainTextBlockMap['headings'] = [];
  const open: { level: number; title: string }[] = [];
  let section = -1;

  const push = (offset: number, blockId: string | null): void => {
    const last = units[units.length - 1];
    // A list starts where its first point starts; the inner unit is the answer.
    if (last !== undefined && last.offset === offset) units.pop();
    units.push({ offset, blockId, heading: section });
  };

  const walkList = (list: ProseMirrorNode, text: string, base: number, outer: string | null) => {
    for (const placed of placeChildren(list, text, render) ?? []) {
      const itemId = blockIdOf(placed.node) ?? outer;
      push(base + placed.start, itemId);
      if (LIST_ITEM_TYPES.has(placed.node.type)) {
        walkItem(placed.node, placed.text, base + placed.start, itemId);
      }
    }
  };

  const walkItem = (item: ProseMirrorNode, text: string, base: number, itemId: string | null) => {
    let resumes = false;
    for (const placed of placeChildren(item, text, render) ?? []) {
      if (LIST_TYPES.has(placed.node.type)) {
        walkList(placed.node, placed.text, base + placed.start, itemId);
        resumes = true;
      } else if (resumes) {
        // Text of the point after its nested list is the point's again.
        push(base + placed.start, itemId);
        resumes = false;
      }
    }
  };

  let at = 0;
  for (const part of parts) {
    const level = headingLevel(part.node);
    const title = part.text.replace(/\s+/g, ' ').trim();
    if (level !== null && title.length > 0) {
      while (open.length > 0 && (open[open.length - 1]?.level ?? 0) >= level) open.pop();
      headings.push({ blockId: blockIdOf(part.node), path: [...open.map((e) => e.title), title] });
      open.push({ level, title });
      section = headings.length - 1;
    }
    const own = blockIdOf(part.node);
    push(at, own);
    if (LIST_TYPES.has(part.node.type)) walkList(part.node, part.text, at, own);
    at += part.text.length + 1;
  }

  const cleaned = cleanUp(
    parts.map((part) => part.text).join('\n'),
    units.map((unit) => unit.offset),
  );
  // A cleanup can move two units onto one offset; the later one is the answer.
  const shifted: PlainTextBlockUnit[] = [];
  units.forEach((unit, index) => {
    const offset = cleaned.offsets[index] ?? 0;
    if (shifted[shifted.length - 1]?.offset === offset) shifted.pop();
    shifted.push({ ...unit, offset });
  });
  return { text: cleaned.text, units: shifted, headings };
}

/**
 * The children of a container with where each starts in its text, or `null`
 * when the text is not simply those children joined by line breaks.
 */
function placeChildren(
  node: ProseMirrorNode,
  text: string,
  render: RenderNode,
): { node: ProseMirrorNode; text: string; start: number }[] | null {
  if (INLINE_CONTAINER_TYPES.has(node.type)) return null;
  const rendered = (node.content ?? [])
    .map((child) => ({ node: child, text: render(child) }))
    .filter((child) => child.text.length > 0);
  if (rendered.map((child) => child.text).join('\n') !== text) return null;
  let at = 0;
  return rendered.map((child) => {
    const start = at;
    at += child.text.length + 1;
    return { ...child, start };
  });
}

/** Collects every stable block identifier present in a document. */
export function collectBlockIds(document: ProseMirrorDocument): string[] {
  const ids: string[] = [];
  const walk = (node: ProseMirrorNode): void => {
    const value = node.attrs?.[BLOCK_ID_ATTRIBUTE];
    if (typeof value === 'string' && value.length > 0) ids.push(value);
    for (const child of node.content ?? []) walk(child);
  };
  walk(document);
  return ids;
}

/** Finds duplicated block identifiers. Used by import validation and tests. */
export function findDuplicateBlockIds(document: ProseMirrorDocument): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const id of collectBlockIds(document)) {
    if (seen.has(id)) duplicates.add(id);
    seen.add(id);
  }
  return [...duplicates];
}

interface PlainTextPart {
  node: ProseMirrorNode;
  text: string;
}

type RenderNode = (node: ProseMirrorNode) => string;

/** One rendered string per top-level block, the empty ones dropped. */
function renderParts(
  document: ProseMirrorDocument,
  renderNode: RenderNode = createRenderer(),
): PlainTextPart[] {
  return (document.content ?? [])
    .map((node) => ({ node, text: renderNode(node) }))
    .filter((part) => part.text.trim().length > 0);
}

/** The one function every block's plain text comes out of. */
function createRenderer(): RenderNode {
  const registry = buildPlainTextRegistry();

  const renderChildren = (node: ProseMirrorNode): string => {
    const children = node.content ?? [];
    if (children.length === 0) return node.text ?? '';

    const separator = INLINE_CONTAINER_TYPES.has(node.type) ? '' : '\n';
    return children
      .map((child) => renderNode(child))
      .filter((value) => value.length > 0)
      .join(separator);
  };

  const renderNode = (node: ProseMirrorNode): string => {
    if (node.type === 'text') return node.text ?? '';
    if (node.type === 'hardBreak') return '\n';
    const custom = registry[node.type];
    if (custom !== undefined) {
      const result = custom(node, renderChildren);
      if (result !== undefined) return result;
    }
    return renderChildren(node);
  };

  return renderNode;
}

/**
 * The parts as one string, and where each of them ended up in it.
 *
 * The three cleanups below all shrink the text, so an offset taken before them
 * would point past where its part actually starts. They are applied to the
 * string exactly as they always were, and the offsets are carried through the
 * same edits rather than recomputed from the result.
 */
function assemble(parts: readonly PlainTextPart[]): { text: string; offsets: number[] } {
  const offsets: number[] = [];
  let at = 0;
  for (const part of parts) {
    offsets.push(at);
    at += part.text.length + 1;
  }
  return cleanUp(parts.map((part) => part.text).join('\n'), offsets);
}

/**
 * The joined text after the cleanups, with offsets into it carried along.
 * `rawOffsets` index the text before the cleanups and must be ascending.
 */
function cleanUp(
  rawText: string,
  rawOffsets: readonly number[],
): { text: string; offsets: number[] } {
  let text = rawText;
  let offsets = [...rawOffsets];

  for (const [pattern, replacement] of CLEANUPS) {
    offsets = shiftOffsets(text, offsets, pattern, replacement);
    text = text.replace(pattern, replacement);
  }

  const lead = text.length - text.trimStart().length;
  const trimmed = text.trim();
  return {
    text: trimmed,
    offsets: offsets.map((offset) => Math.min(Math.max(offset - lead, 0), trimmed.length)),
  };
}

/**
 * Trailing blanks before a line break, then runs of empty lines. Held here
 * rather than written inline, because the offsets have to travel through
 * exactly the edits the text travels through.
 */
const CLEANUPS: readonly (readonly [RegExp, string])[] = [
  [/[ \t]+\n/g, '\n'],
  [/\n{3,}/g, '\n\n'],
];

/**
 * The same offsets after one replacement, in one pass over both lists.
 *
 * Both are in ascending order, so a match is compared with the offsets once
 * instead of every offset being compared with every match: the page this
 * feature exists for holds 2.9 million characters, and quadratic would be
 * measurable on it.
 */
function shiftOffsets(
  text: string,
  offsets: readonly number[],
  pattern: RegExp,
  replacement: string,
): number[] {
  const matches = [...text.matchAll(pattern)];
  if (matches.length === 0) return [...offsets];

  const shifted: number[] = [];
  let delta = 0;
  let next = 0;
  for (const offset of offsets) {
    let match = matches[next];
    while (match !== undefined && match.index + match[0].length <= offset) {
      delta += replacement.length - match[0].length;
      next += 1;
      match = matches[next];
    }
    // An offset inside a match is one whose whitespace is being removed; it
    // moves to where that match begins.
    shifted.push(
      match !== undefined && match.index < offset ? match.index + delta : offset + delta,
    );
  }
  return shifted;
}

function headingLevel(node: ProseMirrorNode): number | null {
  if (node.type !== 'heading') return null;
  const level = node.attrs?.level;
  return typeof level === 'number' ? level : 1;
}

function blockIdOf(node: ProseMirrorNode): string | null {
  const value: unknown = node.attrs?.[BLOCK_ID_ATTRIBUTE];
  return isValidBlockId(value) ? value : null;
}
