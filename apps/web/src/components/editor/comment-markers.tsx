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

/** Open comments per marked block: roots and replies of every unresolved thread. */
type MarkedBlocks = ReadonlyMap<string, number>;

const commentMarkerKey = new PluginKey<MarkedBlocks>('exocortexCommentMarkers');

/** lucide's `message-square`, the icon the comments panel uses. */
const COUNT_ICON_PATH =
  'M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z';

/**
 * The count at the block's right edge (P13, decided 2026-09-24): an icon and a
 * number instead of a left rule. Built as plain DOM because a decoration widget
 * is rendered by ProseMirror, not React. The icon is hidden from assistive
 * technology and a visually hidden word says what the number counts. It is
 * not focusable:
 * the block itself is what a click opens, and the comments panel is the
 * keyboard's way to the thread.
 */
function renderCount(count: number): HTMLElement {
  const badge = document.createElement('span');
  badge.className = 'exocortex-comment-count';
  badge.contentEditable = 'false';
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', COUNT_ICON_PATH);
  svg.append(path);
  const label = document.createElement('span');
  label.className = 'exocortex-sr-only';
  label.textContent = count === 1 ? ' Kommentar' : ' Kommentare';
  badge.append(svg, String(count), label);
  return badge;
}

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
        new Plugin<MarkedBlocks>({
          key: commentMarkerKey,
          state: {
            init: () => new Map<string, number>(),
            apply: (transaction, value) => {
              const next = transaction.getMeta(commentMarkerKey) as MarkedBlocks | undefined;
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
                const count = isValidBlockId(id) ? marked.get(id) : undefined;
                if (isValidBlockId(id) && count !== undefined) {
                  decorations.push(
                    Decoration.node(position, position + node.nodeSize, {
                      class: 'exocortex-commented',
                      [COMMENT_ANCHOR_ATTRIBUTE]: id,
                    }),
                  );
                  // A leaf (an image, a divider) has no inside to hold the
                  // count; its wash alone marks it.
                  if (!node.isLeaf) {
                    decorations.push(
                      Decoration.widget(position + 1, () => renderCount(count), {
                        side: -1,
                        key: `comment-count-${id}-${count}`,
                        ignoreSelection: true,
                      }),
                    );
                  }
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
function publishMarkedBlocks(editor: Editor, blockIds: MarkedBlocks): void {
  const current = commentMarkerKey.getState(editor.state);
  if (
    current !== undefined &&
    current.size === blockIds.size &&
    [...blockIds].every(([id, count]) => current.get(id) === count)
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
    const counts = new Map<string, number>();
    for (const thread of comments.data?.threads ?? []) {
      if (thread.root.resolvedAt !== null) continue;
      const blockId = thread.root.blockId;
      if (blockId === null || thread.root.orphaned) continue;
      counts.set(blockId, (counts.get(blockId) ?? 0) + 1 + thread.replies.length);
    }
    return counts;
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
