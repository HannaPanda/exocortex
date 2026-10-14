import { BLOCK_ID_ATTRIBUTE, isValidBlockId } from './block-id';
import { type ProseMirrorDocument, type ProseMirrorNode } from './contract';
import { normalizeWikiTitle, wikiLinkTitle } from './link-target';

/**
 * Obsidian's section link, `[[#Überschrift]]`, and what it would have meant here
 * (issue #197).
 *
 * eXocortex addresses a place inside a page by its block id, `[Text](#blockId)`,
 * because a heading's text changes and its id does not (ADR-003). A model that
 * knows Obsidian writes `[[#Überschrift]]` anyway, and the Markdown boundary
 * reads that as what every `[[…]]` is: a reference to a page, here one titled
 * "#Überschrift", which does not exist. The link is then unresolved, and nothing
 * said why.
 *
 * The write stands, for the reason a foreign image does (issue #117): it is not
 * this boundary's place to rewrite what somebody wrote. What this module adds is
 * the knowledge to say it precisely: which of those links name a heading the
 * page really has, and the block id the working link would carry.
 */
export interface SectionWikiLink {
  /** The heading text as written after the `#`, whitespace-normalized. */
  heading: string;
  /**
   * Block id of the one heading on the page with that text, compared without
   * regard to case. `null` when no heading matches, or when more than one does
   * and picking one would be a guess.
   */
  blockId: string | null;
}

/** The heading a `wiki:` title names, or `null` when it is not a section link. */
export function sectionLinkHeading(title: string): string | null {
  if (!title.startsWith('#')) return null;
  const heading = normalizeWikiTitle(title.slice(1));
  return heading.length > 0 ? heading : null;
}

function walk(node: ProseMirrorNode, visit: (node: ProseMirrorNode) => void): void {
  visit(node);
  for (const child of node.content ?? []) walk(child, visit);
}

function textOf(node: ProseMirrorNode): string {
  if (typeof node.text === 'string') return node.text;
  return (node.content ?? []).map(textOf).join('');
}

/**
 * Every `[[#…]]` in `content`, each matched against the headings of `page`.
 *
 * Two documents, because a narrow write parses a fragment while the heading it
 * means usually sits elsewhere on the page; for a whole-page write both are the
 * same document. Each heading is named once, however often it was linked.
 */
export function findSectionWikiLinks(
  content: ProseMirrorDocument,
  page: ProseMirrorDocument = content,
): SectionWikiLink[] {
  const headings = new Map<string, string[]>();
  walk(page, (node) => {
    if (node.type !== 'heading') return;
    const blockId = node.attrs?.[BLOCK_ID_ATTRIBUTE];
    if (!isValidBlockId(blockId)) return;
    const key = normalizeWikiTitle(textOf(node)).toLowerCase();
    if (key.length === 0) return;
    headings.set(key, [...(headings.get(key) ?? []), blockId]);
  });

  const found = new Map<string, SectionWikiLink>();
  walk(content, (node) => {
    for (const mark of node.marks ?? []) {
      const title = wikiLinkTitle(mark);
      const heading = title === null ? null : sectionLinkHeading(title);
      if (heading === null) continue;
      const key = heading.toLowerCase();
      if (found.has(key)) continue;
      const candidates = headings.get(key) ?? [];
      found.set(key, {
        heading,
        blockId: candidates.length === 1 ? (candidates[0] ?? null) : null,
      });
    }
  });
  return [...found.values()];
}
