'use client';

import * as React from 'react';

/** What the page picker answers with: an identity when it has one, plus the label. */
export interface PageLinkSelection {
  /** `null` when a title was typed that no page carries yet. */
  documentId: string | null;
  title: string;
}

/**
 * Opens the page picker, pre-filled with `currentTitle`. Resolves with `null`
 * if the user cancels.
 */
export type AskPageLink = (currentTitle: string) => Promise<PageLinkSelection | null>;

/**
 * Lets the `pageLink` node view reopen the same picker the slash menu uses, so
 * a link that has already been placed can be re-targeted instead of deleted
 * and made again (issue #14).
 *
 * A ref, not a plain context value, and for the same reason as
 * `database-embed-context.tsx`: `EditorSurface` must never re-render (see its
 * docstring in `collaborative-editor.tsx`), so the function it hands down to
 * node views has to be reachable without `EditorSurface` holding it as state.
 * `EditorChrome` — which is allowed to re-render — keeps `current` up to date.
 */
export const PageLinkPromptContext =
  React.createContext<React.RefObject<AskPageLink | null> | null>(null);
