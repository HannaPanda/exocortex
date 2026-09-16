import { type DocumentTreeNode } from '@exocortex/contracts';

/**
 * A tree node with every field of a `DocumentSummary` filled in.
 *
 * The tree helpers read four fields and ignore the other fourteen, but the type
 * is the whole summary, and a cast would be the wrong way to get past that: it
 * would keep compiling on the day a helper starts reading `archivedAt`, and the
 * test would then be describing a node the API never sends.
 */
export function treeNode(
  id: string,
  children: DocumentTreeNode[] = [],
  overrides: Partial<DocumentTreeNode> = {},
): DocumentTreeNode {
  return {
    id,
    workspaceId: 'ws',
    parentId: null,
    type: 'PAGE',
    title: id,
    icon: null,
    iconColor: null,
    layout: 'narrow',
    overviewMode: 'off',
    coverAttachmentId: null,
    coverPosition: 50,
    orderKey: id,
    createdById: 'user',
    updatedById: 'user',
    createdAt: '2026-09-16T10:00:00.000Z',
    updatedAt: '2026-09-16T10:00:00.000Z',
    archivedAt: null,
    children,
    ...overrides,
  };
}

/** The same node with its `parentId` set, so a fixture tree stays consistent. */
export function treeBranch(
  id: string,
  parentId: string | null,
  children: DocumentTreeNode[] = [],
): DocumentTreeNode {
  return treeNode(id, children, { parentId });
}
