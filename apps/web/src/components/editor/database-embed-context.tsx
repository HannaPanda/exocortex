'use client';

import * as React from 'react';

export interface DatabaseEmbedSelection {
  documentId: string;
  title: string;
}

/** Resolves once the user picks a database, or `null` if they cancel. */
export type AskDatabaseEmbed = () => Promise<DatabaseEmbedSelection | null>;

/**
 * Lets the database embed node view reopen the same picker dialog the slash
 * menu uses ("Datenbank wechseln"), even though the dialog's state
 * (`useBlockPrompt`) lives in `EditorChrome`, a sibling of `EditorContent`
 * rather than an ancestor.
 *
 * A ref, not a plain context value: `EditorSurface` must never re-render (see
 * its docstring in `collaborative-editor.tsx`), so the function it hands down
 * to node views has to be reachable without EditorSurface holding it as
 * state. `EditorChrome` — which is allowed to re-render — keeps the ref's
 * `current` up to date.
 */
export const DatabaseEmbedPromptContext =
  React.createContext<React.RefObject<AskDatabaseEmbed | null> | null>(null);
