import { type Node as PmNode } from '@tiptap/pm/model';

import { BLOCK_ID_ATTRIBUTE } from './block-id';
import { HEADING_COLLAPSED_ATTRIBUTE } from './collapsible-heading';

/** One heading of the page, as the floating outline shows it (issue #194). */
export interface PageOutlineEntry {
  level: number;
  /** The heading's text, trimmed; empty when the heading has none yet. */
  text: string;
  /** Stable block id, the anchor. `null` only for a heading not yet given one. */
  blockId: string | null;
  /** The heading itself is collapsed, so its section is hidden below it. */
  collapsed: boolean;
  /**
   * Block id of the collapsed heading whose section hides this one, or `null`
   * when the heading is on screen. A jump to a hidden heading lands on that
   * heading instead: navigating never expands a section, because the collapsed
   * state is part of the document and a click on the outline is not an edit.
   */
  hiddenUnder: string | null;
}

/**
 * Reads the outline of a page together with what the collapsed headings hide.
 *
 * The hiding follows `collapsedDecorations` exactly: a collapsed heading at the
 * top level or inside a column hides the blocks after it up to the next heading
 * of the same or a higher level, and a heading inside such a section neither
 * shows nor collapses anything itself. Headings in other containers (a toggle,
 * a callout) are listed too, and inherit the hiding of the block they sit in.
 *
 * `readOutline` in `table-of-contents.ts` stays the reader for the block,
 * which needs neither the collapse state nor the hiding.
 */
export function readPageOutline(doc: PmNode): PageOutlineEntry[] {
  const entries: PageOutlineEntry[] = [];

  const walk = (parent: PmNode, inheritedHidden: string | null): void => {
    // Only the document and a column govern collapsing, as in the decorations.
    const governs = parent.type.name === 'doc' || parent.type.name === 'column';
    const collapsed: { level: number; id: string }[] = [];

    parent.forEach((child) => {
      if (child.type.name === 'heading') {
        const level = typeof child.attrs.level === 'number' ? child.attrs.level : 1;
        while (collapsed.length > 0 && (collapsed.at(-1) as { level: number }).level >= level) {
          collapsed.pop();
        }
        const rawId: unknown = child.attrs[BLOCK_ID_ATTRIBUTE];
        const blockId = typeof rawId === 'string' && rawId.length > 0 ? rawId : null;
        const hiddenUnder = inheritedHidden ?? collapsed.at(-1)?.id ?? null;
        const isCollapsed =
          governs && hiddenUnder === null && child.attrs[HEADING_COLLAPSED_ATTRIBUTE] === true;
        entries.push({
          level,
          text: child.textContent.trim(),
          blockId,
          collapsed: isCollapsed,
          hiddenUnder,
        });
        // A collapsed heading without an id hides its section all the same;
        // the jump then has nothing to land on and falls back to the DOM.
        if (isCollapsed) collapsed.push({ level, id: blockId ?? '' });
        return;
      }
      if (child.isTextblock || child.isAtom || child.isLeaf) return;
      walk(child, inheritedHidden ?? collapsed.at(-1)?.id ?? null);
    });
  };

  walk(doc, null);
  return entries;
}

/** Whether two outlines would render the same, so a re-render can be skipped. */
export function sameOutline(
  left: readonly PageOutlineEntry[],
  right: readonly PageOutlineEntry[],
): boolean {
  if (left.length !== right.length) return false;
  return left.every((entry, index) => {
    const other = right[index] as PageOutlineEntry;
    return (
      entry.level === other.level &&
      entry.text === other.text &&
      entry.blockId === other.blockId &&
      entry.collapsed === other.collapsed &&
      entry.hiddenUnder === other.hiddenUnder
    );
  });
}
