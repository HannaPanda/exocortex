import { type DocumentTreeNode } from '@exocortex/contracts';

/**
 * The tree's pure bookkeeping: what is unfolded, where a page sits, and whether
 * a move would put a page inside itself.
 *
 * Kept out of the component because none of it is React, and because the two
 * rules that actually matter (a page may never be dropped into its own subtree;
 * an unfold state that reads back malformed is discarded, not repaired) are
 * easier to reason about with nothing else in the file.
 */

/** Which rows are unfolded, by document id. Only `true` counts as open. */
export type ExpandedState = Readonly<Record<string, boolean>>;

/** Stable fallback: `usePersistentState` memoizes on the identity of this. */
export const EMPTY_EXPANDED: ExpandedState = {};

/**
 * Reads the persisted unfold state back.
 *
 * Anything that is not an object of booleans is discarded rather than repaired:
 * the state is a convenience, and a half-read one would be worse than starting
 * folded.
 */
export function parseExpanded(raw: string): ExpandedState {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
  const result: Record<string, boolean> = {};
  for (const [id, value] of Object.entries(parsed)) {
    if (value === true) result[id] = true;
  }
  return result;
}

/**
 * The ids of every ancestor of `documentId`, excluding the node itself, or
 * `null` when this tree does not contain that document.
 *
 * Derived from the tree the sidebar already holds, so finding out where the
 * open document sits costs no request — `GET /api/documents/:id` would answer
 * the same question with a round trip. The `null` matters: "a root page, no
 * ancestors" and "not in the tree yet" are different answers, and only the
 * second one is worth waiting for.
 */
export function ancestorsOf(
  nodes: readonly DocumentTreeNode[],
  documentId: string,
): string[] | null {
  const search = (node: DocumentTreeNode, path: string[]): string[] | null => {
    if (node.id === documentId) return path;
    const nextPath = [...path, node.id];
    for (const child of node.children) {
      const found = search(child, nextPath);
      if (found !== null) return found;
    }
    return null;
  };

  for (const node of nodes) {
    const found = search(node, []);
    if (found !== null) return found;
  }
  return null;
}

/** One row as the keyboard sees it: what an arrow key needs to know about it. */
export interface VisibleRow {
  readonly id: string;
  readonly parentId: string | null;
  readonly hasChildren: boolean;
  readonly isOpen: boolean;
}

/**
 * Every row a person can currently see, in the order they move through them.
 *
 * The tree renders itself recursively, which is right for indentation and drop
 * zones and useless for "what is below this row": the row below a folded page
 * is its next sibling, the row below an unfolded one is its first child, and
 * neither of those is a sibling in the component that draws it. Flattening the
 * visible part once per render is what turns that into an index.
 */
export function visibleRows(
  nodes: readonly DocumentTreeNode[],
  expanded: ExpandedState,
): readonly VisibleRow[] {
  const rows: VisibleRow[] = [];

  const walk = (siblings: readonly DocumentTreeNode[], parentId: string | null): void => {
    for (const node of siblings) {
      const hasChildren = node.children.length > 0;
      const isOpen = hasChildren && expanded[node.id] === true;
      rows.push({ id: node.id, parentId, hasChildren, isOpen });
      if (isOpen) walk(node.children, node.id);
    }
  };

  walk(nodes, null);
  return rows;
}

/** Where a dragged page would land relative to the row under the pointer. */
export type DropZone = 'before' | 'inside' | 'after';

/** A row's place in the tree: who its parent is and who it sits between. */
export interface TreePosition {
  readonly node: DocumentTreeNode;
  readonly parentId: string | null;
  readonly siblings: readonly DocumentTreeNode[];
  readonly index: number;
}

/**
 * Every row by id, with the neighbours a move has to be expressed against.
 *
 * The server takes sibling anchors ("put it before that one"), never a position,
 * so reordering needs to know what is above and below the row before it can ask
 * for anything.
 */
export function indexTree(nodes: readonly DocumentTreeNode[]): ReadonlyMap<string, TreePosition> {
  const positions = new Map<string, TreePosition>();

  const walk = (siblings: readonly DocumentTreeNode[], parentId: string | null): void => {
    siblings.forEach((node, index) => {
      positions.set(node.id, { node, parentId, siblings, index });
      walk(node.children, node.id);
    });
  };

  walk(nodes, null);
  return positions;
}

/** Whether `candidateId` is `node` itself or sits somewhere below it. */
export function isSelfOrDescendant(node: DocumentTreeNode, candidateId: string): boolean {
  if (node.id === candidateId) return true;
  return node.children.some((child) => isSelfOrDescendant(child, candidateId));
}

/**
 * How long a folded page has to be hovered before it opens under the pointer.
 *
 * Long enough that dragging *past* a folded page does not open it, short enough
 * that dropping something three levels down does not need three separate drags.
 */
