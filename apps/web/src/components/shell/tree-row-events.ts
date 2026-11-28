import {
  type DocumentSummary,
  type DocumentTreeNode,
  type DocumentTreeResponse,
} from '@exocortex/contracts';

/** A realtime event that may change the page tree, reduced to what decides how. */
export type TreeEvent =
  | { kind: 'created' | 'updated' | 'archived' | 'restored'; document: DocumentSummary }
  | { kind: 'moved'; document: DocumentSummary; previousParentId: string | null };

/**
 * Applies an event about a database row to the sidebar's tree, which names no
 * rows (issue #221), or answers `null` when only a refetch can say what changed.
 *
 * An agent filling a database sends an event per row, and every one of them
 * used to refetch the whole tree in every open tab. A row the tree does not
 * show changes nothing in it but the number on its database, and that number
 * is known from the event: a new or restored row adds one, an archived row
 * takes one away, a rename or a move within the same table changes nothing.
 * (The tree's archived list leaves rows out as well, so it does not move.)
 *
 * Everything else is a refetch: an event about a page the tree shows (a row
 * with sub-pages of its own is one of them), and a row moving out of its
 * table or into one from elsewhere, because the tree would have to learn
 * where it went.
 *
 * Returns the same object when nothing changes, so the caller can skip the
 * cache write.
 */
export function applyRowEvent(
  tree: DocumentTreeResponse,
  event: TreeEvent,
): DocumentTreeResponse | null {
  const nodes = new Map<string, DocumentTreeNode>();
  const walk = (node: DocumentTreeNode): void => {
    nodes.set(node.id, node);
    for (const child of node.children) walk(child);
  };
  for (const node of tree.nodes) walk(node);

  if (nodes.has(event.document.id)) return null;
  const isCountedDatabase = (id: string | null): id is string =>
    id !== null && nodes.get(id)?.rowCount !== undefined;

  const parentId = event.document.parentId;
  if (!isCountedDatabase(parentId)) return null;

  switch (event.kind) {
    case 'updated':
      return tree;
    case 'moved':
      if (event.previousParentId === parentId) return tree;
      if (!isCountedDatabase(event.previousParentId)) return null;
      return withRowCounts(tree, { [event.previousParentId]: -1, [parentId]: 1 });
    case 'created':
    case 'restored':
      return withRowCounts(tree, { [parentId]: 1 });
    case 'archived':
      return withRowCounts(tree, { [parentId]: -1 });
  }
}

/** The tree with the row counts of the named databases moved by the given amounts. */
function withRowCounts(
  tree: DocumentTreeResponse,
  deltas: Readonly<Record<string, number>>,
): DocumentTreeResponse {
  const update = (node: DocumentTreeNode): DocumentTreeNode => {
    const delta = deltas[node.id];
    const children = node.children.map(update);
    const childrenChanged = children.some((child, index) => child !== node.children[index]);
    if (delta === undefined && !childrenChanged) return node;
    return {
      ...node,
      children: childrenChanged ? children : node.children,
      ...(delta === undefined || node.rowCount === undefined
        ? {}
        : { rowCount: Math.max(0, node.rowCount + delta) }),
    };
  };
  const totalDelta = Object.values(deltas).reduce((sum, delta) => sum + delta, 0);
  return {
    ...tree,
    nodes: tree.nodes.map(update),
    totalCount: Math.max(0, tree.totalCount + totalDelta),
  };
}
