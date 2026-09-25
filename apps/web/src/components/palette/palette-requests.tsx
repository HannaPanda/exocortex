'use client';

import * as React from 'react';

/**
 * Things the palette asks a control somewhere else on screen to do.
 *
 * Some actions already have a home that owns their state: the icon picker's
 * popover, the cover's file input, the title field, the assistant's
 * conversation. Those controls stay the only place the action is implemented;
 * the palette just asks, and the control that is mounted answers. A request
 * nobody is listening for waits a moment for its listener, because asking
 * for a new chat is also what opens the panel the assistant lives in; after
 * that it is dropped, so a stale request never fires on some later visit.
 */
export type PaletteRequest =
  'rename' | 'change-icon' | 'upload-cover' | 'generate-cover' | 'upload-file' | 'new-chat';

type Listener = () => void;

/** How long a request waits for a control that is about to mount. */
const PENDING_MS = 2000;

interface RequestsValue {
  ask: (request: PaletteRequest) => void;
  listen: (request: PaletteRequest, listener: Listener) => () => void;
}

const RequestsContext = React.createContext<RequestsValue | null>(null);

export function PaletteRequestsProvider({ children }: { children: React.ReactNode }) {
  const listeners = React.useRef(new Map<PaletteRequest, Set<Listener>>());
  const pending = React.useRef(new Map<PaletteRequest, number>());
  const value = React.useMemo<RequestsValue>(
    () => ({
      ask: (request) => {
        const set = listeners.current.get(request);
        if (set === undefined || set.size === 0) {
          pending.current.set(request, Date.now());
          return;
        }
        for (const listener of set) listener();
      },
      listen: (request, listener) => {
        const set = listeners.current.get(request) ?? new Set<Listener>();
        set.add(listener);
        listeners.current.set(request, set);
        const askedAt = pending.current.get(request);
        if (askedAt !== undefined) {
          pending.current.delete(request);
          if (Date.now() - askedAt < PENDING_MS) queueMicrotask(listener);
        }
        return () => set.delete(listener);
      },
    }),
    [],
  );
  return <RequestsContext.Provider value={value}>{children}</RequestsContext.Provider>;
}

/** Sends a request to whichever control answers it. */
export function useAskPalette(): (request: PaletteRequest) => void {
  return React.useContext(RequestsContext)?.ask ?? NOOP;
}

const NOOP = (): void => undefined;

/**
 * Answers `request` while mounted. `enabled` lets a read-only surface stay
 * silent without breaking the rule of hooks.
 */
export function usePaletteRequest(
  request: PaletteRequest,
  handler: Listener,
  enabled = true,
): void {
  const listen = React.useContext(RequestsContext)?.listen;
  const latest = React.useRef(handler);
  React.useLayoutEffect(() => {
    latest.current = handler;
  });
  React.useEffect(() => {
    if (listen === undefined || !enabled) return;
    return listen(request, () => latest.current());
  }, [enabled, listen, request]);
}
