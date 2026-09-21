import { BLOCK_ID_ATTRIBUTE, isValidBlockId } from './block-id';
import { type BlockRangeEdit } from './block-range';
import { type ProseMirrorDocument, type ProseMirrorNode } from './contract';
import { serializeMarkdown } from './markdown';
import { serializePlainText } from './plain-text';

/**
 * Taking a section out of a page (issue #118).
 *
 * Splitting has to be cheaper than appending, or appending wins every time:
 * today a section becomes its own page through six tool calls that carry the
 * whole page through an agent's context twice, and the cheap thing is to add
 * one more paragraph to a page that is already too long.
 *
 * What is needed for that is one answer to "which blocks does this address, and
 * what do they contain": the *same* address the map hands out
 * (`document-map.ts`), resolved into the content to move and the range to write
 * over. Both sides of the move therefore describe the same blocks, which is
 * what ADR-055 asks for and what keeps the write narrow.
 *
 * Pure functions over ProseMirror JSON again, so the whole operation can be
 * proved without a database.
 */

/** Characters of the section's text a title is derived from when it has no heading. */
const DERIVED_TITLE_CHARS = 80;

export type SectionExtractionRefusal =
  /** No block on the page carries that identifier. */
  | 'block_not_found'
  /** Both exist, but not beside each other, so they describe no span. */
  | 'block_range_not_siblings'
  /** The end of the span sits before its start. */
  | 'block_range_inverted'
  /** The last block of the span has no identifier, so the span cannot be written over. */
  | 'block_range_unaddressable';

export interface ExtractableSection {
  /** The blocks the address covers, the heading among them. */
  content: ProseMirrorDocument;
  /**
   * The same blocks without the heading that names them. `null` when the span
   * has no heading of its own, and when the heading has nothing under it.
   */
  body: ProseMirrorDocument | null;
  /** The heading the span opens with, when it has one. */
  heading: { blockId: string; level: number; text: string } | null;
  /** The whole span, as a write addresses it. */
  range: BlockRangeEdit;
  /** The body alone, for a write that leaves the heading standing. */
  bodyRange: BlockRangeEdit | null;
  /** Top-level blocks the span covers. */
  blocks: number;
  /** Characters of Markdown it holds. */
  chars: number;
  /** `true` when the span is everything this page holds at its top level. */
  wholePage: boolean;
}

export type SectionExtractionResult =
  | { readonly ok: true; readonly value: ExtractableSection }
  | { readonly ok: false; readonly reason: SectionExtractionRefusal; readonly blockId: string };

function blockIdOf(node: ProseMirrorNode): string | null {
  const value: unknown = node.attrs?.[BLOCK_ID_ATTRIBUTE];
  return isValidBlockId(value) ? value : null;
}

function headingLevel(node: ProseMirrorNode): number | null {
  if (node.type !== 'heading') return null;
  const level = node.attrs?.level;
  return typeof level === 'number' ? level : 1;
}

function textOf(nodes: readonly ProseMirrorNode[]): string {
  return serializePlainText({ type: 'doc', content: [...nodes] })
    .replace(/\s+/g, ' ')
    .trim();
}

/** The sibling list holding a block, wherever it sits. */
function siblingsOf(
  siblings: readonly ProseMirrorNode[],
  blockId: string,
): readonly ProseMirrorNode[] | null {
  if (siblings.some((node) => blockIdOf(node) === blockId)) return siblings;
  for (const node of siblings) {
    const inside = siblingsOf(node.content ?? [], blockId);
    if (inside !== null) return inside;
  }
  return null;
}

/** Where a heading's section ends: the last block before the next heading of its level. */
function sectionEnd(siblings: readonly ProseMirrorNode[], start: number, level: number): number {
  for (let index = start + 1; index < siblings.length; index += 1) {
    const next = headingLevel(siblings[index] as ProseMirrorNode);
    if (next !== null && next <= level) return index - 1;
  }
  return siblings.length - 1;
}

function refuse(reason: SectionExtractionRefusal, blockId: string): SectionExtractionResult {
  return { ok: false, reason, blockId };
}

/** The range covering `nodes`, or `null` when its end carries no identifier. */
function rangeOver(nodes: readonly ProseMirrorNode[], fromBlockId: string): BlockRangeEdit | null {
  if (nodes.length === 0) return null;
  const last = blockIdOf(nodes[nodes.length - 1] as ProseMirrorNode);
  if (nodes.length > 1 && last === null) return null;
  return {
    fromBlockId,
    toBlockId: nodes.length === 1 ? null : last,
    placement: 'replace',
  };
}

/**
 * What an address covers, and what it would take to move it away.
 *
 * `toBlockId` of `null` on a heading means its whole section, the way a heading
 * addresses one everywhere else (ADR-045); on anything else it means that one
 * block. Two identifiers mean the span between them, inclusive, and they have
 * to be siblings for the same reason `resolveBlockRange` insists on it.
 */
export function resolveSectionExtraction(
  document: ProseMirrorDocument,
  fromBlockId: string,
  toBlockId: string | null,
): SectionExtractionResult {
  const siblings = siblingsOf(document.content ?? [], fromBlockId);
  if (siblings === null) return refuse('block_not_found', fromBlockId);

  const start = siblings.findIndex((node) => blockIdOf(node) === fromBlockId);
  const head = siblings[start] as ProseMirrorNode;
  const level = headingLevel(head);

  let end: number;
  if (toBlockId === null) {
    end = level === null ? start : sectionEnd(siblings, start, level);
  } else {
    end = siblings.findIndex((node) => blockIdOf(node) === toBlockId);
    if (end === -1) {
      const elsewhere = siblingsOf(document.content ?? [], toBlockId);
      return refuse(elsewhere === null ? 'block_not_found' : 'block_range_not_siblings', toBlockId);
    }
    if (end < start) return refuse('block_range_inverted', toBlockId);
  }

  const nodes = siblings.slice(start, end + 1);
  const range = rangeOver(nodes, fromBlockId);
  if (range === null) return refuse('block_range_unaddressable', fromBlockId);

  const headingId = blockIdOf(head);
  const heading =
    level === null || headingId === null
      ? null
      : { blockId: headingId, level, text: textOf([head]) };
  const bodyNodes = heading === null ? [] : nodes.slice(1);
  const bodyFrom = bodyNodes.length === 0 ? null : blockIdOf(bodyNodes[0] as ProseMirrorNode);

  return {
    ok: true,
    value: {
      content: { type: 'doc', content: nodes },
      body: bodyNodes.length === 0 ? null : { type: 'doc', content: bodyNodes },
      heading,
      range,
      bodyRange: bodyFrom === null ? null : rangeOver(bodyNodes, bodyFrom),
      blocks: nodes.length,
      chars: serializeMarkdown({ type: 'doc', content: nodes }).length,
      wholePage: nodes.length === (document.content ?? []).length && siblings === document.content,
    },
  };
}

/**
 * The title the extracted page gets when the caller names none.
 *
 * The heading, because that is what the section is called and what every
 * reference to the new page will say. Without one, the first words of the text,
 * which is what a person would have typed anyway -- an untitled page is worse
 * than an approximate title, since a page is addressed by its title in
 * `[[Titel]]`.
 */
export function titleForSection(section: ExtractableSection): string {
  if (section.heading !== null && section.heading.text.length > 0) return section.heading.text;
  const text = textOf(section.content.content ?? []);
  if (text.length === 0) return 'Ausgelagerter Abschnitt';
  const cut = text.slice(0, DERIVED_TITLE_CHARS);
  return cut.length < text.length ? `${cut.trimEnd()}…` : cut;
}
