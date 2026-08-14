import { type ProseMirrorDocument, type ProseMirrorMark, type ProseMirrorNode } from '../contract';

import { WIKI_LINK_SCHEME } from './serialize';

/**
 * Block node types the AI chat renders (issue #21). Deliberately small: the
 * chat bubble does not need the page's full vocabulary, only what a model
 * reply typically contains -- prose, code, lists, quotes and tables.
 */
const ALLOWED_BLOCK_TYPES: ReadonlySet<string> = new Set([
  'paragraph',
  'heading',
  'blockquote',
  'bulletList',
  'orderedList',
  'listItem',
  'codeBlock',
  'table',
  'tableRow',
  'tableHeader',
  'tableCell',
]);

/** Inline leaf nodes with no text of their own that are safe to keep. */
const ALLOWED_LEAF_TYPES: ReadonlySet<string> = new Set(['hardBreak']);

/**
 * Marks the chat renders. `strike`, `textColor` (Markdown `==highlight==`),
 * `underline`, `superscript` and `subscript` are dropped: the text survives,
 * only the extra styling does not.
 */
const ALLOWED_MARK_TYPES: ReadonlySet<string> = new Set(['bold', 'italic', 'code', 'link']);

/**
 * Node types with no chat rendering that degrade into one that has, instead of
 * vanishing outright.
 *
 * A `taskList`/`taskItem` degrades to a plain `bulletList`/`listItem`: the
 * parser already moved the `[ ]` / `[x]` marker into an attribute this module
 * does not carry over, so the remaining text is ordinary list content. A
 * `callout` degrades to a `blockquote` the same way, dropping its title and
 * variant.
 */
const TYPE_FALLBACKS: Readonly<Record<string, string>> = {
  taskList: 'bulletList',
  taskItem: 'listItem',
  callout: 'blockquote',
};

/**
 * URL schemes that turn a link into code execution (`javascript:`, legacy
 * `vbscript:`) or an embedded document (`data:`) instead of a navigation.
 */
const DANGEROUS_HREF_SCHEMES: ReadonlySet<string> = new Set(['javascript', 'data', 'vbscript']);

/**
 * Strips a link's `href` down to something safe to put in an `href` attribute,
 * or returns `null` when the mark should be dropped instead.
 *
 * Only the scheme is checked. The text the model wrote is never trustworthy
 * (issue #21): `javascript:` and `data:` are the two schemes that turn a click
 * into code execution or an embedded document rather than a navigation, and
 * `vbscript:` is the same class of bug on legacy Internet Explorer.
 */
export function sanitizeLinkHref(href: string): string | null {
  const trimmed = href.trim();
  if (trimmed.length === 0) return null;
  // Browsers ignore ASCII tabs/newlines/carriage-returns inside a URL, which is
  // how `java\nscript:alert(1)` slips past a naive `startsWith` check.
  const withoutControlChars = trimmed.replace(/[\t\n\r]/g, '');
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(withoutControlChars)?.[1]?.toLowerCase();
  if (scheme !== undefined && DANGEROUS_HREF_SCHEMES.has(scheme)) return null;
  return trimmed;
}

/**
 * Keeps only the marks {@link ALLOWED_MARK_TYPES} allows, and sanitizes a
 * `link` mark's `href` in the same pass.
 *
 * A `wiki:` href (`[[Seite]]`, see `WIKI_LINK_SCHEME`) is left untouched: it is
 * not a navigation hazard, and whether/how it becomes clickable in the chat is
 * issue #22's decision, not this sanitizer's.
 */
function pruneMarks(marks: readonly ProseMirrorMark[] | undefined): ProseMirrorMark[] | undefined {
  if (marks === undefined) return undefined;
  const pruned: ProseMirrorMark[] = [];
  for (const mark of marks) {
    if (!ALLOWED_MARK_TYPES.has(mark.type)) continue;
    if (mark.type === 'link') {
      const href = typeof mark.attrs?.href === 'string' ? mark.attrs.href : '';
      const safeHref = href.startsWith(WIKI_LINK_SCHEME) ? href : sanitizeLinkHref(href);
      if (safeHref === null) continue;
      pruned.push({ ...mark, attrs: { ...mark.attrs, href: safeHref } });
      continue;
    }
    pruned.push(mark);
  }
  return pruned.length > 0 ? pruned : undefined;
}

function pruneChildren(nodes: readonly ProseMirrorNode[] | undefined): ProseMirrorNode[] {
  if (nodes === undefined) return [];
  const pruned: ProseMirrorNode[] = [];
  for (const node of nodes) {
    const result = pruneNode(node);
    if (result !== null) pruned.push(result);
  }
  return pruned;
}

function pruneNode(node: ProseMirrorNode): ProseMirrorNode | null {
  if (node.type === 'text') {
    if (node.text === undefined || node.text.length === 0) return null;
    const marks = pruneMarks(node.marks);
    return marks === undefined
      ? { type: 'text', text: node.text }
      : { type: 'text', text: node.text, marks };
  }

  const fallbackType = TYPE_FALLBACKS[node.type];
  const resolvedType = fallbackType ?? node.type;
  if (ALLOWED_LEAF_TYPES.has(resolvedType)) return { type: resolvedType };
  if (!ALLOWED_BLOCK_TYPES.has(resolvedType)) return null;

  const content = pruneChildren(node.content);
  const result: ProseMirrorNode = { type: resolvedType };
  // Attributes from a node that fell back to a different type (a callout's
  // `variant`/`title`, a task item's `checked`) do not apply to the type it
  // fell back to, so they are dropped along with the type change.
  if (fallbackType === undefined && node.attrs !== undefined) result.attrs = node.attrs;
  if (content.length > 0) result.content = content;
  return result;
}

/**
 * Prunes a parsed document down to the node and mark types the AI chat bubble
 * actually renders (issue #21) and sanitizes every remaining link `href`.
 *
 * The chat uses the same Markdown parser as the editor
 * (`packages/editor/src/markdown/parse.ts`) on purpose -- one dialect, so a
 * reply looks the same whether it ends up in the chat or pasted onto a page --
 * but a chat bubble has no chrome for the page's full node vocabulary. This is
 * the boundary between "what the parser understands" and "what the chat is
 * willing to put on screen".
 */
export function pruneForChat(document: ProseMirrorDocument): ProseMirrorDocument {
  return { type: 'doc', content: pruneChildren(document.content) };
}
