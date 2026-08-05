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
      // Re-subscribe after a reconnect; rooms live on the server.
      for (const workspaceId of subscribed.current) {
        socket.emit('workspace.subscribe', { workspaceId }, (result: SubscriptionResult) => {
          if (!result.ok) setLastError(result.code);
        });
      }
    });
    socket.on('disconnect', () => setStatus('disconnected'));
    socket.on('connect_error', () => setStatus('disconnected'));

    socket.on(REALTIME_EVENT_NAME, (event: ApplicationEvent) => {
      const set = listeners.current.get(event.type);
      if (set === undefined) return;
      for (const listener of set) listener(event);
    });

    return () => {
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
