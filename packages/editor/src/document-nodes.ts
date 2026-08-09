import { type ProseMirrorDocument, type ProseMirrorNode } from './contract';

/**
 * Rewrites every node of a document bottom-up, without mutating the input.
 *
 * Document migrations and the page-link identity helpers all need the same
 * thing: walk the tree, replace some nodes, keep everything else identical and
 * structurally shared. Doing that in one place keeps them from each growing
 * their own slightly different walker.
 *
 * `map` receives a node whose children have already been mapped and returns
 * either the same reference (nothing changed) or a new node. When nothing
 * anywhere changed, the original document is returned as-is, which makes a
 * no-op migration genuinely free.
 */
export function mapDocumentNodes(
  document: ProseMirrorDocument,
  map: (node: ProseMirrorNode) => ProseMirrorNode,
): ProseMirrorDocument {
  const visit = (node: ProseMirrorNode): ProseMirrorNode => {
    const children = node.content;
    if (children === undefined) return map(node);

    let changed = false;
    const mapped = children.map((child) => {
      const next = visit(child);
      if (next !== child) changed = true;
      return next;
    });

    return map(changed ? { ...node, content: mapped } : node);
  };

  const next = visit(document);
  // `visit` preserves `type`, so the cast only restores the narrower doc type.
  return next === document ? document : (next as ProseMirrorDocument);
}
