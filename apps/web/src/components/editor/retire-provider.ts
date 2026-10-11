import type { HocuspocusProvider } from '@hocuspocus/provider';

/**
 * Destroys a provider so that its socket can never open again (issue #166).
 *
 * `provider.destroy()` alone is not enough in @hocuspocus/provider 4.7. When a
 * socket that was connected closes, the websocket provider schedules
 * `connect()` one `delay` (a second) later, and `connect()` starts by setting
 * `shouldConnect = true` again -- it does not ask whether the instance has been
 * destroyed in the meantime. A provider destroyed inside that second therefore
 * comes back as a retry loop nobody owns: no listeners, no `providerCount`, no
 * entry in the connection log, and a fresh WebSocket on every attempt for as
 * long as the page lives. While the server is down, each of those sockets waits
 * in Firefox's per-host connect queue, and a queued WebSocket holds one of the
 * 200 slots Firefox shares across every site (`network.websocket.max-connections`).
 *
 * The collaboration hook destroys providers exactly in that window: a wake
 * signal or the revive watchdog right after a deploy closed the socket. So the
 * socket's own `connect` is replaced after the destroy. That covers the
 * scheduled call and any other path that might reach it later, and changes
 * nothing for a provider that is still in use.
 */
export function retireProvider(provider: HocuspocusProvider): void {
  const socket = provider.configuration.websocketProvider;
  provider.destroy();
  socket.connect = () => Promise.resolve();
}
