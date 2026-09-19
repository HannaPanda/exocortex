'use client';

import * as React from 'react';

export interface SavedQueryEmbedSelection {
  savedQueryId: string;
  name: string;
  limit: number;
}

/** Resolves once the user picks a saved query, or `null` if they cancel. */
export type AskSavedQueryEmbed = () => Promise<SavedQueryEmbedSelection | null>;

/**
 * Lets the query block's node view reopen the picker the slash menu uses
 * ("Suche wechseln"), issue #74.
 *
 * Exactly the arrangement `database-embed-context.tsx` describes, and a ref for
 * the same reason: `EditorSurface` must never re-render, so the function it
 * hands to node views cannot be state it holds. `EditorChrome` keeps the ref's
 * `current` up to date.
 */
export const SavedQueryEmbedPromptContext =
  React.createContext<React.RefObject<AskSavedQueryEmbed | null> | null>(null);
