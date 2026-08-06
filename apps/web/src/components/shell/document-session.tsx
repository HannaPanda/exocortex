'use client';

import * as React from 'react';

import { useIsOffline } from '@/lib/use-persistent-state';

/**
 * Shared state between the editor and the application shell.
 *
 * The editor owns the Yjs provider, but the header shows presence, the
 * collaboration connection status and the offline indicator. Instead of lifting
 * the provider into the shell (which would recreate it on every navigation), the
 * editor publishes a small snapshot here.
 */
export interface PresenceUser {
  clientId: number;
  name: string;
  color: string;
  /** `true` for the local user. */
  self: boolean;
}

export type CollaborationStatus = 'connecting' | 'connected' | 'disconnected' | 'read-only';

/**
 * Whether the user's own edits have reached the collaboration server.
 * `saving` covers a burst of typing; `saved` is the moment it settled.
 */
export type SaveState = 'idle' | 'saving' | 'saved';

export interface DocumentSessionState {
  documentId: string | null;
  documentTitle: string | null;
  presence: PresenceUser[];
  collaboration: CollaborationStatus;
  /** `true` when the browser reports no network connection. */
  offline: boolean;
  /** `true` when local edits are waiting to be synchronized. */
  pendingSync: boolean;
  saveState: SaveState;
  /** Epoch milliseconds of the last settled edit; `null` before the first one. */
  savedAt: number | null;
  /**
   * The view a database page currently shows, together with the page it belongs
   * to. `null` for an ordinary page.
   *
   * The AI panel needs it: a collection's rows only mean something through a
   * view's filters and sorts, so telling the model about the page without the
   * view would describe a different table than the one on screen. The
   * `documentId` travels along so a stale value from a previous page is
   * recognisable as stale rather than silently applied to the current one.
   */
  activeDatabaseView: { documentId: string; viewId: string } | null;
}

const INITIAL_STATE: DocumentSessionState = {
  documentId: null,
  documentTitle: null,
  presence: [],
  collaboration: 'connecting',
  offline: false,
  pendingSync: false,
  saveState: 'idle',
  savedAt: null,
  activeDatabaseView: null,
};

interface DocumentSessionContextValue {
  state: DocumentSessionState;
  update: (patch: Partial<DocumentSessionState>) => void;
}

const DocumentSessionContext = React.createContext<DocumentSessionContextValue | null>(null);

export function DocumentSessionProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = React.useState<DocumentSessionState>(INITIAL_STATE);
  // Read from the browser rather than mirroring it into React state.
  const offline = useIsOffline();

  const update = React.useCallback((patch: Partial<DocumentSessionState>) => {
    setState((current) => ({ ...current, ...patch }));
  }, []);

  const value = React.useMemo(
    () => ({ state: { ...state, offline }, update }),
    [offline, state, update],
  );
  return (
    <DocumentSessionContext.Provider value={value}>{children}</DocumentSessionContext.Provider>
  );
}

export function useDocumentSession(): DocumentSessionContextValue {
  const context = React.useContext(DocumentSessionContext);
  if (context === null) {
    throw new Error('useDocumentSession must be used inside a DocumentSessionProvider');
  }
  return context;
}

/** Deterministic presence colour so a user keeps the same colour everywhere. */
export function presenceColor(seed: string): string {
  const tokens = [
    'var(--presence-1)',
    'var(--presence-2)',
    'var(--presence-3)',
    'var(--presence-4)',
    'var(--presence-5)',
    'var(--presence-6)',
  ];
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) % 100_000;
  }
  return tokens[hash % tokens.length] as string;
}

export function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .filter((part) => part.length > 0)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
}
