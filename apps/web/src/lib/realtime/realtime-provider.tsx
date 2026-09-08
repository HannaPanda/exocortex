'use client';

import * as React from 'react';
import { io, type Socket } from 'socket.io-client';

import {
  type ApplicationEvent,
  type ApplicationEventType,
  REALTIME_EVENT_NAME,
  REALTIME_SOCKET_PATH,
  type SubscriptionResult,
} from '@exocortex/contracts';

import { realtimeOrigin } from '../env';
import { onWakeSignals } from '../wake-signals';

export type RealtimeStatus = 'connecting' | 'connected' | 'disconnected';

type Listener = (event: ApplicationEvent) => void;

interface RealtimeContextValue {
  status: RealtimeStatus;
  /** Subscribes to a workspace room. The server authorizes the subscription. */
  subscribe: (workspaceId: string) => void;
  /** Registers a listener for one event type. Returns an unsubscribe function. */
  on: <TType extends ApplicationEventType>(
    type: TType,
    listener: (event: Extract<ApplicationEvent, { type: TType }>) => void,
  ) => () => void;
  /** Last subscription rejection, if any. Surfaced in the UI. */
  lastError: string | null;
}

const RealtimeContext = React.createContext<RealtimeContextValue | null>(null);

const RECONNECT_BASE_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 30_000;
/** How long a connection must last before it counts as healthy. */
const RECONNECT_STABLE_AFTER_MS = 3_000;

/**
 * Application realtime channel.
 *
 * Separate from the Yjs collaboration socket by design (ADR-008): this socket
 * carries domain events (tree changes, job progress, AI streaming) while
 * Hocuspocus carries document updates.
 */
export function RealtimeProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = React.useState<RealtimeStatus>('connecting');
  const [lastError, setLastError] = React.useState<string | null>(null);
  const socketRef = React.useRef<Socket | null>(null);
  const listeners = React.useRef(new Map<string, Set<Listener>>());
  const subscribed = React.useRef(new Set<string>());

  React.useEffect(() => {
    /** Backoff for manual reconnects, doubling from 1s to a 30s ceiling. */
    let retryDelay = RECONNECT_BASE_DELAY_MS;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let stableTimer: ReturnType<typeof setTimeout> | null = null;

    const scheduleReconnect = (): void => {
      if (retryTimer !== null) return;
      retryTimer = setTimeout(() => {
        retryTimer = null;
        retryDelay = Math.min(retryDelay * 2, RECONNECT_MAX_DELAY_MS);
        socketRef.current?.connect();
      }, retryDelay);
    };

    const socket = io(realtimeOrigin(), {
      path: REALTIME_SOCKET_PATH,
      withCredentials: true,
      transports: ['websocket', 'polling'],
      reconnectionDelay: 500,
      reconnectionDelayMax: 5_000,
    });
    socketRef.current = socket;

    socket.on('connect', () => {
      setStatus('connected');
      setLastError(null);
      // The backoff resets only once the connection has *lasted*, never on the
      // `connect` event itself: a socket the gateway is about to reject still
      // fires `connect` first, so resetting here would hold the delay at its
      // minimum forever and turn a signed-out tab into a permanent retry loop
      // against our own gateway.
      if (stableTimer !== null) clearTimeout(stableTimer);
      stableTimer = setTimeout(() => {
        stableTimer = null;
        if (socket.connected) retryDelay = RECONNECT_BASE_DELAY_MS;
      }, RECONNECT_STABLE_AFTER_MS);
      // Re-subscribe after a reconnect; rooms live on the server.
      for (const workspaceId of subscribed.current) {
        socket.emit('workspace.subscribe', { workspaceId }, (result: SubscriptionResult) => {
          if (!result.ok) setLastError(result.code);
        });
      }
    });
    socket.on('disconnect', (reason) => {
      setStatus('disconnected');
      if (stableTimer !== null) {
        clearTimeout(stableTimer);
        stableTimer = null;
      }
      // Socket.IO reconnects on its own after a dropped network, but never
      // after the *server* closed the connection -- that is documented
      // behaviour, and `io server disconnect` is exactly what the gateway
      // produces when it rejects a socket that carried no session
      // (`handleConnection` calls `client.disconnect(true)`).
      //
      // The provider mounts with the app shell, so a socket can open in the
      // moment between the page loading and the session cookie existing: a
      // first sign-in on a fresh browser hits that window. Without this, the
      // rejection is permanent, the connection pill stays red for the whole
      // visit, and only a reload fixes it.
      //
      // Backoff rather than a tight retry: if the visitor really is signed out,
      // every attempt is refused, and hammering our own gateway would be the
      // wrong way to find that out.
      if (reason === 'io server disconnect') scheduleReconnect();
    });
    socket.on('connect_error', () => setStatus('disconnected'));

    socket.on(REALTIME_EVENT_NAME, (event: ApplicationEvent) => {
      const set = listeners.current.get(event.type);
      if (set === undefined) return;
      for (const listener of set) listener(event);
    });

    /**
     * A tab the user just came back to must not sit out a grown backoff.
     *
     * The delay above doubles towards half a minute, and a deploy that restarts
     * the API refuses several attempts in a row, so by the time the unit is
     * back the tab may be most of a minute away from trying again. That is the
     * exact window in which someone looks at the header, sees "getrennt", and
     * reloads. Returning to the tab or regaining the network is a fresh signal
     * rather than another failure, so it clears the backoff and retries at
     * once. `connect()` on an already open socket is a no-op.
     */
    const reconnectNow = (): void => {
      if (retryTimer !== null) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      retryDelay = RECONNECT_BASE_DELAY_MS;
      if (!socket.connected) socket.connect();
    };
    const detachWake = onWakeSignals(reconnectNow);

    return () => {
      if (retryTimer !== null) clearTimeout(retryTimer);
      if (stableTimer !== null) clearTimeout(stableTimer);
      detachWake();
      socket.close();
      socketRef.current = null;
    };
  }, []);

  const subscribe = React.useCallback((workspaceId: string) => {
    subscribed.current.add(workspaceId);
    const socket = socketRef.current;
    if (socket === null || !socket.connected) return;
    socket.emit('workspace.subscribe', { workspaceId }, (result: SubscriptionResult) => {
      if (!result.ok) setLastError(result.code);
    });
  }, []);

  const on = React.useCallback(
    <TType extends ApplicationEventType>(
      type: TType,
      listener: (event: Extract<ApplicationEvent, { type: TType }>) => void,
    ): (() => void) => {
      const set = listeners.current.get(type) ?? new Set<Listener>();
      const wrapped = listener as Listener;
      set.add(wrapped);
      listeners.current.set(type, set);
      return () => {
        set.delete(wrapped);
      };
    },
    [],
  );

  const value = React.useMemo<RealtimeContextValue>(
    () => ({ status, subscribe, on, lastError }),
    [status, subscribe, on, lastError],
  );

  return <RealtimeContext.Provider value={value}>{children}</RealtimeContext.Provider>;
}

export function useRealtime(): RealtimeContextValue {
  const context = React.useContext(RealtimeContext);
  if (context === null) {
    throw new Error('useRealtime must be used inside a RealtimeProvider');
  }
  return context;
}

/** Subscribes to one event type for the lifetime of the component. */
export function useRealtimeEvent<TType extends ApplicationEventType>(
  type: TType,
  listener: (event: Extract<ApplicationEvent, { type: TType }>) => void,
): void {
  const { on } = useRealtime();
  const stable = React.useRef(listener);

  // Writing a ref during render is not allowed; the effect keeps the latest
  // callback without re-subscribing on every render.
  React.useEffect(() => {
    stable.current = listener;
  }, [listener]);

  React.useEffect(() => on(type, (event) => stable.current(event)), [on, type]);
}
