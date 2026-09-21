import { BLOCK_ID_ATTRIBUTE, isValidBlockId } from './block-id';
import { type BlockRangeEdit } from './block-range';
import { type ProseMirrorDocument, type ProseMirrorNode } from './contract';
import { serializeMarkdown } from './markdown/serialize';

/**
 * Working out *which* blocks an edit addresses, from something other than a
 * block identifier (issue #111).
 *
 * Pure functions over ProseMirror JSON with no idea that an API or a Yjs
 * document exists, in the shape `transclusion-fragment.ts` already uses: the
 * API reads the canonical state, asks here what a heading or a piece of text
 * points at, and hands the answer to `applyBlockRangeEditToYDoc`. Keeping the
 * addressing here is what lets it be proved without a database.
 *
 * Everything in this file fails rather than guesses. A heading that occurs
 * twice, a text that occurs twice, a text that occurs nowhere: each is answered
 * with what was found and no write, because the whole point of a narrow edit is
 * that the caller knows where it lands. `exo_project_patch_file` decided this
 * the same way, and it is the behaviour the issue asks for.
 */

const HEADING_TYPE = 'heading';

export type PageEditRefusal =
  | 'heading_not_found'
  | 'heading_not_unique'
  | 'patch_not_found'
  | 'patch_not_unique'
  /** The page's Markdown could not be mapped back onto its blocks. */
  | 'patch_not_addressable';

export type PageEditResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly reason: PageEditRefusal;
      /** How many candidates there were, for a message that says what to do next. */
      readonly count: number;
      /** Block identifiers of those candidates, so a caller can pick one. */
      readonly blockIds: readonly string[];
    };

function refuse<T>(
  reason: PageEditRefusal,
  count: number,
  blockIds: readonly string[] = [],
): PageEditResult<T> {
  return { ok: false, reason, count, blockIds };
}

function blockIdOf(node: ProseMirrorNode): string | null {
  const value: unknown = node.attrs?.[BLOCK_ID_ATTRIBUTE];
  return isValidBlockId(value) ? value : null;
}

function headingLevel(node: ProseMirrorNode): number | null {
  if (node.type !== HEADING_TYPE) return null;
  const level = node.attrs?.level;
  return typeof level === 'number' ? level : 1;
}

/** The text of a node, flattened the way a reader would say it out loud. */
function textOf(node: ProseMirrorNode): string {
  if (node.type === 'text') return node.text ?? '';
  return (node.content ?? []).map((child) => textOf(child)).join('');
}

// --- Sections -------------------------------------------------------------

/** A heading and the blocks beneath it, as `exo_page_section_write` addresses them. */
export interface HeadingSection {
  /** The heading itself. */
  blockId: string;
  level: number;
  /** First block of the body, `null` when the heading has nothing under it. */
  bodyFromBlockId: string | null;
  /** Last block of the body, `null` for the same reason. */
  bodyToBlockId: string | null;
}

/**
 * Every heading whose text matches, with its section.
 *
 * The comparison is on the trimmed text and ignores case, because a heading is
 * something a person types from memory and `## Stand` and `## stand` are the
 * same heading to everyone but a string comparison. Two matches are not
 * resolved by picking one -- see the note at the top of the file.
 */
export function findHeadingSections(
  document: ProseMirrorDocument,
  heading: string,
): HeadingSection[] {
  const wanted = heading.trim().toLowerCase();
  const found: HeadingSection[] = [];

  const walk = (siblings: readonly ProseMirrorNode[]): void => {
    for (let index = 0; index < siblings.length; index += 1) {
      const node = siblings[index] as ProseMirrorNode;
      const level = headingLevel(node);
      const id = blockIdOf(node);
      if (level !== null && id !== null && textOf(node).trim().toLowerCase() === wanted) {
        let end = index;
        for (let next = index + 1; next < siblings.length; next += 1) {
          const nextLevel = headingLevel(siblings[next] as ProseMirrorNode);
          if (nextLevel !== null && nextLevel <= level) break;
          end = next;
        }
        const body = siblings.slice(index + 1, end + 1);
        found.push({
          blockId: id,
          level,
          bodyFromBlockId: body.length === 0 ? null : blockIdOf(body[0] as ProseMirrorNode),
          bodyToBlockId:
            body.length === 0 ? null : blockIdOf(body[body.length - 1] as ProseMirrorNode),
        });
      }
      walk(node.content ?? []);
    }
  };

  walk(document.content ?? []);
  return found;
}

/**
 * The range a section write addresses.
 *
 * `replace` swaps the body and leaves the heading standing, which is the
 * difference between this and a page write: a section is named by its heading,
 * so removing the heading would remove the address. `prepend` lands directly
 * under the heading, `append` at the end of the section -- and both fall back
 * to "right after the heading" when the section is still empty, which is the
 * only place either of them could mean.
 */
export function resolveSectionEdit(
  document: ProseMirrorDocument,
  heading: string,
  mode: 'replace' | 'append' | 'prepend',
): PageEditResult<BlockRangeEdit> {
  const sections = findHeadingSections(document, heading);
  if (sections.length === 0) return refuse('heading_not_found', 0);
  if (sections.length > 1) {
    return refuse(
      'heading_not_unique',
      sections.length,
      sections.map((section) => section.blockId),
    );
  }

  const section = sections[0] as HeadingSection;
  const empty = section.bodyFromBlockId === null;

  if (mode === 'prepend' || (empty && mode === 'append')) {
    return {
      ok: true,
      value: { fromBlockId: section.blockId, toBlockId: null, placement: 'after' },
    };
  }
  if (empty) {
    // `replace` on an empty section: there is nothing to swap out, so the new
    // content simply becomes the section.
    return {
      ok: true,
      value: { fromBlockId: section.blockId, toBlockId: null, placement: 'after' },
    };
  }
  if (mode === 'append') {
    return {
      ok: true,
      value: { fromBlockId: section.bodyToBlockId as string, toBlockId: null, placement: 'after' },
    };
  }
  return {
    ok: true,
    value: {
      fromBlockId: section.bodyFromBlockId as string,
      toBlockId: section.bodyToBlockId as string,
      placement: 'replace',
    },
  };
}

// --- Text patches ---------------------------------------------------------

interface BlockSpan {
  blockId: string;
  /** Offset of this block's Markdown in the page's Markdown. */
  start: number;
  end: number;
}

/**
 * Where each top-level block's Markdown sits in the page's Markdown.
 *
 * Found by serializing a block on its own and looking it up in the page's own
 * text, rather than by adding lengths: the serializer collapses blank lines
 * across the whole body, so an offset computed from the parts would drift from
 * the text the caller actually read. A block whose Markdown reads differently
 * in context -- nothing does today, and a new block serializer could -- is not
 * papered over: the lookup fails, and a patch that cannot be placed exactly is
 * refused rather than placed approximately.
 */
export function pageBlockSpans(
  document: ProseMirrorDocument,
  markdown: string,
): BlockSpan[] | null {
  const spans: BlockSpan[] = [];
  let cursor = 0;

  for (const node of document.content ?? []) {
    const blockId = blockIdOf(node);
    if (blockId === null) return null;
    const own = serializeMarkdown({ type: 'doc', content: [node] }).replace(/\s+$/, '');
    if (own.length === 0) {
      spans.push({ blockId, start: cursor, end: cursor });
      continue;
    }
    const at = markdown.indexOf(own, cursor);
    if (at < 0) return null;
    spans.push({ blockId, start: at, end: at + own.length });
    cursor = at + own.length;
  }

  return spans;
}

/** One replacement, expressed as a range of blocks and the Markdown to put there. */
export interface PatchEdit {
  edit: BlockRangeEdit;
  markdown: string;
  /** How many occurrences of `oldText` this one edit carries. */
  replacements: number;
}

/**
 * Turns "replace this text with that text" into edits that address blocks.
 *
 * The text is matched against the page's Markdown -- the same string
 * `exo_page_read` answers with, so a caller can copy a line out of what it read
 * and send it straight back. The blocks that line sits in are then the range,
 * and everything else on the page is untouched.
 *
 * Matches whose block ranges overlap are carried out together in one edit.
 * Applying them separately would mean the second edit addressing blocks the
 * first one has already replaced.
 */
export function resolvePatchEdits(
  document: ProseMirrorDocument,
  input: { oldText: string; newText: string; replaceAll: boolean },
): PageEditResult<PatchEdit[]> {
  const markdown = serializeMarkdown(document).replace(/\s+$/, '');

  const positions: number[] = [];
  for (let at = markdown.indexOf(input.oldText); at >= 0;) {
    positions.push(at);
    at = markdown.indexOf(input.oldText, at + Math.max(1, input.oldText.length));
  }
  if (positions.length === 0) return refuse('patch_not_found', 0);
  if (positions.length > 1 && !input.replaceAll)
    return refuse('patch_not_unique', positions.length);

  const spans = pageBlockSpans(document, markdown);
  if (spans === null) return refuse('patch_not_addressable', 0);

  /** The blocks one match falls into, as indexes into `spans`. */
  const coverage = positions.map((start) => {
    const end = start + input.oldText.length;
    let first = 0;
    for (let index = 0; index < spans.length; index += 1) {
      if ((spans[index] as BlockSpan).start <= start) first = index;
    }
    let last = first;
    while (last < spans.length - 1 && (spans[last] as BlockSpan).end < end) last += 1;
    return { start, first, last };
  });

  // Overlapping coverages become one edit, so no edit addresses a block another
  // one has already replaced.
  const groups: { first: number; last: number; matches: number[] }[] = [];
  for (const match of coverage) {
    const open = groups[groups.length - 1];
    if (open !== undefined && match.first <= open.last) {
      open.last = Math.max(open.last, match.last);
      open.matches.push(match.start);
      continue;
    }
    groups.push({ first: match.first, last: match.last, matches: [match.start] });
  }

  const edits = groups.map((group) => {
    const from = spans[group.first] as BlockSpan;
    const to = spans[group.last] as BlockSpan;
    let region = markdown.slice(from.start, to.end);
    // Descending, so an earlier replacement cannot move a later offset.
    for (const start of [...group.matches].reverse()) {
      const local = start - from.start;
      region = region.slice(0, local) + input.newText + region.slice(local + input.oldText.length);
    }
    return {
      edit: {
        fromBlockId: from.blockId,
        toBlockId: group.first === group.last ? null : to.blockId,
        placement: 'replace' as const,
      },
      markdown: region,
      replacements: group.matches.length,
    };
  });

  return { ok: true, value: edits };
}
