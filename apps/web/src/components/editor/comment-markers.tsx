'use client';

import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { type Editor } from '@tiptap/react';
import * as React from 'react';

import { BLOCK_ID_ATTRIBUTE, BLOCK_ID_HTML_ATTRIBUTE, isValidBlockId } from '@exocortex/editor';

import { useCommentAnchor } from '@/components/comments/comment-anchor';
import { useComments } from '@/lib/api/comment-queries';

/** HTML attribute the marker carries, so a click can find the block it belongs to. */
export const COMMENT_ANCHOR_ATTRIBUTE = 'data-comment-anchor';

const commentMarkerKey = new PluginKey<Set<string>>('exocortexCommentMarkers');

/**
 * Marks the blocks that carry an open comment thread.
 *
 * **Decorations, not marks.** A mark would be document content: it would live in
 * the Yjs state, travel in a Markdown export, be captured by every snapshot and
 * be thrown away by every restore — exactly what issue #18 says comments must
 * not be. A decoration is a view-level overlay: the document does not know it
 * exists, and the marker is recomputed from the database each time the comment
 * list changes.
 *
 * The set of marked blocks is pushed in from outside through a transaction
 * meta, because the extension has no business knowing how comments are fetched.
 */
export function createCommentMarkers(): Extension {
  return Extension.create({
    name: 'exocortexCommentMarkers',

    addProseMirrorPlugins() {
      return [
        new Plugin<Set<string>>({
          key: commentMarkerKey,
          state: {
            init: () => new Set<string>(),
            apply: (transaction, value) => {
              const next = transaction.getMeta(commentMarkerKey) as Set<string> | undefined;
              return next ?? value;
            },
          },
          props: {
            decorations(state) {
              const marked = commentMarkerKey.getState(state);
              if (marked === undefined || marked.size === 0) return DecorationSet.empty;

              const decorations: Decoration[] = [];
              state.doc.descendants((node, position) => {
                const id: unknown = node.attrs[BLOCK_ID_ATTRIBUTE];
                if (isValidBlockId(id) && marked.has(id)) {
                  decorations.push(
                    Decoration.node(position, position + node.nodeSize, {
                      class: 'exocortex-commented',
                      [COMMENT_ANCHOR_ATTRIBUTE]: id,
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

/** Pushes a new set of marked blocks into the running editor. */
function publishMarkedBlocks(editor: Editor, blockIds: Set<string>): void {
  const current = commentMarkerKey.getState(editor.state);
  if (
    current !== undefined &&
    current.size === blockIds.size &&
    [...blockIds].every((id) => current.has(id))
  ) {
    return;
  }
  editor.view.dispatch(editor.state.tr.setMeta(commentMarkerKey, blockIds));
}

/**
 * Wires the markers to the comment list, both ways.
 *
 * Renders nothing. It lives in the editor *chrome* rather than in the surface
 * because it reads a query and holds effects, and the surface must stay free of
 * both (see the docstring on `EditorSurface`).
 */
export function CommentMarkers({ editor, documentId }: { editor: Editor; documentId: string }) {
  const comments = useComments(documentId);
  const { focus, reveal } = useCommentAnchor();

  // Only open threads are marked. A resolved one is history: leaving its
  // highlight in the text would make a page look permanently unfinished.
  const markedBlocks = React.useMemo(() => {
    const ids = new Set<string>();
    for (const thread of comments.data?.threads ?? []) {
      if (thread.root.resolvedAt !== null) continue;
      if (thread.root.blockId !== null && !thread.root.orphaned) ids.add(thread.root.blockId);
    }
    return ids;
  }, [comments.data]);

  React.useEffect(() => {
    if (editor.isDestroyed) return;
    publishMarkedBlocks(editor, markedBlocks);
  }, [editor, markedBlocks]);

  // Clicking a marked passage opens its thread. Deliberately without
  // `preventDefault`: the caret still lands where it was clicked, so the
  // highlight never costs the ability to edit the sentence under it.
  React.useEffect(() => {
    const dom = editor.view.dom;
    const onClick = (event: MouseEvent): void => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      const anchor = target?.closest(`[${COMMENT_ANCHOR_ATTRIBUTE}]`);
      const blockId = anchor?.getAttribute(COMMENT_ANCHOR_ATTRIBUTE) ?? null;
      if (blockId === null) return;
      focus({ documentId, blockId });
    };
    dom.addEventListener('click', onClick);
    return () => dom.removeEventListener('click', onClick);
  }, [documentId, editor, focus]);

  // The other direction: the panel asks for a block to be brought into view.
  const handledReveal = React.useRef<number | null>(null);
  React.useEffect(() => {
    if (reveal === null || handledReveal.current === reveal.requestId) return;
    handledReveal.current = reveal.requestId;
    const element = editor.view.dom.querySelector(
      `[${BLOCK_ID_HTML_ATTRIBUTE}="${reveal.blockId}"]`,
    );
    element?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [editor, reveal]);

  return null;
}
