/**
 * "Show me on the page what this run changed" (issue #248), handed from the
 * chat to whichever editor shows that page.
 *
 * The chat and the editor are siblings that share no state, and the page may
 * not even be open yet when the request is made: following the link mounts
 * the editor a moment later. So the request waits here, for one page and a
 * short while, until an editor for that page takes it. Nothing is stored and
 * nothing outlives the tab; a request nobody takes simply expires.
 */
export interface RunHighlightRequest {
  documentId: string;
  runId: string;
  requestedAt: number;
}

/** Long enough for a navigation and a cold editor, short enough not to surprise a later visit. */
const REQUEST_TTL_MS = 20_000;

let pending: RunHighlightRequest | null = null;
const listeners = new Set<() => void>();

export function requestRunHighlight(documentId: string, runId: string): void {
  pending = { documentId, runId, requestedAt: Date.now() };
  for (const listener of listeners) listener();
}

/** Hands the request to the editor of its page, once; `null` when there is none for it. */
export function takeRunHighlight(documentId: string): RunHighlightRequest | null {
  if (pending === null || pending.documentId !== documentId) return null;
  const request = pending;
  pending = null;
  return Date.now() - request.requestedAt > REQUEST_TTL_MS ? null : request;
}

export function subscribeRunHighlight(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
