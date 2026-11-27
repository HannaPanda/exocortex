'use client';

import { type Editor } from '@tiptap/react';
import * as React from 'react';

import { dodgeCaret, OUTLINE_TOP } from './outline-geometry';

/** Space kept free below the list, as in `page-outline.tsx` (1.5rem). */
const BOTTOM_MARGIN = 24;

/**
 * Moves a pinned list laid over the text out of the way of the line being
 * written on (issue #283, `outlineDodge`).
 *
 * The list is the frame (`frame`), its scrolling part `list`. The window it
 * steps into is written as two custom properties on the frame
 * (`--outline-dodge-top`, `--outline-dodge-max`), which its classes prefer
 * over the usual place; nothing re-renders, as with `--outline-top`. It is
 * asked again whenever the caret moves, the page scrolls or the list
 * changes size, and taken back when the editor loses focus.
 *
 * While the pointer is on the list it stays where it is, whatever happens:
 * a click on a heading takes the focus from the editor first, and a list
 * that moved back at that moment would take the heading from under the
 * pointer. It moves on once the pointer leaves.
 */
export function useOutlineDodge({
  editor,
  host,
  frame,
  list,
  enabled,
}: {
  editor: Editor;
  host: HTMLElement | null;
  frame: React.RefObject<HTMLElement | null>;
  list: React.RefObject<HTMLElement | null>;
  enabled: boolean;
}): void {
  React.useEffect(() => {
    const nav = frame.current;
    const scroller = host?.querySelector<HTMLElement>(':scope > .exocortex-page-scroll') ?? null;
    if (!enabled || host === null || nav === null || scroller === null) return;
    let hovered = false;
    let frameRequest: number | null = null;

    const clear = (): void => {
      nav.style.removeProperty('--outline-dodge-top');
      nav.style.removeProperty('--outline-dodge-max');
      nav.removeAttribute('data-dodging');
    };

    const place = (): void => {
      if (hovered) return;
      if (editor.isDestroyed || !editor.isFocused) {
        clear();
        return;
      }
      const hostRect = host.getBoundingClientRect();
      const top = Number.parseFloat(host.style.getPropertyValue('--outline-top')) || OUTLINE_TOP;
      const bottom = host.clientHeight - BOTTOM_MARGIN;
      const inner = list.current;
      // The list's own height with nothing in its way: the frame around the
      // scrolling part, plus everything the scrolling part holds.
      const natural =
        inner === null
          ? nav.offsetHeight
          : nav.offsetHeight - inner.clientHeight + inner.scrollHeight;
      let caret: { top: number; bottom: number };
      try {
        caret = editor.view.coordsAtPos(editor.state.selection.head);
      } catch {
        // A position the view cannot draw (mid-rebuild): nothing to avoid.
        clear();
        return;
      }
      const placed = dodgeCaret(
        { top, bottom: top + Math.min(natural, bottom - top) },
        { top: caret.top - hostRect.top, bottom: caret.bottom - hostRect.top },
        bottom,
      );
      if (placed === null) {
        clear();
        return;
      }
      nav.style.setProperty('--outline-dodge-top', `${String(Math.round(placed.top))}px`);
      nav.style.setProperty('--outline-dodge-max', `${String(Math.round(placed.maxHeight))}px`);
      nav.setAttribute('data-dodging', 'true');
    };

    const schedule = (): void => {
      if (frameRequest !== null) return;
      frameRequest = window.requestAnimationFrame(() => {
        frameRequest = null;
        place();
      });
    };
    const onEnter = (): void => {
      hovered = true;
    };
    const onLeave = (): void => {
      hovered = false;
      schedule();
    };

    editor.on('selectionUpdate', schedule);
    editor.on('focus', schedule);
    editor.on('blur', schedule);
    scroller.addEventListener('scroll', schedule, { passive: true });
    nav.addEventListener('pointerenter', onEnter);
    nav.addEventListener('pointerleave', onLeave);
    // The host for the window, the editor for lines moving without the caret
    // (a paragraph growing above it), the list's content for its own height.
    const observer = new ResizeObserver(schedule);
    observer.observe(host);
    observer.observe(editor.view.dom);
    const content = list.current?.firstElementChild;
    if (content instanceof HTMLElement) observer.observe(content);
    schedule();
    return () => {
      editor.off('selectionUpdate', schedule);
      editor.off('focus', schedule);
      editor.off('blur', schedule);
      scroller.removeEventListener('scroll', schedule);
      nav.removeEventListener('pointerenter', onEnter);
      nav.removeEventListener('pointerleave', onLeave);
      observer.disconnect();
      if (frameRequest !== null) window.cancelAnimationFrame(frameRequest);
      clear();
    };
  }, [editor, host, frame, list, enabled]);
}
