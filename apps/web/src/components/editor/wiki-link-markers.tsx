'use client';

import { useQueries } from '@tanstack/react-query';
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { type Editor } from '@tiptap/react';
import { useTranslations } from 'next-intl';
import * as React from 'react';

import { type DocumentSummary, type DocumentTreeNode } from '@exocortex/contracts';
import { documentLinkTitleKey, wikiLinkDocumentId, wikiLinkTitle } from '@exocortex/editor';

import { useDocumentTree } from '@/lib/api/document-queries';
import { pageLinkQueryOptions } from '@/lib/api/page-link-queries';

/** Which pages exist right now, in the two shapes a reference can name one. */
interface KnownPages {
  ids: ReadonlySet<string>;
  titleKeys: ReadonlySet<string>;
  /**
   * The tooltip on a dead reference, in the reader's language. Carried with the
   * pages because the plugin has no translator of its own.
   */
  describeMissing: (title: string) => string;
}

const wikiLinkKey = new PluginKey<KnownPages | null>('exocortexWikiLinkMarkers');

/**
 * Marks a `[[Titel]]` in running text whose target does not exist.
 *
 * The page-link *block* has shown this since issue #14: a reference to nothing
 * says so, and offers to create the page. The same reference written inline
 * looked exactly like a working one, which is the half of issue #24 a reader
 * notices — an identity that survives a rename is worth little if a dead
 * reference stays invisible.
 *
 * **Decorations, not a stored attribute**, for the same reason the comment
 * markers are decorations: whether a target exists is a fact about the
 * workspace at this moment, not about the document. It must leave no trace in
 * the Yjs state, and it has to change when the *other* page is created or
 * deleted, without this document being edited at all.
 *
 * The set of existing pages is pushed in from outside through a transaction
 * meta, so the plugin stays free of any knowledge about how pages are fetched.
 * Until it arrives the plugin marks nothing: a page still loading its tree must
 * not accuse every reference on it of being dead.
 */
export function createWikiLinkMarkers(): Extension {
  return Extension.create({
    name: 'exocortexWikiLinkMarkers',

    addProseMirrorPlugins() {
      return [
        new Plugin<KnownPages | null>({
          key: wikiLinkKey,
          state: {
            init: () => null,
            apply: (transaction, value) => {
              const next = transaction.getMeta(wikiLinkKey) as KnownPages | undefined;
              return next ?? value;
            },
          },
          props: {
            decorations(state) {
              const known = wikiLinkKey.getState(state);
              if (known == null) return DecorationSet.empty;

              const decorations: Decoration[] = [];
              state.doc.descendants((node, position) => {
                if (!node.isText) return true;
                for (const mark of node.marks) {
                  const title = wikiLinkTitle({ type: mark.type.name, attrs: mark.attrs });
                  if (title === null) continue;
                  const documentId = wikiLinkDocumentId(mark.attrs);
                  const resolved =
                    (documentId !== null && known.ids.has(documentId)) ||
                    known.titleKeys.has(documentLinkTitleKey(title));
                  if (resolved) continue;
                  decorations.push(
                    Decoration.inline(position, position + node.nodeSize, {
                      class: 'exocortex-wiki-unresolved',
                      'data-resolved': 'missing',
                      title: known.describeMissing(title),
                    }),
                  );
                }
                return true;
              });
              return DecorationSet.create(state.doc, decorations);
            },
          },
        }),
      ];
    },
  });
}

/** The pages a reference can name, before the tooltip is attached. */
interface PageSet {
  ids: ReadonlySet<string>;
  titleKeys: ReadonlySet<string>;
}

/** A `[[Titel]]` in the text: its label and, when it carries one, its target's id. */
interface WikiReference {
  title: string;
  documentId: string | null;
}

/**
 * How many references on one page are asked about one by one. The tree
 * answers most of them; the rest are rows of a database and pages that do not
 * exist. A reference past this many is left unmarked rather than called dead
 * without having been asked about.
 */
const MAX_LOOKUPS = 50;

/**
 * The pages the sidebar's tree names, flattened.
 *
 * Archived pages count as existing: they are still a real target for a link
 * (the reader gets the read-only view), exactly as `resolveLink` treats them.
 */
function collectKnownPages(
  nodes: readonly DocumentTreeNode[],
  archived: readonly DocumentSummary[],
): PageSet {
  const ids = new Set<string>();
  const titleKeys = new Set<string>();

  const add = (page: { id: string; title: string }): void => {
    ids.add(page.id);
    const key = documentLinkTitleKey(page.title);
    if (key.length > 0) titleKeys.add(key);
  };

  const walk = (node: DocumentTreeNode): void => {
    add(node);
    for (const child of node.children) walk(child);
  };

  for (const node of nodes) walk(node);
  for (const page of archived) add(page);
  return { ids, titleKeys };
}

function isKnown(pages: PageSet, reference: WikiReference): boolean {
  return (
    (reference.documentId !== null && pages.ids.has(reference.documentId)) ||
    pages.titleKeys.has(documentLinkTitleKey(reference.title))
  );
}

/** Every distinct `[[Titel]]` in the document, in a stable order. */
function collectReferences(editor: Editor): WikiReference[] {
  const found = new Map<string, WikiReference>();
  editor.state.doc.descendants((node) => {
    if (!node.isText) return true;
    for (const mark of node.marks) {
      const title = wikiLinkTitle({ type: mark.type.name, attrs: mark.attrs });
      if (title === null) continue;
      const documentId = wikiLinkDocumentId(mark.attrs);
      found.set(`${documentId ?? ''}\u0000${title}`, { title, documentId });
    }
    return true;
  });
  return [...found.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, reference]) => reference);
}

function referencesKey(references: readonly WikiReference[]): string {
  return references
    .map((reference) => `${reference.documentId ?? ''}\u0000${reference.title}`)
    .join('\u0001');
}

/**
 * The references in the text, re-read a moment after the text changes.
 *
 * Kept as state that only changes when the set of references does, so typing
 * a sentence costs one walk over the document per pause and no re-render.
 */
function useWikiReferences(editor: Editor): readonly WikiReference[] {
  const [references, setReferences] = React.useState<readonly WikiReference[]>(() =>
    editor.isDestroyed ? [] : collectReferences(editor),
  );
  React.useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const read = (): void => {
      timer = null;
      if (editor.isDestroyed) return;
      const next = collectReferences(editor);
      setReferences((current) => (referencesKey(current) === referencesKey(next) ? current : next));
    };
    const schedule = ({ transaction }: { transaction: { docChanged: boolean } }): void => {
      if (!transaction.docChanged || timer !== null) return;
      timer = setTimeout(read, 300);
    };
    editor.on('transaction', schedule);
    read();
    return () => {
      editor.off('transaction', schedule);
      if (timer !== null) clearTimeout(timer);
    };
  }, [editor]);
  return references;
}

/**
 * Skips the dispatch when nothing actually changed: the tree query refetches on
 * every realtime event, and a transaction per refetch would recompute every
 * decoration in the document for nothing.
 */
function publishKnownPages(editor: Editor, known: KnownPages): void {
  const current = wikiLinkKey.getState(editor.state);
  if (
    current != null &&
    current.describeMissing === known.describeMissing &&
    current.ids.size === known.ids.size &&
    current.titleKeys.size === known.titleKeys.size &&
    [...known.ids].every((id) => current.ids.has(id)) &&
    [...known.titleKeys].every((key) => current.titleKeys.has(key))
  ) {
    return;
  }
  editor.view.dispatch(editor.state.tr.setMeta(wikiLinkKey, known));
}

/**
 * Keeps the markers in step with the workspace's pages.
 *
 * Renders nothing, and lives in the editor *chrome* rather than in the surface
 * because it reads queries — the surface must stay free of both queries and
 * effects (see the docstring on `EditorSurface`).
 *
 * Two sources, cheapest first. The sidebar's tree is already in the cache and
 * answers for every page that is not a database row, at no cost. It no longer
 * names the rows (issue #221: ten thousand of them were 15 MB, fetched again
 * on every change), so a reference the tree does not know is asked about on
 * its own, through the same `resolve` route and cache entry the page-link
 * block and a click use. Until that answer is in, the reference is not marked:
 * a dead mark that turns live a moment later reads as a broken page.
 */
export function WikiLinkMarkers({ editor, workspaceId }: { editor: Editor; workspaceId: string }) {
  const t = useTranslations('editor.wikiLink');
  const tree = useDocumentTree(workspaceId, { rows: 'count' });
  const data = tree.data;
  const references = useWikiReferences(editor);

  const fromTree = React.useMemo(
    () => (data === undefined ? null : collectKnownPages(data.nodes, data.archived)),
    [data],
  );
  const unknown = React.useMemo(
    () =>
      fromTree === null
        ? []
        : references.filter((reference) => !isKnown(fromTree, reference)).slice(0, MAX_LOOKUPS),
    [fromTree, references],
  );
  // One letter per lookup: settled-and-found, settled-and-missing, or still
  // open. A new array arrives on every render; this string only changes when
  // an answer does.
  const answers = useQueries({
    queries: unknown.map((reference) => pageLinkQueryOptions(workspaceId, reference)),
    combine: (results) =>
      results
        .map((result) =>
          result.data === undefined ? 'o' : result.data.matches.length > 0 ? 'y' : 'n',
        )
        .join(''),
  });

  const describeMissing = React.useCallback((title: string) => t('missing', { title }), [t]);
  const known = React.useMemo((): KnownPages | null => {
    if (fromTree === null) return null;
    const ids = new Set(fromTree.ids);
    const titleKeys = new Set(fromTree.titleKeys);
    unknown.forEach((reference, index) => {
      if (answers[index] === 'n') return;
      if (reference.documentId !== null) ids.add(reference.documentId);
      titleKeys.add(documentLinkTitleKey(reference.title));
    });
    // Past the cap nothing was asked, so nothing is called dead.
    for (const reference of references) {
      if (isKnown({ ids, titleKeys }, reference) || unknown.includes(reference)) continue;
      if (reference.documentId !== null) ids.add(reference.documentId);
      titleKeys.add(documentLinkTitleKey(reference.title));
    }
    return { ids, titleKeys, describeMissing };
  }, [answers, describeMissing, fromTree, references, unknown]);

  React.useEffect(() => {
    if (known === null || editor.isDestroyed) return;
    publishKnownPages(editor, known);
  }, [editor, known]);

  return null;
}
