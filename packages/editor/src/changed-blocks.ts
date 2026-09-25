import { type ProseMirrorDocument, type ProseMirrorNode } from './contract';
import { blockIdOf } from './document-diff';

/**
 * The blocks a write changed, as the innermost addressable blocks that differ
 * (issue #112).
 *
 * This is what an open editor is told after an agent wrote to the page, so it
 * can mark the places that just moved under its reader. Two properties matter
 * more than completeness:
 *
 * It names the *innermost* block that changed. A corrected list item marks the
 * item, not the whole list, because a marker around forty lines for a changed
 * word says "something happened somewhere around here" -- which is the
 * confusion the marker exists to remove. A block whose own text or attributes
 * changed, while none of its addressable children did, is named itself.
 *
 * It names only blocks that exist afterwards. A deleted paragraph has no place
 * left to mark, and pretending otherwise by marking a neighbour would be a
 * marker that lies about what it points at.
 *
 * Matching is by block identifier and nothing else. A whole-page `replace`
 * rebuilds every Yjs item, but a block that kept its identifier and its content
 * compares equal here and stays unmarked, so the reader sees what the agent
 * changed rather than what the transport touched.
 */
export function changedBlockIds(
  before: ProseMirrorDocument,
  after: ProseMirrorDocument,
  limit = Number.POSITIVE_INFINITY,
): string[] {
  const previous = new Map<string, string>();
  collect(before, previous);

  const changed: string[] = [];

  /** Returns true when something inside `node` was named. */
  const visit = (node: ProseMirrorNode): boolean => {
    if (changed.length >= limit) return true;
    const id = blockIdOf(node);
    if (id !== null) {
      const earlier = previous.get(id);
      if (earlier === undefined) {
        changed.push(id);
        return true;
      }
      if (earlier === JSON.stringify(node)) return false;
    }
    let inside = false;
    for (const child of node.content ?? []) {
      if (visit(child)) inside = true;
    }
    if (inside || id === null) return inside;
    // The difference is in the block's own text or attributes.
    changed.push(id);
    return true;
  };

  for (const child of after.content ?? []) visit(child);
  return changed.slice(0, limit);
}

/** Every identified block, serialized, so equality is one string comparison. */
function collect(node: ProseMirrorNode, into: Map<string, string>): void {
  const id = blockIdOf(node);
  if (id !== null) into.set(id, JSON.stringify(node));
  for (const child of node.content ?? []) collect(child, into);
}
