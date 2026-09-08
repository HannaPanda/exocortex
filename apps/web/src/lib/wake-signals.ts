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
 */
export function onWakeSignals(handler: () => void): () => void {
  const onVisibilityChange = (): void => {
    if (document.visibilityState === 'visible') handler();
  };
  document.addEventListener('visibilitychange', onVisibilityChange);
  window.addEventListener('online', handler);
  return () => {
    document.removeEventListener('visibilitychange', onVisibilityChange);
    window.removeEventListener('online', handler);
  };
}
