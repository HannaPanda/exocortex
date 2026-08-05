import MarkdownIt from 'markdown-it';

import {
  ADDRESSABLE_BLOCK_TYPES,
  BLOCK_ID_ATTRIBUTE,
  createBlockId,
  isValidBlockId,
} from '../block-id';
import { CALLOUT_VARIANTS, DEFAULT_CALLOUT_VARIANT } from '../callout';
import {
  type MarkdownTokenHandlerContext,
  type ProseMirrorDocument,
  type ProseMirrorMark,
  type ProseMirrorNode,
} from '../contract';
import { buildMarkdownRegistry } from '../extensions';
import { MARKDOWN_HIGHLIGHT_BACKGROUND } from '../inline-styling';

import {
  applyExocortexBlockRules,
  CONTAINER_TOKEN,
  readContainerToken,
} from './container-rule';
import { type Frontmatter, parseFrontmatter } from './frontmatter';
import {
  applyExocortexInlineRules,
  EXOCORTEX_INLINE_MARK_TOKENS,
  type MarkdownItInstance,
} from './inline-rules';
import { WIKI_LINK_SCHEME } from './serialize';

/**
 * markdown-it token prefixes that map onto an Exocortex mark, including the
 * built-in ones. Every entry is handled by the generic `<prefix>_open` /
 * `<prefix>_close` branch below.
 */
const INLINE_MARK_TOKENS: Readonly<Record<string, string>> = {
  strong: 'bold',
  em: 'italic',
  s: 'strike',
  ...EXOCORTEX_INLINE_MARK_TOKENS,
};

/** Block types that carry a stable identifier. */
const ADDRESSABLE_BLOCK_TYPES_SET = new Set<string>(ADDRESSABLE_BLOCK_TYPES);

export interface ParseMarkdownOptions {
  /**
   * Assigns fresh identifiers to every addressable block that does not carry one
   * in the source. Enabled by default: an imported document must be fully
   * addressable immediately.
   */
  assignBlockIds?: boolean;
}

export interface ParsedDocument {
  document: ProseMirrorDocument;
  frontmatter: Frontmatter;
  /** Title from frontmatter, else the first top-level heading, else `null`. */
  title: string | null;
}

interface StackEntry {
  type: string;
  attrs: Record<string, unknown>;
  content: ProseMirrorNode[];
}

const BLOCK_ID_SUFFIX_PATTERN = /(?:^|\s)\^([a-z0-9]{8,32})$/;
const CALLOUT_HEADER_PATTERN = /^\[!([A-Za-z]+)\][ \t]*([^\n]*)/;
const TASK_MARKER_PATTERN = /^\[([ xX])\][ \t]+/;
const WIKI_LINK_PATTERN = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;

function createMarkdownIt(): MarkdownItInstance {
  const md = new MarkdownIt('default', {
    // Raw HTML is intentionally not supported: HTML is never canonical in
    // Exocortex (ADR-007) and accepting it would create an XSS surface.
    html: false,
    linkify: true,
    breaks: false,
    typographer: false,
  });
  applyExocortexInlineRules(md);
  applyExocortexBlockRules(md);
  return md;
}

/** Attributes a mark carries when it originates from a markdown-it token. */
function markAttributes(tokenPrefix: string): Record<string, unknown> | undefined {
  // Markdown only knows one highlight; it maps to the default background token.
  if (tokenPrefix === 'highlight') {
    return { color: null, background: MARKDOWN_HIGHLIGHT_BACKGROUND };
  }
  return undefined;
}

/**
 * Parses Markdown into ProseMirror JSON matching the canonical Exocortex schema.
 *
 * Supported syntax: headings, paragraphs, emphasis, inline code, fenced code,
 * blockquotes, bullet/ordered lists, task lists, tables, images, links, wiki
 * links (`[[Seite]]` / `[[Seite|Label]]`), horizontal rules, hard breaks,
 * Exocortex callouts (`> [!info] Titel`) and stable block identifiers (`^id`).
 */
export function parseMarkdown(
  markdown: string,
  options: ParseMarkdownOptions = {},
): ParsedDocument {
  const assignBlockIds = options.assignBlockIds ?? true;
  const { frontmatter, body } = parseFrontmatter(markdown);
  const tokens = createMarkdownIt().parse(body, {});
  const registry = buildMarkdownRegistry();

  const root: StackEntry = { type: 'doc', attrs: {}, content: [] };
  const stack: StackEntry[] = [root];
  let activeMarks: ProseMirrorMark[] = [];
  let skipParagraph = 0;
  /**
   * Images are block-level in the Exocortex schema, but Markdown places them
   * inline. They are buffered while an inline container is open and flushed as
   * siblings once that container closes.
   */
  let pendingImages: ProseMirrorNode[] = [];

  const top = (): StackEntry => stack[stack.length - 1] as StackEntry;

  const openNode = (type: string, attrs: Record<string, unknown> = {}): void => {
    stack.push({ type, attrs, content: [] });
  };

  const closeNode = (): void => {
    const entry = stack.pop();
    if (entry === undefined) return;
    extractTrailingBlockId(entry);
    const node: ProseMirrorNode = { type: entry.type };
    if (Object.keys(entry.attrs).length > 0) node.attrs = entry.attrs;
    if (entry.content.length > 0) node.content = entry.content;

    const dropEmptyWrapper =
      entry.type === 'paragraph' && entry.content.length === 0 && pendingImages.length > 0;
    if (!dropEmptyWrapper) top().content.push(node);

    if (pendingImages.length > 0 && (entry.type === 'paragraph' || entry.type === 'heading')) {
      top().content.push(...pendingImages);
      pendingImages = [];
    }
  };

  const addNode = (
    type: string,
    attrs: Record<string, unknown> = {},
    content?: ProseMirrorNode[],
  ): void => {
    const node: ProseMirrorNode = { type };
    if (Object.keys(attrs).length > 0) node.attrs = attrs;
    if (content !== undefined && content.length > 0) node.content = content;
    top().content.push(node);
  };

  const pushText = (text: string, marks: ProseMirrorMark[]): void => {
    if (text.length === 0) return;
    const node: ProseMirrorNode = { type: 'text', text };
    if (marks.length > 0) node.marks = marks.map((mark) => ({ ...mark }));
    top().content.push(node);
  };

  /** Splits `[[Target|Label]]` occurrences into wiki link marks. */
  const addText = (text: string): void => {
    WIKI_LINK_PATTERN.lastIndex = 0;
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = WIKI_LINK_PATTERN.exec(text)) !== null) {
      pushText(text.slice(lastIndex, match.index), activeMarks);
      const target = (match[1] ?? '').trim();
      const label = (match[2] ?? target).trim();
      pushText(label, [
        ...activeMarks,
        { type: 'link', attrs: { href: `${WIKI_LINK_SCHEME}${target}`, title: null, target: null } },
      ]);
      lastIndex = match.index + match[0].length;
    }
    pushText(text.slice(lastIndex), activeMarks);
  };

  /** Moves a trailing ` ^id` from the last text node into the block attributes. */
  const extractTrailingBlockId = (entry: StackEntry): void => {
    if (!ADDRESSABLE_BLOCK_TYPES_SET.has(entry.type)) return;
    if (isValidBlockId(entry.attrs[BLOCK_ID_ATTRIBUTE])) return;
    const last = entry.content[entry.content.length - 1];
    if (last === undefined || last.type !== 'text' || last.text === undefined) return;
    const match = BLOCK_ID_SUFFIX_PATTERN.exec(last.text);
    if (match === null) return;
    const stripped = last.text.slice(0, match.index);
    if (stripped.length === 0) {
      entry.content.pop();
    } else {
      last.text = stripped;
    }
    entry.attrs[BLOCK_ID_ATTRIBUTE] = match[1] as string;
  };

  const tokenContext: MarkdownTokenHandlerContext = {
    openNode,
    closeNode,
    addNode,
    addTextNode: (type, text, attrs = {}) =>
      addNode(type, attrs, text.length > 0 ? [{ type: 'text', text }] : undefined),
    addText,
    openMark: (type, attrs) => {
      activeMarks = [...activeMarks, attrs === undefined ? { type } : { type, attrs }];
    },
    closeMark: (type) => {
      activeMarks = activeMarks.filter((mark) => mark.type !== type);
    },
  };

  /**
   * How many nodes each open container pushed, so the closing `:::` closes
   * exactly those. See `MarkdownContainerOpener`.
   */
  const containerDepths: number[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined) continue;

    // Extensions contribute their own token handlers; the built-in cases below
    // only cover what markdown-it produces for the CommonMark and GFM syntax.
    const handler = registry.tokens[token.type];
    if (handler !== undefined && handler(token, tokenContext) === true) continue;

    if (token.type === `${CONTAINER_TOKEN}_open`) {
      const { name, params } = readContainerToken(token.info);
      const opener = registry.containers[name];
      containerDepths.push(opener === undefined ? 0 : opener(params, tokenContext));
      continue;
    }
    if (token.type === `${CONTAINER_TOKEN}_close`) {
      const depth = containerDepths.pop() ?? 0;
      for (let closed = 0; closed < depth; closed += 1) closeNode();
      continue;
    }

    switch (token.type) {
      case 'heading_open': {
        const level = Number.parseInt(token.tag.slice(1), 10);
        openNode('heading', { level: Number.isNaN(level) ? 1 : level });
        break;
      }
      case 'heading_close':
        closeNode();
        break;

      case 'paragraph_open':
        if (skipParagraph > 0) break;
        openNode('paragraph');
        break;
      case 'paragraph_close':
        if (skipParagraph > 0) {
          skipParagraph -= 1;
          break;
        }
        closeNode();
        break;

      case 'blockquote_open': {
        const callout = detectCallout(tokens, index);
        if (callout !== null) {
          const attrs: Record<string, unknown> = {
            variant: callout.variant,
            title: callout.title,
          };
          if (callout.blockId !== null) attrs[BLOCK_ID_ATTRIBUTE] = callout.blockId;
          openNode('callout', attrs);
          if (callout.emptyParagraph) skipParagraph += 1;
        } else {
          openNode('blockquote');
        }
        break;
      }
      case 'blockquote_close':
        closeNode();
        break;

      case 'bullet_list_open':
        openNode(isTaskList(tokens, index) ? 'taskList' : 'bulletList');
        break;
      case 'bullet_list_close':
        closeNode();
        break;

      case 'ordered_list_open': {
        const start = Number.parseInt(String(token.attrGet('start') ?? '1'), 10);
        openNode('orderedList', { start: Number.isNaN(start) ? 1 : start });
        break;
      }
      case 'ordered_list_close':
        closeNode();
        break;

      case 'list_item_open': {
        const isTask = top().type === 'taskList';
        if (isTask) {
          const marker = readTaskMarker(tokens, index);
          openNode('taskItem', { checked: marker });
        } else {
          openNode('listItem');
        }
        break;
      }
      case 'list_item_close':
        closeNode();
        break;

      case 'fence':
      case 'code_block': {
        const { language, blockId } = parseFenceInfo(token.info);
        const attrs: Record<string, unknown> = { language };
        if (blockId !== null) attrs[BLOCK_ID_ATTRIBUTE] = blockId;
        openNode('codeBlock', attrs);
        const text = token.content.replace(/\n$/, '');
        if (text.length > 0) pushText(text, []);
        closeNode();
        break;
      }

      case 'hr':
        addNode('horizontalRule');
        break;

      case 'table_open':
        openNode('table');
        break;
      case 'table_close':
        closeNode();
        break;
      case 'thead_open':
      case 'thead_close':
      case 'tbody_open':
      case 'tbody_close':
        break;
      case 'tr_open':
        openNode('tableRow');
        break;
      case 'tr_close':
        closeNode();
        break;
      case 'th_open':
        openNode('tableHeader', { colspan: 1, rowspan: 1, colwidth: null });
        openNode('paragraph');
        break;
      case 'th_close':
        closeNode();
        closeNode();
        break;
      case 'td_open':
        openNode('tableCell', { colspan: 1, rowspan: 1, colwidth: null });
        openNode('paragraph');
        break;
      case 'td_close':
        closeNode();
        closeNode();
        break;

      case 'inline': {
        const children = token.children ?? [];
        for (const child of children) {
          // Inline nodes contributed by extensions (for example inline maths).
          const childHandler = registry.tokens[child.type];
          if (childHandler !== undefined && childHandler(child, tokenContext) === true) continue;

          switch (child.type) {
            case 'text':
              addText(child.content);
              break;
            case 'softbreak':
              pushText(' ', activeMarks);
              break;
            case 'hardbreak':
              addNode('hardBreak');
              break;
            case 'code_inline':
              pushText(child.content, [...activeMarks, { type: 'code' }]);
              break;
            case 'link_open':
              activeMarks = [
                ...activeMarks,
                {
                  type: 'link',
                  attrs: {
                    href: String(child.attrGet('href') ?? ''),
                    title: asOptionalString(child.attrGet('title')),
                    target: null,
                  },
                },
              ];
              break;
            case 'link_close':
              activeMarks = activeMarks.filter((mark) => mark.type !== 'link');
              break;
            case 'image':
              pendingImages.push({
                type: 'image',
                attrs: {
                  src: String(child.attrGet('src') ?? ''),
                  alt: child.content,
                  title: asOptionalString(child.attrGet('title')),
                },
              });
              break;
            default: {
              // Emphasis-style marks (`strong`, `em`, `s` and the Exocortex
              // additions) all follow the same `<prefix>_open` / `_close` shape.
              const opening = child.type.endsWith('_open');
              const prefix = child.type.replace(/_(open|close)$/, '');
              const markType = INLINE_MARK_TOKENS[prefix];
              if (markType === undefined) {
                // Unsupported inline tokens (raw HTML) are dropped, never crashed on.
                break;
              }
              if (opening) {
                const attrs = markAttributes(prefix);
                activeMarks = [
                  ...activeMarks,
                  attrs === undefined ? { type: markType } : { type: markType, attrs },
                ];
              } else {
                activeMarks = activeMarks.filter((mark) => mark.type !== markType);
              }
              break;
            }
          }
        }
        activeMarks = [];
        break;
      }

      default:
        break;
    }
  }

  const document: ProseMirrorDocument = {
    type: 'doc',
    content: root.content.length > 0 ? root.content : [{ type: 'paragraph' }],
  };

  normalizeTextRuns(document);
  if (assignBlockIds) ensureBlockIds(document);

  return {
    document,
    frontmatter,
    title: frontmatter.title ?? findFirstHeadingText(document),
  };
}

function parseFenceInfo(info: string): { language: string; blockId: string | null } {
  const parts = info.trim().split(/\s+/).filter((part) => part.length > 0);
  let blockId: string | null = null;
  const languageParts: string[] = [];
  for (const part of parts) {
    if (part.startsWith('^') && isValidBlockId(part.slice(1))) {
      blockId = part.slice(1);
    } else {
      languageParts.push(part);
    }
  }
  return { language: languageParts.join(' '), blockId };
}

/** Reads the `[ ]` / `[x]` marker of a task item and strips it from the source. */
function readTaskMarker(tokens: readonly MarkdownItToken[], listItemIndex: number): boolean {
  for (let index = listItemIndex + 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined) continue;
    if (token.type === 'list_item_close') return false;
    if (token.type !== 'inline') continue;
    const match = TASK_MARKER_PATTERN.exec(token.content);
    if (match === null) return false;
    const checked = (match[1] ?? ' ').toLowerCase() === 'x';
    stripLeadingText(token, match[0].length);
    return checked;
  }
  return false;
}

function isTaskList(tokens: readonly MarkdownItToken[], listOpenIndex: number): boolean {
  let depth = 0;
  for (let index = listOpenIndex; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined) continue;
    if (token.type === 'bullet_list_open') depth += 1;
    if (token.type === 'bullet_list_close') {
      depth -= 1;
      if (depth === 0) return false;
    }
    if (token.type === 'inline') {
      return TASK_MARKER_PATTERN.test(token.content);
    }
  }
  return false;
}

interface CalloutDetection {
  variant: string;
  title: string | null;
  blockId: string | null;
  emptyParagraph: boolean;
}

/**
 * Detects the Exocortex callout header inside a blockquote and removes it from
 * the token stream so it does not appear in the content.
 */
function detectCallout(
  tokens: readonly MarkdownItToken[],
  blockquoteIndex: number,
): CalloutDetection | null {
  const inlineToken = tokens[blockquoteIndex + 2];
  if (
    tokens[blockquoteIndex + 1]?.type !== 'paragraph_open' ||
    inlineToken === undefined ||
    inlineToken.type !== 'inline'
  ) {
    return null;
  }

  const match = CALLOUT_HEADER_PATTERN.exec(inlineToken.content);
  if (match === null) return null;

  const rawVariant = (match[1] ?? '').toLowerCase();
  const variant = (CALLOUT_VARIANTS as readonly string[]).includes(rawVariant)
    ? rawVariant
    : DEFAULT_CALLOUT_VARIANT;
  const titleSource = (match[2] ?? '').trim();
  const blockIdMatch = BLOCK_ID_SUFFIX_PATTERN.exec(titleSource);
  const title =
    blockIdMatch === null
      ? titleSource
      : titleSource.slice(0, blockIdMatch.index).trim();

  const consumed = match[0].length;
  const emptyParagraph = stripLeadingText(inlineToken, consumed);

  return {
    variant,
    title: title.length > 0 ? title : null,
    blockId: blockIdMatch === null ? null : (blockIdMatch[1] as string),
    emptyParagraph,
  };
}

/**
 * Removes `length` characters from the beginning of an inline token, including
 * its already parsed children. Returns `true` when nothing is left.
 */
function stripLeadingText(token: MarkdownItToken, length: number): boolean {
  token.content = token.content.slice(length);
  const children = token.children ?? [];
  let remaining = length;
  while (remaining > 0 && children.length > 0) {
    const first = children[0];
    if (first === undefined) break;
    if (first.type !== 'text') {
      children.shift();
      continue;
    }
    if (first.content.length > remaining) {
      first.content = first.content.slice(remaining);
      remaining = 0;
    } else {
      remaining -= first.content.length;
      children.shift();
    }
  }
  while (children.length > 0 && children[0]?.type === 'softbreak') children.shift();
  while (children.length > 0 && children[0]?.type === 'text' && children[0].content.length === 0) {
    children.shift();
  }
  token.children = children;
  return children.length === 0;
}

function findFirstHeadingText(document: ProseMirrorDocument): string | null {
  for (const node of document.content ?? []) {
    if (node.type !== 'heading') continue;
    const text = (node.content ?? [])
      .map((child) => child.text ?? '')
      .join('')
      .trim();
    if (text.length > 0) return text;
  }
  return null;
}

/**
 * Merges adjacent text nodes that carry identical marks. ProseMirror normalizes
 * this internally, so doing it here keeps parsed JSON comparable across round
 * trips.
 */
export function normalizeTextRuns(node: ProseMirrorNode): void {
  const children = node.content;
  if (children === undefined) return;

  const merged: ProseMirrorNode[] = [];
  for (const child of children) {
    normalizeTextRuns(child);
    // Marks are a set, not a sequence. Sorting them canonically means the same
    // formatting always produces the same JSON, no matter in which order the
    // Markdown delimiters happened to be nested.
    if (child.marks !== undefined && child.marks.length > 1) {
      child.marks = [...child.marks].sort((a, b) =>
        a.type === b.type
          ? JSON.stringify(a.attrs ?? {}).localeCompare(JSON.stringify(b.attrs ?? {}))
          : a.type.localeCompare(b.type),
      );
    }
    const previous = merged[merged.length - 1];
    if (
      previous !== undefined &&
      previous.type === 'text' &&
      child.type === 'text' &&
      JSON.stringify(previous.marks ?? []) === JSON.stringify(child.marks ?? [])
    ) {
      previous.text = `${previous.text ?? ''}${child.text ?? ''}`;
      continue;
    }
    merged.push(child);
  }
  node.content = merged;
}

/** Assigns identifiers to addressable blocks that do not have one yet. */
export function ensureBlockIds(document: ProseMirrorDocument): void {
  const seen = new Set<string>();
  const walk = (node: ProseMirrorNode): void => {
    if (ADDRESSABLE_BLOCK_TYPES_SET.has(node.type)) {
      const current = node.attrs?.[BLOCK_ID_ATTRIBUTE];
      if (isValidBlockId(current) && !seen.has(current)) {
        seen.add(current);
      } else {
        let id = createBlockId();
        while (seen.has(id)) id = createBlockId();
        seen.add(id);
        node.attrs = { ...(node.attrs ?? {}), [BLOCK_ID_ATTRIBUTE]: id };
      }
    }
    for (const child of node.content ?? []) walk(child);
  };
  walk(document);
}

/** Normalizes a markdown-it attribute value to a nullable string. */
function asOptionalString(value: string | number | null): string | null {
  return value === null ? null : String(value);
}

/** Structural subset of the markdown-it token used by this module. */
interface MarkdownItToken {
  type: string;
  tag: string;
  info: string;
  content: string;
  children: MarkdownItToken[] | null;
  attrGet(name: string): string | number | null;
}
