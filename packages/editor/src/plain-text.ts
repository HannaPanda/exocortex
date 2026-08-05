import { BLOCK_ID_ATTRIBUTE } from './block-id';
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
    .map((node) => renderNode(node))
    .filter((value) => value.trim().length > 0)
    .join('\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
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
