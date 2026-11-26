'use client';

import * as React from 'react';

import {
  chooseActiveConversation,
  type ConversationStorage,
  recordShownConversation,
  resolveActiveConversation,
} from './panel-state';

/**
 * The panel's active conversation, bound to the browser (issue #231).
 *
 * The rules are in `panel-state.ts`. What this adds: the two storage areas,
 * a fallback to memory where the browser refuses them (a private window, a
 * blocked site), and a listener set for this tab alone. There is
 * deliberately no `storage` event listener: hearing other tabs is exactly
 * what made every tab switch along.
 */

type AreaName = 'sessionStorage' | 'localStorage';

/** Where a value goes when the browser will not store it. Lives as long as the tab. */
const memory = new Map<string, string>();

function read(area: AreaName, key: string): string | null {
  try {
    return window[area].getItem(key);
  } catch {
    return memory.get(`${area}:${key}`) ?? null;
  }
}

function write(area: AreaName, key: string, raw: string): void {
  try {
    window[area].setItem(key, raw);
  } catch {
    memory.set(`${area}:${key}`, raw);
  }
}

const browserStorage: ConversationStorage = {
  readTab: (key) => read('sessionStorage', key),
  writeTab: (key, raw) => write('sessionStorage', key, raw),
  readSeed: (key) => read('localStorage', key),
  writeSeed: (key, raw) => write('localStorage', key, raw),
};

const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function notify(): void {
  for (const listener of listeners) listener();
}

const subscribeNever = (): (() => void) => () => undefined;

/**
 * Hands a conversation to the panel from outside it, for the page it is
 * about to show. `/chats` does this before navigating ("Im Panel
 * fortsetzen", issue #69).
 */
export function chooseConversationForPage(
  workspaceId: string,
  documentId: string | null,
  conversationId: string,
): void {
  chooseActiveConversation(browserStorage, workspaceId, documentId, conversationId);
  notify();
}

export function useActiveConversation(
  workspaceId: string,
  documentId: string | null,
): [string | null, (conversationId: string | null) => void] {
  const conversationId = React.useSyncExternalStore(
    subscribe,
    () => resolveActiveConversation(browserStorage, workspaceId, documentId),
    // The server knows no tab; the client's answer replaces this while hydrating.
    () => null,
  );
  // False only in the hydration pass, which renders the server's `null`.
  // Recording that would wipe the tab's real answer before it was read.
  const hydrated = React.useSyncExternalStore(
    subscribeNever,
    () => true,
    () => false,
  );

  React.useEffect(() => {
    if (!hydrated) return;
    recordShownConversation(browserStorage, workspaceId, documentId, conversationId);
  }, [hydrated, workspaceId, documentId, conversationId]);

  const choose = React.useCallback(
    (next: string | null) => {
      chooseActiveConversation(browserStorage, workspaceId, documentId, next);
      notify();
    },
    [workspaceId, documentId],
  );

  return [conversationId, choose];
}
