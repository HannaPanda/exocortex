'use client';

import {
  autoUpdate,
  computePosition,
  type ComputePositionConfig,
  flip,
  offset,
  shift,
  size,
  type VirtualElement,
} from '@floating-ui/dom';
import { type PluginKey } from '@tiptap/pm/state';
import { type Editor, useEditorState } from '@tiptap/react';
import * as React from 'react';

/**
 * Shared machinery for the `/`, `@` and `:` menus.
 *
 * ## Why these menus do not use the suggestion renderer
 *
 * `@tiptap/suggestion` offers an `onStart`/`onUpdate`/`onExit` renderer that mounts
 * a popup. It is unusable here, and the reason is worth writing down because it
 * looks like it should work.
 *
 * ProseMirror destroys **every** plugin view whenever the plugin set changes
 * (`updatePluginViews`). Tiptap's React menu components — `BubbleMenu`, the drag
 * handle — register their plugins at runtime, so mounting or unmounting any of them
 * tears down the view of every other plugin, including the suggestion's. A
 * destroyed suggestion view calls `onExit` (unmounting the popup) and its
 * replacement never calls `onStart`, because ProseMirror only calls `update` on
 * *later* transactions. The menu vanishes and never comes back.
 *
 * The plugin **state** survives all of that: it lives in the editor state, not in
 * the view. So the menus render from the state instead of from the renderer
 * lifecycle. The renderer is still used for one thing — `onKeyDown`, which the
 * plugin itself dispatches, so it is unaffected.
 */

/** Shape of the suggestion plugin state this module relies on. */
interface SuggestionPluginState {
  active: boolean;
  range: { from: number; to: number };
  query: string | null;
  decorationId?: string | null;
}

/** What an open suggestion looks like to React. */
export interface SuggestionSnapshot {
  query: string;
  from: number;
  to: number;
  decorationId: string;
}

/**
 * The current suggestion, or `null` when none is open.
 *
 * `useEditorState` compares the selected value deeply, so this re-renders only when
 * the query or the range actually changes, not on every keystroke elsewhere.
 */
export function useSuggestionSnapshot(
  editor: Editor,
  pluginKey: PluginKey,
): SuggestionSnapshot | null {
  return useEditorState({
    editor,
    selector: ({ editor: instance }) => {
      const state = pluginKey.getState(instance.state) as SuggestionPluginState | undefined;
      if (state === undefined || !state.active) return null;
      if (typeof state.decorationId !== 'string') return null;
      return {
        query: state.query ?? '',
        from: state.range.from,
        to: state.range.to,
        decorationId: state.decorationId,
      };
    },
  });
}

/**
 * Which option is highlighted, reset whenever the query changes.
 *
 * Derived during render rather than reset from an effect: the highlight belongs to
 * a particular query, so storing both together makes "a new query starts at the
 * top" a fact about the state instead of a correction applied after the fact.
 */
export function useSuggestionHighlight(query: string | null): {
  index: number;
  setIndex: (index: number) => void;
} {
  const [highlight, setHighlight] = React.useState({ query, index: 0 });
  const index = highlight.query === query ? highlight.index : 0;
  const setIndex = React.useCallback(
    (next: number) => setHighlight({ query, index: next }),
    [query],
  );
  return { index, setIndex };
}

/**
 * Keyboard handling for an open suggestion.
 *
 * The plugin dispatches `handleKeyDown` from the *plugin*, not from its view, so
 * this survives view rebuilds. It reads through a mutable holder because
 * ProseMirror calls it synchronously, before React could re-render.
 */
export interface SuggestionKeyboardState {
  /** Number of options currently offered. */
  count: number;
  /** Index of the highlighted option. */
  index: number;
  /** Moves the highlight. */
  setIndex: (index: number) => void;
  /** Applies the highlighted option. */
  choose: (index: number) => void;
  /**
   * Asked first about every key while options are offered, for a menu whose
   * keys differ from the rest: `true` or `false` is the answer, `null` leaves
   * the key to the shared handling below. The `:` menu uses it for a closing
   * colon and for an Enter it lets through (issue #269).
   */
  intercept?: (event: KeyboardEvent) => boolean | null;
}

export class SuggestionKeyboard {
  #state: SuggestionKeyboardState | null = null;

  /** Publishes the current render's keyboard state. Called from an effect. */
  publish(state: SuggestionKeyboardState | null): void {
    this.#state = state;
  }

  /**
   * Handles arrow keys, Enter and Tab. Returns whether the key was consumed, which
   * is what stops the editor from also acting on it.
   */
  handleKeyDown(event: KeyboardEvent): boolean {
    const state = this.#state;
    if (state === null || state.count === 0) return false;

    const decided = state.intercept?.(event) ?? null;
    if (decided !== null) return decided;

    if (event.key === 'ArrowDown') {
      state.setIndex((state.index + 1) % state.count);
      return true;
    }
    if (event.key === 'ArrowUp') {
      state.setIndex((state.index - 1 + state.count) % state.count);
      return true;
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
      state.choose(state.index);
      return true;
    }
    return false;
  }
}

/**
 * The suggestion's own decoration span, as a reference floating-ui can place
 * against.
 *
 * The decoration is the `/` or `@` the user typed, so anchoring to it is exactly
 * the behaviour of a native autocomplete. ProseMirror may redraw the span while
 * the user types, so the rectangle is looked up by decoration id every time it is
 * asked for rather than held as an element; `contextElement` is the editor, which
 * is what tells `autoUpdate` which scroll containers to listen to.
 */
export function useSuggestionAnchor(
  editor: Editor,
  snapshot: SuggestionSnapshot | null,
): VirtualElement | null {
  // The element is looked up during render, not in an effect: ProseMirror writes
  // the decoration to the DOM synchronously while dispatching, so it is already
  // there. Nothing is measured here; floating-ui asks in its layout effect.
  // Keyed on the whole snapshot, because typing moves the anchor along the line.
  return React.useMemo(() => {
    if (snapshot === null) return null;
    const selector = `[data-decoration-id="${snapshot.decorationId}"]`;
    if (editor.view.dom.querySelector(selector) === null) return null;
    let last: DOMRect | null = null;
    return {
      contextElement: editor.view.dom,
      getBoundingClientRect: () => {
        const element = editor.view.dom.querySelector(selector);
        if (element !== null) last = element.getBoundingClientRect();
        return last ?? new DOMRect();
      },
    };
  }, [editor, snapshot]);
}

/** Gap between the typed character and the popup, and between popup and edge. */
const ANCHOR_GAP = 6;
const VIEWPORT_PADDING = 8;

/**
 * Where a suggestion popup goes (issue #236).
 *
 * Below the caret when it fits, above it when that side has more room, and never
 * taller than the side it ended up on: `size` publishes the room as
 * `--available-height`, which the list caps its own height with, the same
 * variable Base UI's positioners hand the combobox and the select. `bestFit`
 * matters on a short window where neither side holds the whole list: the popup
 * takes the roomier side and scrolls inside, instead of hanging off the bottom
 * of a page that has nothing to scroll.
 */
const SUGGESTION_POSITION: Partial<ComputePositionConfig> = {
  placement: 'bottom-start',
  strategy: 'fixed',
  middleware: [
    offset(ANCHOR_GAP),
    flip({ padding: VIEWPORT_PADDING, fallbackStrategy: 'bestFit' }),
    shift({ padding: VIEWPORT_PADDING }),
    size({
      padding: VIEWPORT_PADDING,
      apply: ({ availableHeight, elements }) => {
        elements.floating.style.setProperty(
          '--available-height',
          `${Math.max(0, Math.floor(availableHeight))}px`,
        );
      },
    }),
  ],
};

/**
 * Fixed-position shell for a suggestion popup, placed by floating-ui.
 *
 * The same `@floating-ui/dom` the block handle and the formatting bar are placed
 * with, used directly rather than through a Base UI positioner because the menu
 * is driven by the editor's plugin state, not by an open/close root
 * (see the top of this file). The position is written to the element instead of
 * to React state: `computePosition` resolves in a microtask of the same task as
 * the layout effect, so the first paint already shows the popup where it
 * belongs. It stays invisible until then rather than flashing in the corner.
 *
 * `autoUpdate` follows scrolling, window resizes and the popup's own size (a
 * narrowing query shortens the list); the visual viewport is listened to
 * separately, because an on-screen keyboard shrinks it without resizing the
 * window, and floating-ui measures the visual viewport for `fixed`.
 */
export function SuggestionPopup({
  anchor,
  children,
}: {
  anchor: VirtualElement;
  children: React.ReactNode;
}) {
  const floatingRef = React.useRef<HTMLDivElement>(null);

  React.useLayoutEffect(() => {
    const floating = floatingRef.current;
    if (floating === null) return undefined;
    let current = true;
    const update = (): void => {
      void computePosition(anchor, floating, SUGGESTION_POSITION).then(({ x, y, placement }) => {
        if (!current) return;
        floating.style.left = `${x}px`;
        floating.style.top = `${y}px`;
        floating.style.visibility = 'visible';
        floating.dataset.side = placement.split('-')[0];
      });
    };
    const stop = autoUpdate(anchor, floating, update);
    const visual = window.visualViewport;
    visual?.addEventListener('resize', update);
    visual?.addEventListener('scroll', update);
    return () => {
      current = false;
      stop();
      visual?.removeEventListener('resize', update);
      visual?.removeEventListener('scroll', update);
    };
  }, [anchor]);

  return (
    <div
      ref={floatingRef}
      className="fixed top-0 left-0 z-50"
      style={{ visibility: 'hidden' }}
      data-testid="suggestion-popup"
    >
      {children}
    </div>
  );
}

/**
 * Keeps the highlighted option inside its list's scroll box.
 *
 * Arrow keys move the highlight while the focus stays in the editor, so nothing
 * scrolls the list on its own, and the options past its height were reachable
 * only by a mouse wheel. `scrollIntoView` is not used because it scrolls every
 * ancestor, the page included; this moves the list and nothing else. The first
 * option of a group brings its group heading along, so walking back to the top
 * shows the heading again rather than stopping one line short of it.
 */
export function useActiveOptionInView(
  listRef: React.RefObject<HTMLElement | null>,
  activeId: string,
): void {
  React.useLayoutEffect(() => {
    const list = listRef.current;
    if (list === null || activeId.length === 0) return;
    const option = list.ownerDocument.getElementById(activeId);
    if (option === null || !list.contains(option)) return;
    const group = option.closest('[role="group"]');
    const firstInGroup =
      group !== null && group.querySelector('[role="option"]') === option && list.contains(group);
    // Upwards the heading comes along; downwards only the option has to fit,
    // since a group taller than the list would otherwise push it out at the top.
    const top = (firstInGroup ? group : option).getBoundingClientRect().top;
    const { bottom } = option.getBoundingClientRect();

    const box = list.getBoundingClientRect();
    // Padding of the list, so the option does not sit flush against its border.
    const inset = Number.parseFloat(getComputedStyle(list).paddingTop) || 0;
    if (top < box.top + inset) {
      list.scrollTop -= box.top + inset - top;
    } else if (bottom > box.bottom - inset) {
      list.scrollTop += bottom - (box.bottom - inset);
    }
  }, [listRef, activeId]);
}
