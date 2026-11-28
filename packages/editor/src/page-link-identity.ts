/**
 * Identity handling for references to other pages.
 *
 * Four notations point at a page: the `pageLink` block, the `mention` node with
 * `kind: 'page'`, the `link` mark carrying a `wiki:` address (which is what
 * `[[Titel]]` in running text becomes), and the `transclusion` block, which
 * shows the page instead of naming it (issue #78, ADR-045). All four store an
 * identity (`documentId` / `id`) next to the title they display, and all four
 * write only the title to Markdown. The `databaseEmbed` block does the same for
 * a database (issue #226), but only the export and import below know it: it
 * is not a link, so it stays out of `collectPageReferences` and the
 * resolution rule. That split needs exactly three pure operations,
 * and they all live here so the export path, the import path and the editor UI
 * cannot drift apart:
 *
 *  * **export** — `resolvePageLinkTitles` refreshes every stored title from the
 *    identity, so a file written today says what the target is called today;
 *  * **import** — `bindPageLinkIdentities` maps a title back onto a document,
 *    so `[[Titel]]` becomes a real reference instead of a string;
 *  * **display** — `resolvePageLinkTarget` decides what a reference resolves
 *    to, including the case where it resolves to nothing.
 *
 * Everything here is pure: the caller supplies the lookup, because only the
 * application (API, worker) may talk to the database.
 */

import { type ProseMirrorDocument, type ProseMirrorMark, type ProseMirrorNode } from './contract';
import { mapDocumentNodes } from './document-nodes';
import {
  normalizeWikiTitle,
  WIKI_LINK_IDENTITY_ATTRIBUTE,
  wikiLinkDocumentId,
  wikiLinkTitle,
} from './link-target';
import { WIKI_LINK_SCHEME } from './markdown/serialize';
import { pageLinkDocumentId, pageLinkTitle } from './page-link';
import { transclusionDocumentId, transclusionLabel } from './transclusion';

/** One reference to another page, regardless of which notation produced it. */
export interface PageReference {
  kind: 'pageLink' | 'mention' | 'wikiMark' | 'transclusion';
  /** Stored identity, or `null` when the reference only carries a title. */
  documentId: string | null;
  /** Stored display title, whitespace-normalized. */
  title: string;
}

function stringAttribute(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** The database a `databaseEmbed` shows, or `null` while none is picked. */
function databaseEmbedDocumentId(attrs: Record<string, unknown> | undefined): string | null {
  const value = attrs?.documentId;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** `true` for a `mention` node that points at a page rather than a person or a date. */
function isPageMention(node: ProseMirrorNode): boolean {
  if (node.type !== 'mention') return false;
  const kind = stringAttribute(node.attrs?.kind).toLowerCase();
  // `page` is the schema default, so an absent attribute means a page.
  return kind === '' || kind === 'page';
}

/** The identity a `mention` carries, or `null`. */
function mentionId(attrs: Record<string, unknown> | undefined): string | null {
  const value = attrs?.id;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Rewrites the `wiki:` link marks of one node, leaving everything else — other
 * marks, the node itself — untouched and referentially identical.
 *
 * Both directions below need the same walk over a text node's marks; doing it
 * once here is what keeps them from disagreeing about which marks count as a
 * reference (`wikiLinkTitle` answers that, in one place).
 */
function mapWikiMarks(
  node: ProseMirrorNode,
  map: (mark: ProseMirrorMark, title: string) => ProseMirrorMark,
): ProseMirrorNode {
  const marks = node.marks;
  if (marks === undefined) return node;

  let changed = false;
  const next = marks.map((mark) => {
    const title = wikiLinkTitle(mark);
    if (title === null) return mark;
    const mapped = map(mark, title);
    if (mapped !== mark) changed = true;
    return mapped;
  });

  return changed ? { ...node, marks: next } : node;
}

/** The `wiki:` title the first reference mark on a node addresses, if any. */
function wikiTitleOf(node: ProseMirrorNode): string | null {
  for (const mark of node.marks ?? []) {
    const title = wikiLinkTitle(mark);
    if (title !== null) return title;
  }
  return null;
}

/**
 * Every reference to another page in reading order, deduplicated by identity
 * and title.
 *
 * What the import and export paths need in order to run one lookup instead of
 * one per node.
 */
export function collectPageReferences(document: ProseMirrorDocument): PageReference[] {
  const references: PageReference[] = [];
  const seen = new Set<string>();

  const add = (kind: PageReference['kind'], documentId: string | null, rawTitle: string): void => {
    const title = normalizeWikiTitle(rawTitle);
    if (title.length === 0 && documentId === null) return;
    const key = `${kind}\u0000${documentId ?? ''}\u0000${title.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    references.push({ kind, documentId, title });
  };

  const walk = (node: ProseMirrorNode): void => {
    if (node.type === 'pageLink') {
      add('pageLink', pageLinkDocumentId(node.attrs), pageLinkTitle(node.attrs));
    } else if (isPageMention(node)) {
      add('mention', mentionId(node.attrs), stringAttribute(node.attrs?.label));
    } else if (node.type === 'transclusion') {
      add('transclusion', transclusionDocumentId(node.attrs), transclusionLabel(node.attrs));
    }
    for (const mark of node.marks ?? []) {
      const title = wikiLinkTitle(mark);
      if (title !== null) add('wikiMark', wikiLinkDocumentId(mark.attrs), title);
    }
    for (const child of node.content ?? []) walk(child);
  };

  walk(document);
  return references;
}

/** Resolves an identity to the title that document carries *now*. */
export type PageTitleLookup = (documentId: string) => string | null | undefined;

/**
 * Rewrites the title attribute of one block or node from its identity, or
 * hands it back untouched when there is no identity, the lookup does not know
 * it, or the title is already the current one.
 */
function refreshStoredTitle(
  node: ProseMirrorNode,
  lookup: PageTitleLookup,
  reference: { documentId: string | null; stored: string; attribute: string },
): ProseMirrorNode {
  if (reference.documentId === null) return node;
  const title = lookup(reference.documentId);
  if (typeof title !== 'string' || title.length === 0 || title === reference.stored) return node;
  return { ...node, attrs: { ...node.attrs, [reference.attribute]: title } };
}

/**
 * Rewrites every stored title from the identity, for the Markdown export.
 *
 * This is what keeps `[[Titel]]` honest after a rename: the file is written
 * from what the target is called at export time, not from the label that was
 * frozen into the document when the link was made. A reference whose identity
 * the lookup does not know keeps its stored title — an export must never lose
 * a reference just because its target is gone.
 */
export function resolvePageLinkTitles(
  document: ProseMirrorDocument,
  lookup: PageTitleLookup,
): ProseMirrorDocument {
  return mapDocumentNodes(document, (node) => {
    if (node.type === 'pageLink') {
      return refreshStoredTitle(node, lookup, {
        documentId: pageLinkDocumentId(node.attrs),
        stored: pageLinkTitle(node.attrs),
        attribute: 'title',
      });
    }

    if (isPageMention(node)) {
      return refreshStoredTitle(node, lookup, {
        documentId: mentionId(node.attrs),
        stored: stringAttribute(node.attrs?.label),
        attribute: 'label',
      });
    }

    // A transclusion writes `:::transclusion Titel^block`, so the same rename
    // would otherwise send an export out naming a page that no longer answers
    // to that title -- and an import of that file would bind it to nothing.
    if (node.type === 'transclusion') {
      return refreshStoredTitle(node, lookup, {
        documentId: transclusionDocumentId(node.attrs),
        stored: transclusionLabel(node.attrs),
        attribute: 'label',
      });
    }

    // A database embed writes `:::database-embed Titel` (issue #226), so a
    // rename has to reach its export for the same reason.
    if (node.type === 'databaseEmbed') {
      return refreshStoredTitle(node, lookup, {
        documentId: databaseEmbedDocumentId(node.attrs),
        stored: stringAttribute(node.attrs?.title),
        attribute: 'title',
      });
    }

    // `[[Titel]]` in running text.
    const stored = wikiTitleOf(node);
    const rewritten = mapWikiMarks(node, (mark, storedTitle) => {
      const documentId = wikiLinkDocumentId(mark.attrs);
      if (documentId === null) return mark;
      const title = lookup(documentId);
      if (typeof title !== 'string' || title.length === 0 || title === storedTitle) return mark;
      return { ...mark, attrs: { ...mark.attrs, href: `${WIKI_LINK_SCHEME}${title}` } };
    });
    if (rewritten === node) return node;

    // The visible text follows the address only when it still *was* the
    // address. `[[Ziel|siehe dort]]` is a wording the author chose, and a
    // rename of the target is no reason to overwrite it — the reference stays
    // correct either way, because it is the address that carries it.
    const refreshed = wikiTitleOf(rewritten);
    return node.text === stored && refreshed !== null
      ? { ...rewritten, text: refreshed }
      : rewritten;
  });
}

/** Resolves a title to the identity of the page that carries it, if any. */
export type PageIdentityLookup = (title: string) => string | null | undefined;

/**
 * Binds titles to identities, for the Markdown import.
 *
 * The counterpart of `resolvePageLinkTitles`: a file says `[[Titel]]`, and the
 * importer turns that into a reference that survives the target being renamed
 * afterwards. References that already carry an identity are left alone, and a
 * title no page carries stays identity-less rather than being dropped — an
 * unresolved reference is a feature (it offers to create the page), not an
 * error.
 *
 * `databaseLookup` answers for `:::database-embed Titel` (issue #226). It is a
 * lookup of its own because an embed may only show a database: the newest
 * page carrying the same title is the right target for a link and the wrong
 * one for an embed. Without it an embed stays unbound, and the block offers
 * its picker the next time somebody opens the page.
 */
export function bindPageLinkIdentities(
  document: ProseMirrorDocument,
  lookup: PageIdentityLookup,
  databaseLookup?: PageIdentityLookup,
): ProseMirrorDocument {
  return mapDocumentNodes(document, (node) => {
    if (node.type === 'databaseEmbed') {
      if (databaseLookup === undefined || databaseEmbedDocumentId(node.attrs) !== null) return node;
      const documentId = databaseLookup(stringAttribute(node.attrs?.title));
      if (typeof documentId !== 'string' || documentId.length === 0) return node;
      return { ...node, attrs: { ...node.attrs, documentId } };
    }

    if (node.type === 'pageLink') {
      if (pageLinkDocumentId(node.attrs) !== null) return node;
      const documentId = lookup(pageLinkTitle(node.attrs));
      if (typeof documentId !== 'string' || documentId.length === 0) return node;
      return { ...node, attrs: { ...node.attrs, documentId } };
    }

    if (isPageMention(node)) {
      if (mentionId(node.attrs) !== null) return node;
      const id = lookup(stringAttribute(node.attrs?.label));
      if (typeof id !== 'string' || id.length === 0) return node;
      return { ...node, attrs: { ...node.attrs, id } };
    }

    // Without this, `:::transclusion Titel^block` written through the API or by
    // an agent would arrive as a reference to nothing: the block would render
    // its own empty state on a page that names its source perfectly well.
    if (node.type === 'transclusion') {
      if (transclusionDocumentId(node.attrs) !== null) return node;
      const documentId = lookup(transclusionLabel(node.attrs));
      if (typeof documentId !== 'string' || documentId.length === 0) return node;
      return { ...node, attrs: { ...node.attrs, documentId } };
    }

    return mapWikiMarks(node, (mark, title) => {
      if (wikiLinkDocumentId(mark.attrs) !== null) return mark;
      const documentId = lookup(title);
      if (typeof documentId !== 'string' || documentId.length === 0) return mark;
      return { ...mark, attrs: { ...mark.attrs, [WIKI_LINK_IDENTITY_ATTRIBUTE]: documentId } };
    });
  });
}

// --------------------------------------------------------------------------
// The resolution rule
// --------------------------------------------------------------------------

/** A page a reference could mean. */
export interface PageCandidate {
  id: string;
  title: string;
}

/** What the application found for one reference. */
export interface PageLinkLookupResult {
  /** The document the stored identity names, or `null` when it is gone. */
  byId: PageCandidate | null;
  /** Documents that currently carry the stored title, best match first. */
  byTitle: readonly PageCandidate[];
}

export type PageLinkResolution =
  | {
      state: 'resolved';
      /** Which of the two stored values actually decided the target. */
      via: 'id' | 'title';
      target: PageCandidate;
      /** More than one page carries the title, so the choice was a guess. */
      ambiguous: boolean;
    }
  | {
      state: 'unresolved';
      /**
       * `empty`: the reference names nothing at all.
       * `deleted`: it carries an identity, and that document is gone.
       * `missing`: it names a title no page carries.
       */
      reason: 'empty' | 'deleted' | 'missing';
      title: string;
    };

/**
 * Decides what a reference points at.
 *
 * Identity wins: that is the whole point of storing it, and it is what makes a
 * rename harmless. When the identity is gone the title is tried anyway — a
 * page that was deleted and written again under the same title is still
 * plainly what the reference meant, and a reference must not silently vanish.
 * Only when neither yields anything is the reference reported as unresolved,
 * which the UI shows as such and offers to fix by creating the page.
 */
export function resolvePageLinkTarget(
  reference: { documentId: string | null; title: string },
  lookup: PageLinkLookupResult,
): PageLinkResolution {
  const title = normalizeWikiTitle(reference.title);

  if (reference.documentId !== null && lookup.byId !== null) {
    return { state: 'resolved', via: 'id', target: lookup.byId, ambiguous: false };
  }

  const first = lookup.byTitle[0];
  if (first !== undefined && title.length > 0) {
    return {
      state: 'resolved',
      via: 'title',
      target: first,
      ambiguous: lookup.byTitle.length > 1,
    };
  }

  if (title.length === 0 && reference.documentId === null) {
    return { state: 'unresolved', reason: 'empty', title };
  }
  return {
    state: 'unresolved',
    reason: reference.documentId === null ? 'missing' : 'deleted',
    title,
  };
}
