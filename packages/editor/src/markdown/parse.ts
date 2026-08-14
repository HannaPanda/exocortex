import MarkdownIt from 'markdown-it';

import {
  ADDRESSABLE_BLOCK_TYPES,
  BLOCK_ID_ATTRIBUTE,
  createBlockId,
  isValidBlockId,
} from '../block-id';
import { CALLOUT_VARIANTS, DEFAULT_CALLOUT_VARIANT } from '../callout';
import {
  type MarkdownToken,
  type ProseMirrorDocument,
  type ProseMirrorMark,
  type ProseMirrorNode,
} from '../contract';
import { buildMarkdownRegistry, type MarkdownRegistry } from '../extensions';
import { MARKDOWN_HIGHLIGHT_BACKGROUND } from '../inline-styling';
import { getExocortexSchema } from '../schema';

import {
  applyExocortexBlockRules,
  CONTAINER_TOKEN,
  readContainerToken,
} from './container-rule';
import { BLOCK_ID_SUFFIX_PATTERN, DocumentBuilder } from './document-builder';
import { type Frontmatter, parseFrontmatter } from './frontmatter';
import {
  applyExocortexInlineRules,
  EXOCORTEX_INLINE_MARK_TOKENS,
  type MarkdownItInstance,
} from './inline-rules';

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

/**
 * Applies one more mark to an active mark set the way ProseMirror's
 * `Mark.addToSet` would, so the parser can never emit a set the canonical
 * schema rejects.
 *
 * Only the all-excluding case (`excludes: '_'` in a mark spec, which inline
 * `code` uses) is handled, because that is the only exclusion the Exocortex
 * schema declares. markdown-it reports ``**`x`**`` as a strong token wrapped
 * around a code token, and concatenating those marks produced `bold,code` --
 * a set `Node.check()` refuses. That made `markdownToYjsState` reject an entire
 * document over one inline snippet, which is how seven vault notes ended up as
 * import-failure placeholders.
 */
function addMarkToSet(
  active: readonly ProseMirrorMark[],
  mark: ProseMirrorMark,
): ProseMirrorMark[] {
  const excludesEverything = (name: string): boolean =>
    getExocortexSchema().marks[name]?.spec.excludes === '_';

  if (excludesEverything(mark.type)) return [mark];
  if (active.some((existing) => excludesEverything(existing.type))) return [...active];
  return [...active, mark];
}

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

const CALLOUT_HEADER_PATTERN = /^\[!([A-Za-z]+)\][ \t]*([^\n]*)/;
const TASK_MARKER_PATTERN = /^\[([ xX])\][ \t]+/;

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
 * Opens or closes an emphasis-style mark and returns the new active set.
 *
 * Emphasis-style marks (`strong`, `em`, `s` and the Exocortex additions) all
 * follow the same `<prefix>_open` / `_close` shape, which is why they share one
 * branch instead of one case each. Unsupported inline tokens (raw HTML) leave
 * the set untouched: they are dropped, never crashed on.
 */
function applyInlineMarkToken(
  child: MarkdownItToken,
  activeMarks: readonly ProseMirrorMark[],
): ProseMirrorMark[] {
  const prefix = child.type.replace(/_(open|close)$/, '');
  const markType = INLINE_MARK_TOKENS[prefix];
  if (markType === undefined) return [...activeMarks];

  if (!child.type.endsWith('_open')) {
    return activeMarks.filter((mark) => mark.type !== markType);
  }
  const attrs = markAttributes(prefix);
  return addMarkToSet(activeMarks, attrs === undefined ? { type: markType } : { type: markType, attrs });
}

// --------------------------------------------------------------------------
// Token handlers
//
// One function per token family rather than one switch over everything. The
// families are independent: a table token never means anything to the list
// handler, so the dispatcher below simply offers the token around until someone
// claims it.
// --------------------------------------------------------------------------

/** Handles the table tokens; returns `false` when the token is not one. */
function appendTableToken(token: MarkdownToken, builder: DocumentBuilder): boolean {
  switch (token.type) {
    case 'table_open':
      builder.openNode('table');
      return true;
    case 'table_close':
      builder.closeNode();
      return true;
    // `thead` and `tbody` have no counterpart in the schema: whether a row is a
    // header row is already said by the cell type it contains.
    case 'thead_open':
    case 'thead_close':
    case 'tbody_open':
    case 'tbody_close':
      return true;
    case 'tr_open':
      builder.openNode('tableRow');
      return true;
    case 'tr_close':
      builder.closeNode();
      return true;
    case 'th_open':
      builder.openNode('tableHeader', { colspan: 1, rowspan: 1, colwidth: null });
      builder.openNode('paragraph');
      return true;
    case 'td_open':
      builder.openNode('tableCell', { colspan: 1, rowspan: 1, colwidth: null });
      builder.openNode('paragraph');
      return true;
    // A cell always wraps its content in a paragraph, so closing one closes two.
    case 'th_close':
    case 'td_close':
      builder.closeNode();
      builder.closeNode();
      return true;
    default:
      return false;
  }
}

/** Handles the list tokens; returns `false` when the token is not one. */
function appendListToken(
  token: MarkdownToken,
  index: number,
  tokens: readonly MarkdownToken[],
  builder: DocumentBuilder,
): boolean {
  switch (token.type) {
    case 'bullet_list_open':
      builder.openNode(isTaskList(tokens, index) ? 'taskList' : 'bulletList');
      return true;
    case 'ordered_list_open': {
      const start = Number.parseInt(String(token.attrGet('start') ?? '1'), 10);
      builder.openNode('orderedList', { start: Number.isNaN(start) ? 1 : start });
      return true;
    }
    case 'list_item_open':
      if (builder.openType === 'taskList') {
        builder.openNode('taskItem', { checked: readTaskMarker(tokens, index) });
      } else {
        builder.openNode('listItem');
      }
      return true;
    case 'bullet_list_close':
    case 'ordered_list_close':
    case 'list_item_close':
      builder.closeNode();
      return true;
    default:
      return false;
  }
}

/** Opens a blockquote, or the callout that is written as one. */
function openBlockquote(
  tokens: readonly MarkdownToken[],
  index: number,
  builder: DocumentBuilder,
): void {
  const callout = detectCallout(tokens, index);
  if (callout === null) {
    builder.openNode('blockquote');
    return;
  }
  const attrs: Record<string, unknown> = { variant: callout.variant, title: callout.title };
  if (callout.blockId !== null) attrs[BLOCK_ID_ATTRIBUTE] = callout.blockId;
  builder.openNode('callout', attrs);
  if (callout.emptyParagraph) builder.skipNextParagraph();
}

/** Adds a fenced or indented code block with its language and identifier. */
function appendCodeBlock(token: MarkdownToken, builder: DocumentBuilder): void {
  const { language, blockId } = parseFenceInfo(token.info);
  const attrs: Record<string, unknown> = { language };
  if (blockId !== null) attrs[BLOCK_ID_ATTRIBUTE] = blockId;
  builder.openNode('codeBlock', attrs);
  const text = token.content.replace(/\n$/, '');
  if (text.length > 0) builder.pushText(text, []);
  builder.closeNode();
}

/** Handles everything that is neither a table nor a list token. */
function appendBlockToken(
  token: MarkdownToken,
  index: number,
  tokens: readonly MarkdownToken[],
  builder: DocumentBuilder,
  registry: MarkdownRegistry,
): void {
  switch (token.type) {
    case 'heading_open': {
      const level = Number.parseInt(token.tag.slice(1), 10);
      builder.openNode('heading', { level: Number.isNaN(level) ? 1 : level });
      break;
    }
    case 'paragraph_open':
      // The paragraph a callout header consumed was never opened, so there is
      // nothing to open here either.
      if (builder.isSkippingParagraph) break;
      builder.openNode('paragraph');
      break;
    case 'paragraph_close':
      if (builder.isSkippingParagraph) {
        builder.consumeSkippedParagraph();
        break;
      }
      builder.closeNode();
      break;

    case 'blockquote_open':
      openBlockquote(tokens, index, builder);
      break;

    case 'heading_close':
    case 'blockquote_close':
      builder.closeNode();
      break;

    case 'fence':
    case 'code_block':
      appendCodeBlock(token, builder);
      break;

    case 'hr':
      builder.addNode('horizontalRule');
      break;

    case 'inline':
      appendInlineTokens(token.children ?? [], builder, registry);
      break;

    default:
      break;
  }
}

/** Adds the children of one `inline` token, and clears the marks afterwards. */
function appendInlineTokens(
  children: readonly MarkdownToken[],
  builder: DocumentBuilder,
  registry: MarkdownRegistry,
): void {
  for (const child of children) {
    // Inline nodes contributed by extensions (for example inline maths).
    const childHandler = registry.tokens[child.type];
    if (childHandler !== undefined && childHandler(child, builder.tokenContext) === true) continue;

    switch (child.type) {
      case 'text':
        builder.addText(child.content);
        break;
      case 'softbreak':
        builder.pushText(' ', builder.activeMarks);
        break;
      case 'hardbreak':
        builder.addNode('hardBreak');
        break;
      case 'code_inline':
        builder.pushText(child.content, addMarkToSet(builder.activeMarks, { type: 'code' }));
        break;
      case 'link_open':
        builder.activeMarks = addMarkToSet(builder.activeMarks, {
          type: 'link',
          attrs: {
            href: String(child.attrGet('href') ?? ''),
            title: asOptionalString(child.attrGet('title')),
            target: null,
          },
        });
        break;
      case 'link_close':
        builder.activeMarks = builder.activeMarks.filter((mark) => mark.type !== 'link');
        break;
      case 'image':
        builder.addPendingImage({
          type: 'image',
          attrs: {
            src: String(child.attrGet('src') ?? ''),
            alt: child.content,
            title: asOptionalString(child.attrGet('title')),
          },
        });
        break;
      default:
        builder.activeMarks = applyInlineMarkToken(child, builder.activeMarks);
        break;
    }
  }
  builder.activeMarks = [];
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
  const tokens: readonly MarkdownToken[] = createMarkdownIt().parse(body, {});
  const registry = buildMarkdownRegistry();
  const builder = new DocumentBuilder();

  /**
   * How many nodes each open container pushed, so the closing `:::` closes
   * exactly those. See `MarkdownContainerOpener`.
   */
  const containerDepths: number[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined) continue;

    // Extensions contribute their own token handlers; the families below only
    // cover what markdown-it produces for the CommonMark and GFM syntax.
    const handler = registry.tokens[token.type];
    if (handler !== undefined && handler(token, builder.tokenContext) === true) continue;

    if (token.type === `${CONTAINER_TOKEN}_open`) {
      const { name, params } = readContainerToken(token.info);
      const opener = registry.containers[name];
      containerDepths.push(opener === undefined ? 0 : opener(params, builder.tokenContext));
      continue;
    }
    if (token.type === `${CONTAINER_TOKEN}_close`) {
      const depth = containerDepths.pop() ?? 0;
      for (let closed = 0; closed < depth; closed += 1) builder.closeNode();
      continue;
    }

    if (appendTableToken(token, builder)) continue;
    if (appendListToken(token, index, tokens, builder)) continue;
    appendBlockToken(token, index, tokens, builder, registry);
  }

  const document = builder.finish();
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
