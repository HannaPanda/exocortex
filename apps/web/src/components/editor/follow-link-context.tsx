'use client';

import * as React from 'react';

import { type LinkTarget } from '@exocortex/editor';

/** Set only when the click carried information the target needs to react to. */
export interface FollowLinkOptions {
  /** The anchor had a `download` attribute: force a download instead of a new tab. */
  download: boolean;
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
