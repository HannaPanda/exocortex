'use client';

import { type Editor } from '@tiptap/react';
import * as React from 'react';

import { type PageOutlineEntry, readPageOutline, sameOutline } from '@exocortex/editor';

import {
  activeHeadingIndex,
  type OutlinePlacement,
  outlinePlacement,
  outlineWanted,
} from './outline-geometry';

/** Space between the reading line and a heading that has just been jumped to. */
const JUMP_OFFSET = 24;
/** How long a jump holds the current section before the scroll spy takes over. */
const JUMP_HOLD_MS = 900;
/** Quiet time after a change before the outline is read and measured again. */
const SETTLE_MS = 120;

export interface OutlineTracking {
  entries: readonly PageOutlineEntry[];
  /** Index into `entries` of the section being read, or `null` above the first. */
  activeIndex: number | null;
  wanted: boolean;
  placement: OutlinePlacement;
  /** Whether the room beside the text would hold the pinned list. */
  canPin: boolean;
  /** The document area the outline is drawn into, beside the scroll container. */
  host: HTMLElement | null;
  /** Pixels between the visible scroll area and the host's right edge. */
  scrollbarWidth: number;
  jump: (entry: PageOutlineEntry, index: number) => void;
}

/**
 * Follows the editor's headings and the reader's position on the page.
 *
 * Three costs are kept apart, because the issue asks for none of them on every
 * scroll event: reading the outline walks the document and runs only after a
 * document change settles; measuring reads one rectangle per heading and runs
 * after a change, a resize or a font swap; scrolling compares the scroll offset
 * with the measured numbers and touches neither the document nor the layout.
 * State changes only when its value does, so the editor never re-renders for
 * the outline.
 *
 * The scroll container is the page's own (`.exocortex-page-scroll`), never the
 * window: the application shell does not scroll, the page does.
 */
export function useOutlineTracking(editor: Editor, pinRequested: boolean): OutlineTracking {
  const [entries, setEntries] = React.useState<readonly PageOutlineEntry[]>(() =>
    readPageOutline(editor.state.doc),
  );
  const [activeIndex, setActiveIndex] = React.useState<number | null>(null);
  const [layout, setLayout] = React.useState({ wanted: false, free: 0, scrollbarWidth: 0 });
  const [elements, setElements] = React.useState<{
    scroller: HTMLElement;
    host: HTMLElement;
    page: HTMLElement;
  } | null>(null);

  const entriesRef = React.useRef(entries);
  const topsRef = React.useRef<(number | null)[]>([]);
  const holdRef = React.useRef<{ index: number; until: number } | null>(null);

  // The elements exist once the editor view is attached to the page.
  React.useEffect(() => {
    const resolve = (): boolean => {
      const dom = editor.isDestroyed ? null : editor.view.dom;
      const scroller = dom?.closest<HTMLElement>('.exocortex-page-scroll') ?? null;
      const host = dom?.closest<HTMLElement>('[data-outline-host]') ?? null;
      const page = dom?.closest<HTMLElement>('.exocortex-page') ?? null;
      if (scroller === null || host === null || page === null) return false;
      setElements({ scroller, host, page });
      return true;
    };
    if (resolve()) return;
    const frame = window.requestAnimationFrame(() => void resolve());
    return () => window.cancelAnimationFrame(frame);
  }, [editor]);

  const updateActive = React.useCallback((scroller: HTMLElement) => {
    const hold = holdRef.current;
    if (hold !== null && performance.now() < hold.until) {
      setActiveIndex(hold.index);
      return;
    }
    holdRef.current = null;
    setActiveIndex(
      activeHeadingIndex(topsRef.current, {
        scrollTop: scroller.scrollTop,
        viewportHeight: scroller.clientHeight,
        scrollHeight: scroller.scrollHeight,
      }),
    );
  }, []);

  const measure = React.useCallback(() => {
    if (elements === null || editor.isDestroyed) return;
    const { scroller, page } = elements;
    const scrollerRect = scroller.getBoundingClientRect();
    const byId = new Map<string, HTMLElement>();
    for (const element of editor.view.dom.querySelectorAll<HTMLElement>(
      ':is(h1, h2, h3, h4, h5, h6)[data-block-id]',
    )) {
      byId.set(element.dataset.blockId ?? '', element);
    }
    topsRef.current = entriesRef.current.map((entry) => {
      if (entry.hiddenUnder !== null || entry.blockId === null) return null;
      const element = byId.get(entry.blockId);
      if (element === undefined || element.getClientRects().length === 0) return null;
      return element.getBoundingClientRect().top - scrollerRect.top + scroller.scrollTop;
    });

    // The room right of the text: the page box minus its own right padding is
    // where the text ends, the scroller's client width is where the visible
    // area ends (the scrollbar is outside it).
    const pageRect = page.getBoundingClientRect();
    const paddingRight = Number.parseFloat(getComputedStyle(page).paddingRight) || 0;
    const textRight = pageRect.right - paddingRight;
    const visibleRight = scrollerRect.left + scroller.clientWidth;
    const next = {
      wanted: outlineWanted(entriesRef.current, {
        viewportHeight: scroller.clientHeight,
        scrollHeight: scroller.scrollHeight,
      }),
      free: Math.max(0, Math.floor(visibleRight - textRight)),
      scrollbarWidth: scroller.offsetWidth - scroller.clientWidth,
    };
    setLayout((previous) =>
      previous.wanted === next.wanted &&
      previous.free === next.free &&
      previous.scrollbarWidth === next.scrollbarWidth
        ? previous
        : next,
    );
    updateActive(scroller);
  }, [editor, elements, updateActive]);

  // Document changes, local, remote or from an agent, all arrive as `update`.
  React.useEffect(() => {
    let timer: number | undefined;
    const onUpdate = (): void => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (editor.isDestroyed) return;
        const next = readPageOutline(editor.state.doc);
        if (!sameOutline(entriesRef.current, next)) {
          entriesRef.current = next;
          setEntries(next);
        }
        measure();
      }, SETTLE_MS);
    };
    editor.on('update', onUpdate);
    return () => {
      editor.off('update', onUpdate);
      window.clearTimeout(timer);
    };
  }, [editor, measure]);

  // Size changes: the window, the side panels, an image that finished loading,
  // the web font arriving. All of them move headings without a document change.
  React.useEffect(() => {
    if (elements === null) return;
    let timer: number | undefined;
    const schedule = (): void => {
      window.clearTimeout(timer);
      timer = window.setTimeout(measure, SETTLE_MS);
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(elements.scroller);
    observer.observe(editor.view.dom);
    measure();
    void document.fonts.ready.then(schedule);
    return () => {
      observer.disconnect();
      window.clearTimeout(timer);
    };
  }, [editor, elements, measure]);

  React.useEffect(() => {
    if (elements === null) return;
    const { scroller } = elements;
    let frame: number | null = null;
    const onScroll = (): void => {
      if (frame !== null) return;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        updateActive(scroller);
      });
    };
    const onScrollEnd = (): void => {
      holdRef.current = null;
      updateActive(scroller);
    };
    scroller.addEventListener('scroll', onScroll, { passive: true });
    scroller.addEventListener('scrollend', onScrollEnd);
    return () => {
      scroller.removeEventListener('scroll', onScroll);
      scroller.removeEventListener('scrollend', onScrollEnd);
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, [elements, updateActive]);

  /**
   * Scrolls the page so the heading sits just below the reading line's top
   * band. Selection, focus and history stay as they were: this moves the
   * scroll container and nothing else, and a heading in a collapsed section
   * lands on the heading that hides it rather than unfolding it.
   */
  const jump = React.useCallback(
    (entry: PageOutlineEntry, index: number) => {
      if (elements === null || editor.isDestroyed) return;
      const { scroller } = elements;
      const targetId = entry.hiddenUnder ?? entry.blockId;
      const targetIndex =
        entry.hiddenUnder === null
          ? index
          : entriesRef.current.findIndex((other) => other.blockId === entry.hiddenUnder);
      const element =
        targetId === null || targetId.length === 0
          ? null
          : editor.view.dom.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(targetId)}"]`);
      if (element === null) return;
      const top =
        element.getBoundingClientRect().top -
        scroller.getBoundingClientRect().top +
        scroller.scrollTop -
        JUMP_OFFSET;
      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      // The section is current from the moment it is chosen, not once the
      // smooth scroll has passed every heading in between.
      if (targetIndex >= 0) {
        holdRef.current = { index: targetIndex, until: performance.now() + JUMP_HOLD_MS };
        setActiveIndex(targetIndex);
      }
      scroller.scrollTo({ top: Math.max(0, top), behavior: reduced ? 'auto' : 'smooth' });
    },
    [editor, elements],
  );

  return {
    entries,
    activeIndex,
    wanted: layout.wanted,
    placement: outlinePlacement(layout.free, pinRequested),
    canPin: outlinePlacement(layout.free, true) === 'pinned',
    host: elements?.host ?? null,
    scrollbarWidth: layout.scrollbarWidth,
    jump,
  };
}
