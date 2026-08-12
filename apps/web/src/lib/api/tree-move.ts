import {
  type DocumentTreeNode,
  type DocumentTreeResponse,
  type MoveDocumentRequest,
} from '@exocortex/contracts';

/**
 * The move, applied to the tree the sidebar is already holding.
 *
 * Why the client redoes work the server does anyway: a drag that snaps back for
 * two hundred milliseconds before landing where it was dropped reads as a failed
 * drag. This is the only optimistic update in the app, and it earns the
 * exception because it is the only interaction whose whole point is that the
 * thing follows the pointer.
 *
 * It computes *position*, never an `orderKey` — those stay the server's (ADR: the
 * client passes sibling anchors, the server owns ordering). The answer is
 * discarded and replaced by the server's tree as soon as it arrives, so a
 * disagreement lasts one round trip and no longer.
 *
 * Returns `null` when the move cannot be represented locally — a move into
 * another workspace, or an anchor that is not where the client thinks it is. The
 * caller then leaves the tree alone and waits for the server, which is the
 * honest thing to show when we do not know the answer.
 */
export function applyOptimisticMove(
  tree: DocumentTreeResponse,
  documentId: string,
  request: MoveDocumentRequest,
): DocumentTreeResponse | null {
  if (request.workspaceId !== undefined) return null;

  const moved = findNode(tree.nodes, documentId);
  if (moved === null) return null;

  // Into itself or into its own subtree: the server refuses this, and so does
  // the tree that would have to draw it.
  if (request.parentId !== null && containsNode(moved, request.parentId)) return null;

  const without = removeNode(tree.nodes, documentId);
  const siblings =
    request.parentId === null ? without : (findNode(without, request.parentId)?.children ?? null);
  if (siblings === null) return null;

  const anchorId = request.beforeSiblingId ?? request.afterSiblingId ?? null;
  const anchorIndex = anchorId === null ? -1 : siblings.findIndex((node) => node.id === anchorId);
  if (anchorId !== null && anchorIndex < 0) return null;

  const index =
    anchorIndex < 0
      ? siblings.length // No anchor means the end of the list, as on the server.
      : request.beforeSiblingId !== undefined && request.beforeSiblingId !== null
        ? anchorIndex
        : anchorIndex + 1;

  const placed = { ...moved, parentId: request.parentId };
  const next = [...siblings.slice(0, index), placed, ...siblings.slice(index)];

  return {
    ...tree,
    nodes: request.parentId === null ? next : replaceChildren(without, request.parentId, next),
  };
}

function findNode(nodes: readonly DocumentTreeNode[], id: string): DocumentTreeNode | null {
  for (const node of nodes) {
    if (node.id === id) return node;
    const found = findNode(node.children, id);
    if (found !== null) return found;
  }
  return null;
}

/** Whether `id` is the node itself or anywhere below it. */
export function containsNode(node: DocumentTreeNode, id: string): boolean {
  if (node.id === id) return true;
  return node.children.some((child) => containsNode(child, id));
}

function removeNode(nodes: readonly DocumentTreeNode[], id: string): DocumentTreeNode[] {
  return nodes
    .filter((node) => node.id !== id)
    .map((node) => ({ ...node, children: removeNode(node.children, id) }));
}

function replaceChildren(
  nodes: readonly DocumentTreeNode[],
  parentId: string,
  children: DocumentTreeNode[],
): DocumentTreeNode[] {
  return nodes.map((node) =>
    node.id === parentId
      ? { ...node, children }
      : { ...node, children: replaceChildren(node.children, parentId, children) },
  );
}
