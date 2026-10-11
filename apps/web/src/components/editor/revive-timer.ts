import type { ConnectionDetailValue } from '@/lib/connection-log';

/**
 * How long the connection may stay unusable before it is built again from a
 * fresh ticket.
 *
 * The provider reconnects on its own and never gives up, but that only covers
 * a socket that was open once and then closed: `onOpen` is what clears its
 * retry canceller. A handshake refused outright never reaches `onOpen`, so the
 * retry loop is the only thing left holding the connection, and when it ends
 * the tab is simply dead. On 2026-09-08 a deploy restarted the collaboration
 * unit under an open page, nginx answered the upgrade with 502, and the tab sat
 * disconnected for eight minutes without one further attempt reaching the
 * server. Only F5 brought it back.
 *
 * Rebuilding is cheap and lossless: the Yjs document merges rather than
 * replaces, and the offline copy carries whatever was typed in the meantime.
 */
const REVIVE_DELAY_MS = 20_000;

/** The revive delay doubles per consecutive failure, up to this ceiling. */
const REVIVE_MAX_DELAY_MS = 120_000;

/**
 * The revive watchdog's timer: one pending rebuild at a time, delayed by the
 * backoff that `count` holds.
 *
 * Shared by the two places that arm it in `useCollaborationConnection`: a
 * connection that stays unusable, and a ticket request that failed before any
 * provider existed (issue #166). `count` is the hook's ref, so the backoff
 * survives the rebuild that resets everything else.
 */
export function reviveTimer(
  count: { current: number },
  rebuild: () => void,
  record: (event: string, detail?: Record<string, ConnectionDetailValue>) => void,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    schedule(detail: Record<string, ConnectionDetailValue>): void {
      clearTimeout(timer);
      const delay = Math.min(REVIVE_DELAY_MS * 2 ** count.current, REVIVE_MAX_DELAY_MS);
      record('revive.armed', { delayMs: delay, ...detail });
      timer = setTimeout(() => {
        count.current += 1;
        record('revive.fired', { count: count.current });
        rebuild();
      }, delay);
    },
    cancel(): void {
      clearTimeout(timer);
    },
    /** A fresh signal rather than another failure: rebuild now, backoff reset. */
    now(): void {
      clearTimeout(timer);
      count.current = 0;
      rebuild();
    },
  };
}
