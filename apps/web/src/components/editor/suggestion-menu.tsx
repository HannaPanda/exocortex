'use client';

import { type PluginKey } from '@tiptap/pm/state';
import { type Editor, useEditorState } from '@tiptap/react';
import * as React from 'react';

/**
 * Shared machinery for the `/` and `@` menus.
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
 * Screen position of the suggestion's own decoration span.
 *
 * The decoration is the `/` or `@` the user typed, so anchoring to it is exactly
 * the behaviour of a native autocomplete. Measured on every render of the open
 * menu, which is often enough: the anchor only moves when the query changes.
 */
export function useSuggestionAnchor(
  editor: Editor,
  snapshot: SuggestionSnapshot | null,
): { top: number; left: number } | null {
  // Measured during render, not in an effect: ProseMirror writes the decoration to
  // the DOM synchronously while dispatching, so the element is already there, and
  // going through state would render the popup one frame at the wrong position.
  // Keyed on the whole snapshot, because typing moves the anchor along the line.
  return React.useMemo(() => {
    if (snapshot === null) return null;
    const element = editor.view.dom.querySelector(
      `[data-decoration-id="${snapshot.decorationId}"]`,
    );
    if (element === null) return null;
    const rect = element.getBoundingClientRect();
    return { top: rect.bottom + 6, left: rect.left };
  }, [editor, snapshot]);
}

/** Fixed-position shell for a suggestion popup. */
export function SuggestionPopup({
  anchor,
  children,
}: {
  anchor: { top: number; left: number };
  children: React.ReactNode;
}) {
  return (
    <div className="fixed z-50" style={{ top: `${anchor.top}px`, left: `${anchor.left}px` }}>
      {children}
    </div>
  );
}
