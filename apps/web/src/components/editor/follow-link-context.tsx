'use client';

import * as React from 'react';

import { type LinkTarget } from '@exocortex/editor';

/** Set only when the click carried information the target needs to react to. */
export interface FollowLinkOptions {
  /** The anchor had a `download` attribute: force a download instead of a new tab. */
  download: boolean;
  /**
   * The click asked for a second tab: middle click, Strg-/Cmd-click, or an
   * anchor that carries `target="_blank"` of its own.
   *
   * A `contenteditable` root does not let the browser follow anchors, so the
   * decision "this tab or a new one" — which belongs to the reader everywhere
   * else in a browser — has to be read off the event and carried down to
   * whichever branch of `follow` knows how to open the target (issue #29).
   */
  newTab: boolean;
}

/** Navigates to, or resolves and shows a dialog for, a classified link target. */
export type FollowLink = (target: LinkTarget, options: FollowLinkOptions) => void;

/**
 * Lets the click handler in `collaborative-editor.tsx` and the `pageLink`
 * node view reach `useLinkNavigation`'s `follow` function, even though its
 * state (`link-navigation.tsx`) lives in `EditorChrome`, a sibling of
 * `EditorContent` rather than an ancestor.
 *
 * A ref, not a plain context value: `EditorSurface` must never re-render (see
 * its docstring in `collaborative-editor.tsx`), so the function it hands down
 * to `editorProps.handleClickOn` and to node views has to be reachable
 * without `EditorSurface` holding it as state. `EditorChrome` — which is
 * allowed to re-render — keeps the ref's `current` up to date. Same pattern
 * as `database-embed-context.tsx`.
 */
export const FollowLinkContext = React.createContext<React.RefObject<FollowLink | null> | null>(
  null,
);
