'use client';

import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { type Editor } from '@tiptap/react';
import * as React from 'react';

import { type DocumentSummary, type DocumentTreeNode } from '@exocortex/contracts';
import { documentLinkTitleKey, wikiLinkDocumentId, wikiLinkTitle } from '@exocortex/editor';

import { useDocumentTree } from '@/lib/api/queries';

/** Which pages exist right now, in the two shapes a reference can name one. */
interface KnownPages {
  ids: ReadonlySet<string>;
  titleKeys: ReadonlySet<string>;
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
                      title: `„${title}“ gibt es in diesem Arbeitsbereich nicht`,
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

/**
 * Every page of the workspace, flattened out of the tree.
 *
 * Archived pages count as existing: they are still a real target for a link
 * (the reader gets the read-only view), exactly as `resolveLink` treats them.
 */
function collectKnownPages(
  nodes: readonly DocumentTreeNode[],
  archived: readonly DocumentSummary[],
): KnownPages {
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

/**
 * Pushes a new set of known pages into the running editor.
 *
 * Skips the dispatch when nothing actually changed: the tree query refetches on
 * every realtime event, and a transaction per refetch would recompute every
 * decoration in the document for nothing.
 */
function publishKnownPages(editor: Editor, known: KnownPages): void {
  const current = wikiLinkKey.getState(editor.state);
  if (
    current != null &&
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
 * because it reads a query — the surface must stay free of both queries and
 * effects (see the docstring on `EditorSurface`).
 *
 * Resolution here is deliberately the cheap half: the page tree is already in
 * the cache, so marking costs no request, and no page can turn a long text into
 * one lookup per reference. It is a *hint*; following a reference still asks
 * the API (`GET /workspaces/:id/documents/resolve`), which is what decides
 * between one match, several and none.
 */
export function WikiLinkMarkers({ editor, workspaceId }: { editor: Editor; workspaceId: string }) {
  const tree = useDocumentTree(workspaceId);
  const data = tree.data;

  const known = React.useMemo(
    () => (data === undefined ? null : collectKnownPages(data.nodes, data.archived)),
    [data],
  );

  React.useEffect(() => {
    if (known === null || editor.isDestroyed) return;
    publishKnownPages(editor, known);
  }, [editor, known]);

  return null;
}
