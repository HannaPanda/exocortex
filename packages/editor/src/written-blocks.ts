import { type ProseMirrorDocument, type ProseMirrorNode } from './contract';
import { blockIdOf } from './document-diff';

/**
 * What one write did to a page, block by block, in a form small enough to
 * keep beside the write (issue #248).
 *
 * The unit is the top-level block, the same one `diffDocuments` reports and
 * `applyBlocksFromDocument` restores: taking a run back is a series of block
 * restores, so what is recorded has to be what a restore can address.
 *
 * Each changed block keeps a fingerprint of how the write left it, never its
 * content (ADR-022: the journal points at states, it does not copy them).
 * Comparing that fingerprint with the page later answers the one question an
 * undo has to ask before it touches a block: is this still what the run
 * wrote, or has somebody been here since?
 *
 * And each changed block carries the group it changed in. A write that
 * replaces a paragraph usually removes the old block and inserts a new one
 * with a new identifier, so "this paragraph changed" is two blocks that only
 * mean something together: putting the old one back while somebody has since
 * reworded the new one would leave both standing. A group is one stretch of
 * consecutive changes between two blocks the write left alone, and an undo
 * restores a group whole or not at all.
 */
export interface WrittenBlock {
  id: string;
  /** Fingerprint of the block after the write; `null` when the write removed it. */
  after: string | null;
  /** The stretch of this write the block changed in; only meaningful within one write. */
  group: number;
  /**
   * The identified block standing right before it: in the state the write
   * left for a block it kept, in the state before for one it removed, `''`
   * at the start of the page. Where the block stood, for an undo that has to
   * say what took its place once somebody rewrote it under a new identifier.
   * Absent on rows written before it was recorded.
   */
  prev?: string;
}

/**
 * The top-level blocks that differ between two states of a page: added,
 * removed, or changed in their own content. A block that only moved keeps
 * its fingerprint and is not named, because a block restore puts content
 * back, not order.
 */
export function writtenTopLevelBlocks(
  before: ProseMirrorDocument,
  after: ProseMirrorDocument,
): WrittenBlock[] {
  const earlier = topLevelFingerprints(before);
  const later = topLevelFingerprints(after);
  const untouched = (id: string): boolean => earlier.has(id) && earlier.get(id) === later.get(id);

  // Each changed block is keyed by the untouched block before it, once in
  // the old order and once in the new; a block changed in place is seen in
  // both and joins the two stretches it stands in.
  const groups = new UnionFind();
  const stretchOf = (anchor: string): string => `stretch:${anchor}`;
  const walk = (document: ProseMirrorDocument): void => {
    let anchor = '';
    for (const node of document.content ?? []) {
      const id = blockIdOf(node);
      if (id === null) continue;
      if (untouched(id)) {
        anchor = id;
        continue;
      }
      groups.union(id, stretchOf(anchor));
    }
  };
  walk(before);
  walk(after);

  const laterPrev = predecessors(after);
  const earlierPrev = predecessors(before);
  const written: { id: string; after: string | null; prev: string }[] = [];
  for (const [id, fingerprint] of later) {
    if (earlier.get(id) !== fingerprint) {
      written.push({ id, after: fingerprint, prev: laterPrev.get(id) ?? '' });
    }
  }
  for (const id of earlier.keys()) {
    if (!later.has(id)) written.push({ id, after: null, prev: earlierPrev.get(id) ?? '' });
  }

  const numbers = new Map<string, number>();
  return written.map((block) => {
    const root = groups.find(block.id);
    let group = numbers.get(root);
    if (group === undefined) {
      group = numbers.size;
      numbers.set(root, group);
    }
    return { ...block, group };
  });
}

/** For every identified top-level block, the identified block before it (`''` first). */
function predecessors(document: ProseMirrorDocument): Map<string, string> {
  const previous = new Map<string, string>();
  let last = '';
  for (const node of document.content ?? []) {
    const id = blockIdOf(node);
    if (id === null) continue;
    previous.set(id, last);
    last = id;
  }
  return previous;
}

/**
 * One fingerprint for a whole page's content, for the question "has anybody
 * touched this page since the run created it" (issue #248).
 *
 * Built from the blocks' own fingerprints, so it is as stable as they are, and
 * blind to empty paragraphs: an editor that opens a page may add a line to
 * type in (issue #257) without anybody having written anything.
 */
export function pageFingerprint(document: ProseMirrorDocument): string {
  const parts: string[] = [];
  for (const node of document.content ?? []) {
    if (node.type === 'paragraph' && (node.content ?? []).length === 0) continue;
    parts.push(blockFingerprint(node));
  }
  return hash53(parts.join('|'));
}

/** Every identified top-level block of a page and its fingerprint. */
export function topLevelFingerprints(document: ProseMirrorDocument): Map<string, string> {
  const fingerprints = new Map<string, string>();
  for (const node of document.content ?? []) {
    const id = blockIdOf(node);
    if (id !== null) fingerprints.set(id, blockFingerprint(node));
  }
  return fingerprints;
}

/**
 * A short, stable fingerprint of a block's content.
 *
 * Stable means: independent of the order in which attributes were written and
 * of attributes that are merely absent (`null` and missing are the same
 * thing to a reader), so the same block read back through the collaboration
 * server compares equal to what the API wrote. It is a hash for telling
 * states apart, not for security; a collision would only make an undo treat
 * a changed block as unchanged, and at 53 bits over one page's blocks that is
 * not a case worth a dependency.
 */
export function blockFingerprint(node: ProseMirrorNode): string {
  return hash53(canonical(node));
}

/** A minimal union-find over strings, for grouping blocks that belong together. */
export class UnionFind {
  private readonly parent = new Map<string, string>();

  find(key: string): string {
    let root = key;
    for (;;) {
      const next = this.parent.get(root);
      if (next === undefined || next === root) break;
      root = next;
    }
    // Path compression keeps repeated lookups flat.
    let node = key;
    while (node !== root) {
      const next = this.parent.get(node) ?? root;
      this.parent.set(node, root);
      node = next;
    }
    return root;
  }

  union(left: string, right: string): void {
    const a = this.find(left);
    const b = this.find(right);
    if (a !== b) this.parent.set(a, b);
  }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== null && entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** cyrb53: a fast 53-bit string hash, rendered in base 36. */
function hash53(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}
