import { type PlainTextAdapter, type ProseMirrorNode } from './contract';

/**
 * Plain-text adapters for the built-in nodes.
 *
 * The plain-text projection is what PostgreSQL full-text search indexes, so it
 * must contain the readable content and nothing else: no Markdown syntax, no
 * attribute noise.
 */
export const corePlainTextAdapter: PlainTextAdapter = {
  blocks: {
    heading: (node, renderChildren) => renderChildren(node),
    codeBlock: (node, renderChildren) => renderChildren(node),
    horizontalRule: () => '',
    image: (node) => {
      const alt = typeof node.attrs?.alt === 'string' ? node.attrs.alt : '';
      return alt;
    },
    table: (node, renderChildren) => renderChildren(node),
    callout: (node, renderChildren) => {
      const title = typeof node.attrs?.title === 'string' ? node.attrs.title : '';
      const body = renderChildren(node);
      return title.length > 0 ? `${title}\n${body}` : body;
    },
    taskItem: (node, renderChildren) => renderChildren(node),
  },
};

/** Nodes whose children are joined without a blank line. */
export const INLINE_CONTAINER_TYPES = new Set<string>([
  'paragraph',
  'heading',
  'codeBlock',
  'tableCell',
  'tableHeader',
]);

export function isTextNode(node: ProseMirrorNode): boolean {
  return node.type === 'text';
}
