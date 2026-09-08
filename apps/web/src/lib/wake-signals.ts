/**
 * The two moments a dropped connection deserves a fresh attempt right away.
 *
 * Both live channels back off when a connection fails, and both were doing the
 * right thing for a page nobody is looking at while doing the wrong thing for
 * the moment someone returns to it: a deploy refuses several attempts in a row,
 * the delay grows, and the tab then sits out most of a minute with "getrennt"
 * in the header. Returning to a tab, or regaining the network, is a new signal
 * rather than another failure, so it belongs outside the backoff entirely.
 *
 * A module of its own because the application socket and the collaboration
 * connection need exactly this and nothing else, and had no business each
 * carrying their own copy of the listener bookkeeping.
 *
 * The handler is told which of the two signals fired. Neither channel acts on
 * that, but both write it down, and telling "the tab came back" apart from "the
 * network came back" is the difference between two very different faults when
 * reading the log afterwards.
 */
export type WakeReason = 'visible' | 'online';

export function onWakeSignals(handler: (reason: WakeReason) => void): () => void {
  const onVisibilityChange = (): void => {
    if (document.visibilityState === 'visible') handler('visible');
  };
  const onOnline = (): void => handler('online');
  document.addEventListener('visibilitychange', onVisibilityChange);
  window.addEventListener('online', onOnline);
  return () => {
    document.removeEventListener('visibilitychange', onVisibilityChange);
    window.removeEventListener('online', onOnline);
  };
}
