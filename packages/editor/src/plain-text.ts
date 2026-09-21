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

/** One rendered string per top-level block, the empty ones dropped. */
function renderParts(document: ProseMirrorDocument): PlainTextPart[] {
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

  return (document.content ?? [])
    .map((node) => ({ node, text: renderNode(node) }))
    .filter((part) => part.text.trim().length > 0);
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
  let text = parts.map((part) => part.text).join('\n');
  let offsets: number[] = [];
  let at = 0;
  for (const part of parts) {
    offsets.push(at);
    at += part.text.length + 1;
  }

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
    shifted.push(match !== undefined && match.index < offset ? match.index + delta : offset + delta);
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
