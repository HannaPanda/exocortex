'use client';

import * as React from 'react';

/**
 * `localStorage`-backed state without a hydration mismatch and without calling
 * `setState` from an effect.
 *
 * `useSyncExternalStore` is exactly the right tool here: the server snapshot is
 * the fallback value, the client snapshot is the stored value, and React performs
 * the switch during hydration itself.
 */
interface Store {
  subscribe: (onStoreChange: () => void) => () => void;
  getSnapshot: () => string | null;
  set: (raw: string) => void;
}

const stores = new Map<string, Store>();

// A private window, blocked site data or a full quota make the storage throw.
// What is kept here is a convenience, so the value then lives for the tab only.
function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, raw: string): void {
  try {
    window.localStorage.setItem(key, raw);
  } catch {
    // Kept in memory by the store; nothing else to do.
  }
}

function storeFor(key: string): Store {
  const existing = stores.get(key);
  if (existing !== undefined) return existing;

  const listeners = new Set<() => void>();
  // The snapshot must be referentially stable between changes, otherwise React
  // re-renders forever.
  let cached: string | null = null;
  let initialized = false;

  const store: Store = {
    subscribe: (onStoreChange) => {
      listeners.add(onStoreChange);
      const onStorage = (event: StorageEvent): void => {
        if (event.key !== key) return;
        cached = event.newValue;
        for (const listener of listeners) listener();
      };
      window.addEventListener('storage', onStorage);
      return () => {
        listeners.delete(onStoreChange);
        window.removeEventListener('storage', onStorage);
      };
    },
    getSnapshot: () => {
      if (!initialized) {
        cached = readStorage(key);
        initialized = true;
      }
      return cached;
    },
    set: (raw) => {
      cached = raw;
      initialized = true;
      writeStorage(key, raw);
      for (const listener of listeners) listener();
    },
  };

  stores.set(key, store);
  return store;
}

export function usePersistentState<TValue>(
  key: string,
  fallback: TValue,
  parse: (raw: string) => TValue,
): [TValue, (value: TValue) => void] {
  const store = React.useMemo(() => storeFor(key), [key]);
  const raw = React.useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    // Server snapshot: nothing is stored, so the fallback applies.
    () => null,
  );

  const value = React.useMemo(() => {
    if (raw === null) return fallback;
    try {
      return parse(raw);
    } catch {
      // A corrupt entry must not break the layout.
      return fallback;
    }
  }, [fallback, parse, raw]);

  const set = React.useCallback(
    (next: TValue) => {
      store.set(JSON.stringify(next));
    },
    [store],
  );

  return [value, set];
}

/**
 * Browser online/offline state, again through `useSyncExternalStore` so no effect
 * has to push it into React state.
 */
const onlineStore = {
  subscribe: (onStoreChange: () => void) => {
    window.addEventListener('online', onStoreChange);
    window.addEventListener('offline', onStoreChange);
    return () => {
      window.removeEventListener('online', onStoreChange);
      window.removeEventListener('offline', onStoreChange);
    };
  },
  getSnapshot: () => navigator.onLine,
  getServerSnapshot: () => true,
};

export function useIsOffline(): boolean {
  return !React.useSyncExternalStore(
    onlineStore.subscribe,
    onlineStore.getSnapshot,
    onlineStore.getServerSnapshot,
  );
}
