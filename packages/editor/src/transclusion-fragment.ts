import { BLOCK_ID_ATTRIBUTE, isValidBlockId } from './block-id';
import { type ProseMirrorDocument, type ProseMirrorNode } from './contract';
import { serializePlainText } from './plain-text';
import { transclusionBlockId, transclusionDocumentId, transclusionLabel } from './transclusion';

/**
 * Resolving what a transclusion shows (issue #78, ADR-045).
 *
 * Pure functions over ProseMirror JSON, with no idea that an API exists: the
 * API reads a page's canonical state, asks these functions what the reference
 * points at, and answers with the result. Keeping the addressing here is what
 * lets the editor's round-trip tests prove it without a database.
 *
 * Everything in this file expands **one level**. A transclusion inside a
 * transcluded fragment is left standing as a reference rather than resolved,
 * which is not a limitation that had to be argued for: it is what makes a cycle
 * impossible instead of detectable. Two pages that embed each other both
 * render, each showing the other's text with the way back named but not
 * followed, and no reader, exporter or indexer can be sent around a loop.
 */

/** Characters of a block's text the outline shows so a writer can tell two apart. */
export const TRANSCLUSION_PREVIEW_CHARS = 120;

/** Blocks the outline offers. A page with more is picked from by searching. */
export const MAX_TRANSCLUSION_OUTLINE_BLOCKS = 300;

const HEADING_TYPE = 'heading';

/** One addressable block of a source page, as the block picker lists it. */
export interface TransclusionOutlineEntry {
  blockId: string;
  /** ProseMirror node type, so the picker can show what kind of block it is. */
  type: string;
  /** Heading level, for a heading; `null` for everything else. */
  level: number | null;
  /** First line or so of the block's text. May be empty (an image, a divider). */
  preview: string;
}

/** A reference this document makes to content owned elsewhere. */
export interface CollectedTransclusion {
  documentId: string | null;
  blockId: string | null;
  label: string;
}

function headingLevel(node: ProseMirrorNode): number | null {
  if (node.type !== HEADING_TYPE) return null;
  const level = node.attrs?.level;
  return typeof level === 'number' ? level : 1;
}

function previewOf(node: ProseMirrorNode): string {
  const text = serializePlainText({ type: 'doc', content: [node] })
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > TRANSCLUSION_PREVIEW_CHARS
    ? `${text.slice(0, TRANSCLUSION_PREVIEW_CHARS).trimEnd()}…`
    : text;
}

/**
 * The addressable blocks of a page, in reading order.
 *
 * Only blocks that already carry an identifier are listed: an identifier is
 * assigned by the editor on the next transaction, and offering a block that has
 * none would mean offering an address that does not exist yet.
 */
export function outlineBlocks(document: ProseMirrorDocument): TransclusionOutlineEntry[] {
  const entries: TransclusionOutlineEntry[] = [];

  const walk = (node: ProseMirrorNode): void => {
    if (entries.length >= MAX_TRANSCLUSION_OUTLINE_BLOCKS) return;
    const id: unknown = node.attrs?.[BLOCK_ID_ATTRIBUTE];
    if (isValidBlockId(id)) {
      entries.push({
        blockId: id,
        type: node.type,
        level: headingLevel(node),
        preview: previewOf(node),
      });
    }
    for (const child of node.content ?? []) walk(child);
  };

  for (const child of document.content ?? []) walk(child);
  return entries;
}

interface Located {
  /** The siblings the block sits among, which is where a section is cut from. */
  siblings: readonly ProseMirrorNode[];
  index: number;
}

function locate(document: ProseMirrorDocument, blockId: string): Located | null {
  const search = (siblings: readonly ProseMirrorNode[]): Located | null => {
    for (let index = 0; index < siblings.length; index += 1) {
      const node = siblings[index] as ProseMirrorNode;
      if (node.attrs?.[BLOCK_ID_ATTRIBUTE] === blockId) return { siblings, index };
      const inside = search(node.content ?? []);
      if (inside !== null) return inside;
    }
    return null;
  };
  return search(document.content ?? []);
}

/**
 * The content one block identifier addresses.
 *
 * A heading addresses its **section**: the heading itself plus everything under
 * it, up to the next heading of the same or a higher level among its siblings.
 * That is what makes the first example in issue #78 work -- a status section
 * kept on the project page and shown on the overview page is a heading and the
 * paragraphs beneath it, not a paragraph somebody has to remember to re-pick
 * whenever a second one is added.
 *
 * Every other block addresses itself, with its children, which for a list or a
 * table is the whole structure.
 *
 * `null` when no block carries this identifier: the source was edited and the
 * block is gone. That is reported as a dead reference rather than papered over
 * with the nearest surviving block.
 */
export function extractBlockFragment(
  document: ProseMirrorDocument,
  blockId: string,
): ProseMirrorDocument | null {
  const found = locate(document, blockId);
  if (found === null) return null;

  const node = found.siblings[found.index] as ProseMirrorNode;
  const level = headingLevel(node);
  if (level === null) return { type: 'doc', content: [node] };

  const section: ProseMirrorNode[] = [node];
  for (let index = found.index + 1; index < found.siblings.length; index += 1) {
    const next = found.siblings[index] as ProseMirrorNode;
    const nextLevel = headingLevel(next);
    if (nextLevel !== null && nextLevel <= level) break;
    section.push(next);
  }
  return { type: 'doc', content: section };
}

/** Every transclusion in a document, in reading order. */
export function collectTransclusions(document: ProseMirrorDocument): CollectedTransclusion[] {
  const found: CollectedTransclusion[] = [];

  const walk = (node: ProseMirrorNode): void => {
    if (node.type === 'transclusion') {
      found.push({
        documentId: transclusionDocumentId(node.attrs),
        blockId: transclusionBlockId(node.attrs),
        label: transclusionLabel(node.attrs),
      });
    }
    for (const child of node.content ?? []) walk(child);
  };

  for (const child of document.content ?? []) walk(child);
  return found;
}

/**
 * Key both sides of a materialization agree on: a page, or one block of it.
 *
 * `null` identities never get a key, because a reference that carries only a
 * title has not been bound to a document and there is nothing to look up.
 */
export function transclusionKey(documentId: string, blockId: string | null): string {
  return blockId === null ? documentId : `${documentId}#${blockId}`;
}

/**
 * Replaces every transclusion with the content it points at.
 *
 * This is the "materialized text" half of the export choice issue #78 asks for:
 * a file that has to stand on its own somewhere else carries the text, a file
 * that stays here carries the reference. `resolve` answers with the blocks to
 * put in place, or `null` for a reference it cannot resolve -- which is kept as
 * the reference block rather than dropped, because an export must not be the
 * place where a broken reference turns into missing content.
 *
 * One level, as everywhere in this file: whatever comes back from `resolve` is
 * inserted as it is, so a transclusion inside it stays a reference.
 */
export function materializeTransclusions(
  document: ProseMirrorDocument,
  resolve: (target: CollectedTransclusion) => ProseMirrorNode[] | null,
): ProseMirrorDocument {
  const replaceIn = (nodes: readonly ProseMirrorNode[]): ProseMirrorNode[] => {
    const result: ProseMirrorNode[] = [];
    for (const node of nodes) {
      if (node.type === 'transclusion') {
        const replacement = resolve({
          documentId: transclusionDocumentId(node.attrs),
          blockId: transclusionBlockId(node.attrs),
          label: transclusionLabel(node.attrs),
        });
        if (replacement === null) result.push(node);
        else result.push(...replacement);
        continue;
      }
      const children = node.content;
      result.push(children === undefined ? node : { ...node, content: replaceIn(children) });
    }
    return result;
  };

  return { ...document, content: replaceIn(document.content ?? []) };
}
