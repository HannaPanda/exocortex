import { BLOCK_ID_ATTRIBUTE, isValidBlockId } from '../block-id';
import {
  EXOCORTEX_SCHEMA_VERSION,
  type MarkdownMarkSerializer,
  type MarkdownSerializerContext,
  type ProseMirrorDocument,
  type ProseMirrorMark,
  type ProseMirrorNode,
} from '../contract';
import { buildMarkdownRegistry } from '../extensions';

import { escapeInlineText } from './core-adapter';
import { type Frontmatter, serializeFrontmatter } from './frontmatter';

export const WIKI_LINK_SCHEME = 'wiki:';

export interface SerializeMarkdownOptions {
  /**
   * Embeds stable block identifiers as an Obsidian-compatible `^id` suffix.
   * Off by default so exported files stay clean; the round-trip test enables it.
   */
  includeBlockIds?: boolean;
  frontmatter?: Omit<Frontmatter, 'unknown'> & { unknown?: Record<string, unknown> };
}

function markKey(mark: ProseMirrorMark): string {
  return `${mark.type}:${JSON.stringify(mark.attrs ?? {})}`;
}

function sameMarks(a: readonly ProseMirrorMark[], b: readonly ProseMirrorMark[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((mark, index) => markKey(mark) === markKey(b[index] as ProseMirrorMark));
}

function resolve(value: string | ((mark: ProseMirrorMark) => string), mark: ProseMirrorMark): string {
  return typeof value === 'function' ? value(mark) : value;
}

/**
 * Serializes a document to deterministic Markdown.
 *
 * Markdown is an interchange format, never the canonical collaborative state
 * (ADR-007). Exact whitespace is not preserved on round trips; semantic content
 * is.
 */
export function serializeMarkdown(
  document: ProseMirrorDocument,
  options: SerializeMarkdownOptions = {},
): string {
  const registry = buildMarkdownRegistry();
  const includeBlockIds = options.includeBlockIds ?? false;

  const blockIdSuffix = (node: ProseMirrorNode): string => {
    if (!includeBlockIds) return '';
    const value = node.attrs?.[BLOCK_ID_ATTRIBUTE];
    return isValidBlockId(value) ? ` ^${value}` : '';
  };

  const indentBlock = (text: string, firstPrefix: string, restPrefix: string): string =>
    text
      .split('\n')
      .map((line, index) => {
        const prefix = index === 0 ? firstPrefix : restPrefix;
        return line.length === 0 ? prefix.trimEnd() : `${prefix}${line}`;
      })
      .join('\n');

  const renderInline = (node: ProseMirrorNode): string => {
    const children = node.content ?? [];
    const runs: { marks: ProseMirrorMark[]; nodes: ProseMirrorNode[] }[] = [];

    for (const child of children) {
      const marks = child.marks ?? [];
      const last = runs[runs.length - 1];
      if (last !== undefined && sameMarks(last.marks, marks)) {
        last.nodes.push(child);
      } else {
        runs.push({ marks: [...marks], nodes: [child] });
      }
    }

    return runs.map((run) => renderRun(run.marks, run.nodes)).join('');
  };

  const renderRun = (marks: ProseMirrorMark[], nodes: ProseMirrorNode[]): string => {
    const wikiLink = marks.find(
      (mark) =>
        mark.type === 'link' &&
        typeof mark.attrs?.href === 'string' &&
        mark.attrs.href.startsWith(WIKI_LINK_SCHEME),
    );

    const raw = marks.some((mark) => registry.marks[mark.type]?.raw === true);
    let body = nodes
      .map((child) => {
        if (child.type === 'hardBreak') return '\\\n';
        if (child.type === 'text') return raw ? (child.text ?? '') : escapeInlineText(child.text ?? '');
        // Inline nodes other than text (for example inline images).
        return renderBlock(child).trimEnd();
      })
      .join('');

    if (wikiLink !== undefined) {
      const target = (wikiLink.attrs?.href as string).slice(WIKI_LINK_SCHEME.length);
      const label = nodes.map((child) => child.text ?? '').join('');
      return label === target ? `[[${target}]]` : `[[${target}|${label}]]`;
    }

    const ordered = marks
      .filter((mark) => registry.marks[mark.type] !== undefined)
      .sort((a, b) => {
        const left = registry.marks[a.type] as MarkdownMarkSerializer;
        const right = registry.marks[b.type] as MarkdownMarkSerializer;
        return (right.priority ?? 0) - (left.priority ?? 0);
      });

    for (const mark of ordered) {
      const serializer = registry.marks[mark.type] as MarkdownMarkSerializer;
      body = `${resolve(serializer.open, mark)}${body}${resolve(serializer.close, mark)}`;
    }
    return body;
  };

  const renderBlockChildren = (node: ProseMirrorNode): string =>
    (node.content ?? []).map((child) => renderBlock(child)).join('');

  const renderBlock = (node: ProseMirrorNode): string => {
    const serializer = registry.blocks[node.type];
    if (serializer !== undefined) return serializer(node, context);
    // Unknown node types must never silently disappear.
    if ((node.content ?? []).length > 0) return renderBlockChildren(node);
    return node.text !== undefined ? `${node.text}\n\n` : '';
  };

  const context: MarkdownSerializerContext = {
    renderBlockChildren,
    renderBlock,
    renderInline,
    indentBlock,
    includeBlockIds,
    blockIdSuffix,
  };

  const body = (document.content ?? [])
    .map((node) => renderBlock(node))
    .join('')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\s+$/, '');

  const frontmatter =
    options.frontmatter === undefined
      ? ''
      : serializeFrontmatter({
          ...options.frontmatter,
          exocortexSchemaVersion:
            options.frontmatter.exocortexSchemaVersion ?? EXOCORTEX_SCHEMA_VERSION,
          unknown: options.frontmatter.unknown ?? {},
        });

  return `${frontmatter}${body}${body.length > 0 ? '\n' : ''}`;
}
