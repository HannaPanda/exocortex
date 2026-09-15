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

function resolve(
  value: string | ((mark: ProseMirrorMark) => string),
  mark: ProseMirrorMark,
): string {
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

  /** Marks sorted so the highest priority is applied furthest outside. */
  const orderMarks = (marks: readonly ProseMirrorMark[]): ProseMirrorMark[] =>
    marks
      .filter((mark) => registry.marks[mark.type] !== undefined)
      .sort((a, b) => {
        const left = registry.marks[a.type] as MarkdownMarkSerializer;
        const right = registry.marks[b.type] as MarkdownMarkSerializer;
        return (right.priority ?? 0) - (left.priority ?? 0);
      });

  const wikiLinkOf = (marks: readonly ProseMirrorMark[]): ProseMirrorMark | undefined =>
    marks.find(
      (mark) =>
        mark.type === 'link' &&
        typeof mark.attrs?.href === 'string' &&
        mark.attrs.href.startsWith(WIKI_LINK_SCHEME),
    );

  /**
   * Renders inline content by keeping a stack of open marks.
   *
   * Delimiters are only closed and reopened where the mark sets actually differ,
   * so partially overlapping formatting nests instead of producing adjacent
   * delimiter pairs. `**fett und ==hervorgehoben==**` stays one bold span; naive
   * per-run rendering would emit `**fett und ****==hervorgehoben==**`, which
   * Markdown reads back as something else entirely.
   */
  const renderInline = (node: ProseMirrorNode): string => {
    const children = node.content ?? [];
    const open: ProseMirrorMark[] = [];
    let result = '';

    /*
     * Closes marks down to `depth`, with any trailing space moved out of the
     * way first.
     *
     * Markdown does not accept a closing delimiter that follows a space:
     * `*kursiv und *` is literal text, and what comes back in is an emphasis
     * run that opens somewhere else entirely -- on the page that found this,
     * `*Text nach *[[Ziel]]*.*` reparsed into a text node carrying `italic`
     * twice, which the schema refuses outright. So the space moves behind the
     * delimiter, where it means the same thing and closes cleanly.
     */
    const closeDownTo = (depth: number): void => {
      if (open.length <= depth) return;
      const trailing = /[ \t]+$/.exec(result)?.[0] ?? '';
      if (trailing.length > 0) result = result.slice(0, -trailing.length);
      while (open.length > depth) {
        const mark = open.pop() as ProseMirrorMark;
        const serializer = registry.marks[mark.type] as MarkdownMarkSerializer;
        result += resolve(serializer.close, mark);
      }
      result += trailing;
    };

    for (const child of children) {
      const marks = child.marks ?? [];

      // A wiki link owns its whole span: no other delimiter may wrap it.
      const wikiLink = wikiLinkOf(marks);
      if (wikiLink !== undefined) {
        closeDownTo(0);
        const target = (wikiLink.attrs?.href as string).slice(WIKI_LINK_SCHEME.length);
        const label = child.text ?? '';
        result += label === target ? `[[${target}]]` : `[[${target}|${label}]]`;
        continue;
      }

      const desired = orderMarks(marks);

      // Keep the longest prefix of already open marks that this node still
      // carries, even when priority would place them elsewhere. Closing and
      // immediately reopening a mark around a trailing space produces
      // delimiters Markdown does not accept (`*kursiv und *` is literal text).
      let keep = 0;
      while (
        keep < open.length &&
        desired.some((mark) => markKey(mark) === markKey(open[keep] as ProseMirrorMark))
      ) {
        keep += 1;
      }
      closeDownTo(keep);

      const kept = open.slice(0, keep);
      for (const mark of desired) {
        if (kept.some((active) => markKey(active) === markKey(mark))) continue;
        const serializer = registry.marks[mark.type] as MarkdownMarkSerializer;
        result += resolve(serializer.open, mark);
        open.push(mark);
      }

      const raw = desired.some((mark) => registry.marks[mark.type]?.raw === true);
      if (child.type === 'hardBreak') {
        result += '\\\n';
      } else if (child.type === 'text') {
        result += raw ? (child.text ?? '') : escapeInlineText(child.text ?? '');
      } else {
        // Inline nodes other than text (for example inline images or math).
        result += renderBlock(child).trimEnd();
      }
    }

    closeDownTo(0);
    return result;
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
