/**
 * Pure tree helpers shared by the API and the seeding script.
 *
 * These functions never touch the database: callers load the (already
 * permission-filtered) flat document list and pass it in. That keeps the
 * hierarchy rules unit-testable without a database.
 */

/**
 * The minimum a helper needs to walk the hierarchy. Split out from
 * `TreeNodeInput` because following parent links upwards never looks at sibling
 * order, and demanding `orderKey` would force callers to select a column they
 * have no use for.
 */
export interface ParentLink {
  id: string;
  parentId: string | null;
}

export interface TreeNodeInput extends ParentLink {
  orderKey: string;
}

export interface TreeNode<TInput extends TreeNodeInput> {
  node: TInput;
  children: TreeNode<TInput>[];
}

/**
 * Builds a nested tree from a flat list. Siblings are ordered by `orderKey`,
 * with `id` as a deterministic tie-breaker. Nodes whose parent is missing from
 * the input (for example because it is archived) are treated as roots so the
 * caller never loses documents silently.
 */
export function buildTree<TInput extends TreeNodeInput>(
  nodes: readonly TInput[],
): TreeNode<TInput>[] {
  const byId = new Map<string, TreeNode<TInput>>();
  for (const node of nodes) {
    byId.set(node.id, { node, children: [] });
  }

  const roots: TreeNode<TInput>[] = [];
  for (const entry of byId.values()) {
    const parentId = entry.node.parentId;
    const parent = parentId !== null ? byId.get(parentId) : undefined;
    if (parent === undefined) {
      roots.push(entry);
    } else {
      parent.children.push(entry);
    }
  }

  const compare = (a: TreeNode<TInput>, b: TreeNode<TInput>): number => {
    if (a.node.orderKey === b.node.orderKey) return a.node.id < b.node.id ? -1 : 1;
    return a.node.orderKey < b.node.orderKey ? -1 : 1;
  };

  const sortRecursively = (list: TreeNode<TInput>[]): void => {
    list.sort(compare);
    for (const item of list) sortRecursively(item.children);
  };
  sortRecursively(roots);

  return roots;
}

/** All descendant identifiers of `documentId`, excluding the document itself. */
export function collectDescendantIds(
  nodes: readonly ParentLink[],
  documentId: string,
): Set<string> {
  const childrenByParent = new Map<string, string[]>();
  for (const node of nodes) {
    if (node.parentId === null) continue;
    const siblings = childrenByParent.get(node.parentId);
    if (siblings === undefined) {
      childrenByParent.set(node.parentId, [node.id]);
    } else {
      siblings.push(node.id);
    }
  }

  const result = new Set<string>();
  const stack = [...(childrenByParent.get(documentId) ?? [])];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    if (result.has(current)) continue;
    result.add(current);
    stack.push(...(childrenByParent.get(current) ?? []));
  }
  return result;
}

/**
 * Returns `true` when re-parenting `documentId` under `newParentId` would create
 * a cycle (moving a document into itself or into one of its own descendants).
 */
export function wouldCreateCycle(
  nodes: readonly ParentLink[],
  documentId: string,
  newParentId: string | null,
): boolean {
  if (newParentId === null) return false;
  if (newParentId === documentId) return true;
  return collectDescendantIds(nodes, documentId).has(newParentId);
}

/** Ancestor chain from the root down to (but excluding) `documentId`. */
export function collectAncestors<TInput extends ParentLink>(
  nodes: readonly TInput[],
  documentId: string,
): TInput[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const chain: TInput[] = [];
  let current = byId.get(documentId)?.parentId ?? null;
  const guard = new Set<string>();
  while (current !== null) {
    if (guard.has(current)) break; // defensive: corrupt data must not hang the request
    guard.add(current);
    const parent = byId.get(current);
    if (parent === undefined) break;
    chain.unshift(parent);
    current = parent.parentId;
  }
  return chain;
}
