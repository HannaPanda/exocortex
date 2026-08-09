import { ADDRESSABLE_BLOCK_TYPES, BLOCK_ID_ATTRIBUTE, isValidBlockId } from './block-id';
import { type ProseMirrorDocument, type ProseMirrorNode } from './contract';
import { normalizeWikiTitle, parseLinkHref } from './link-target';
import { serializePlainText } from './plain-text';

/**
 * The three notations that address another page by title.
 *
 * `pageLink` is the block ("Link zu einer Seite"), `mention` the inline `@[[…]]`
 * chip and `wikiMark` a `link` mark carrying the `wiki:` scheme, which is what
 * `[[Titel]]` becomes in the canonical document. They are stored apart because
 * a reader wants to know whether a page was referenced as a section of its own
 * or merely named in passing.
 */
export const DOCUMENT_LINK_KINDS = ['pageLink', 'mention', 'wikiMark'] as const;
export type DocumentLinkKind = (typeof DOCUMENT_LINK_KINDS)[number];

export interface ExtractedDocumentLink {
  kind: DocumentLinkKind;
  /** Title as written, whitespace-normalized. */
  targetTitle: string;
  /** Comparison key: `targetTitle` lowercased. Resolution happens on this. */
  targetTitleKey: string;
  /**
   * Identity the reference itself carries, when it has one (`pageLink`'s
   * `documentId`, `mention`'s `id`). The index resolves against this first, so
   * renaming a page does not orphan the references to it. `null` for a
   * `wikiMark`, which is addressed by title by nature.
   */
  targetDocumentId: string | null;
  /** Identifier of the addressable block the reference sits in, when it has one. */
  blockId: string | null;
  /** Surrounding sentence, for the backlink preview. May be empty. */
  context: string;
  /** Order of first appearance, 0-based. Keeps the stored list in reading order. */
  position: number;
}

/**
 * Upper bound per document. A generated page could otherwise turn one
 * materialization into tens of thousands of rows; nobody reads that many
 * backlinks, and the index is a convenience, not an archive.
 */
export const MAX_DOCUMENT_LINKS = 500;

/** Length of the stored preview snippet. */
export const DOCUMENT_LINK_CONTEXT_CHARS = 240;

/**
 * Normalizes a title to the key both sides of the resolution compare on.
 *
 * The SQL counterpart is `lower(btrim(regexp_replace(title, '\s+', ' ', 'g')))`
 * (see the `resolve-document-links` maintenance task); the two must stay in
 * step, which is why this function exists instead of an inline `toLowerCase`.
 */
export function documentLinkTitleKey(title: string): string {
  return normalizeWikiTitle(title).toLowerCase();
}

const ADDRESSABLE = new Set<string>(ADDRESSABLE_BLOCK_TYPES);

function stringAttribute(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** A stored identity, normalized to `null` when it is absent or empty. */
function identityAttribute(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Cuts a window of `DOCUMENT_LINK_CONTEXT_CHARS` around the first occurrence of
 * `needle`, so the preview shows the sentence the reference sits in rather than
 * the beginning of a long paragraph.
 */
function windowAround(text: string, needle: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= DOCUMENT_LINK_CONTEXT_CHARS) return collapsed;

  const index =
    needle.length === 0 ? -1 : collapsed.toLowerCase().indexOf(needle.toLowerCase());
  if (index < 0) return `${collapsed.slice(0, DOCUMENT_LINK_CONTEXT_CHARS).trimEnd()}…`;

  const padding = Math.max(0, Math.floor((DOCUMENT_LINK_CONTEXT_CHARS - needle.length) / 2));
  const start = Math.max(0, Math.min(index - padding, collapsed.length - DOCUMENT_LINK_CONTEXT_CHARS));
  const end = Math.min(collapsed.length, start + DOCUMENT_LINK_CONTEXT_CHARS);
  const slice = collapsed.slice(start, end).trim();
  return `${start > 0 ? '…' : ''}${slice}${end < collapsed.length ? '…' : ''}`;
}

/**
 * Collects every reference to another page from a ProseMirror document.
 *
 * Pure and deterministic: the same JSON always yields the same list, which is
 * what lets materialization replace a document's references wholesale without
 * churning the table on every save. Derived data only — the canonical state
 * stays the Yjs update (ADR-007).
 *
 * References are deduplicated per `(kind, title, block)`: naming the same page
 * three times in one paragraph is one reference with one preview, naming it in
 * three paragraphs is three.
 */
export function extractDocumentLinks(document: ProseMirrorDocument): ExtractedDocumentLink[] {
  const links: ExtractedDocumentLink[] = [];
  const seen = new Set<string>();
  const contextCache = new Map<ProseMirrorNode, string>();

  const contextOf = (block: ProseMirrorNode | null, needle: string): string => {
    if (block === null) return '';
    let text = contextCache.get(block);
    if (text === undefined) {
      text = serializePlainText({ type: 'doc', content: [block] });
      contextCache.set(block, text);
    }
    return windowAround(text, needle);
  };

  const add = (
    kind: DocumentLinkKind,
    rawTitle: string,
    targetDocumentId: string | null,
    block: ProseMirrorNode | null,
    blockId: string | null,
  ): void => {
    if (links.length >= MAX_DOCUMENT_LINKS) return;
    const targetTitle = normalizeWikiTitle(rawTitle);
    if (targetTitle.length === 0) return;

    const targetTitleKey = documentLinkTitleKey(targetTitle);

    // Joined on U+0000, written as an escape rather than a literal byte: a
    // literal NUL makes this file binary to grep and friends.
    //
    // The identity is deliberately *not* part of the key. Two references to two
    // different pages that happen to share one title, inside one block, stay
    // one row: the index is a convenience projection and the unique constraint
    // behind it is on the same triple.
    const key =`${kind}\u0000${targetTitleKey}\u0000${blockId ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);

    links.push({
      kind,
      targetTitle,
      targetTitleKey,
      targetDocumentId,
      blockId,
      context: contextOf(block, targetTitle),
      position: links.length,
    });
  };

  const walk = (node: ProseMirrorNode, block: ProseMirrorNode | null, blockId: string | null): void => {
    // Two separate "deepest ancestor" rules on purpose. The preview follows the
    // deepest addressable block, because that is the sentence a reader wants to
    // see. The identifier follows the deepest block that actually carries one,
    // because a paragraph written by the Markdown importer has no id while its
    // list item may, and an anchor at the list item is still correct.
    const isBlock = ADDRESSABLE.has(node.type);
    const nextBlock = isBlock ? node : block;
    const ownId = isBlock ? node.attrs?.[BLOCK_ID_ATTRIBUTE] : undefined;
    const nextBlockId = isValidBlockId(ownId) ? ownId : blockId;

    if (node.type === 'pageLink') {
      add(
        'pageLink',
        stringAttribute(node.attrs?.title),
        identityAttribute(node.attrs?.documentId),
        nextBlock,
        nextBlockId,
      );
    } else if (node.type === 'mention') {
      const kind = stringAttribute(node.attrs?.kind).toLowerCase();
      // `page` is the schema default, so an absent attribute means a page.
      if (kind === '' || kind === 'page') {
        add(
          'mention',
          stringAttribute(node.attrs?.label),
          identityAttribute(node.attrs?.id),
          nextBlock,
          nextBlockId,
        );
      }
    } else if (node.type === 'text') {
      for (const mark of node.marks ?? []) {
        if (mark.type !== 'link') continue;
        const target = parseLinkHref(
          typeof mark.attrs?.href === 'string' ? mark.attrs.href : null,
        );
        // A `wiki:` href addresses by title by nature: no identity to carry.
        if (target.kind === 'wiki') add('wikiMark', target.title, null, nextBlock, nextBlockId);
      }
    }

    for (const child of node.content ?? []) walk(child, nextBlock, nextBlockId);
  };

  for (const child of document.content ?? []) walk(child, null, null);
  return links;
}
