import * as Y from 'yjs';

import { COLLABORATION_FOREIGN_HISTORY_REASON } from '@exocortex/contracts';

/**
 * Recognizes a copy of a page that shares no history with the stored one
 * (ADR-085).
 *
 * Yjs merges two documents that were built independently instead of refusing
 * them: both halves survive, and the page carries its content twice. Until
 * 2026-09-15 the API built a fresh state on every write, so every browser that
 * had read such a page before still holds a copy of that kind in `y-indexeddb`,
 * and the first visit merges it in -- weeks later, as on 2026-10-13. A snapshot
 * restored byte for byte does the same today.
 *
 * The signature is exact rather than heuristic. An item inserted into a list
 * type is written with the neighbours it was placed between; only an item that
 * met an empty list carries neither (`origin` and `rightOrigin` both null), and
 * it is the only kind that names its root type. Its author never saw a single
 * item of that type, not even a deleted one, because a tombstone is a neighbour
 * too. So when the stored type has ever held anything, an incoming item of that
 * kind comes from a document that has never seen this one.
 *
 * Map entries (`parentSub`) are left alone: a foreign map overwrites keys by the
 * usual rule and duplicates nothing.
 */

/** Root types an update would merge into as a stranger; empty when it is a relative. */
export function foreignRootTypes(document: Y.Doc, update: Uint8Array): string[] {
  const foreign = new Set<string>();
  for (const struct of Y.decodeUpdate(update).structs) {
    if (!(struct instanceof Y.Item)) continue;
    if (struct.origin !== null || struct.rightOrigin !== null) continue;
    if (typeof struct.parent !== 'string' || struct.parentSub !== null) continue;
    // A resend of what the server already holds is not new.
    if (struct.id.clock < Y.getState(document.store, struct.id.client)) continue;
    const stored = document.share.get(struct.parent);
    if (stored?._start != null) foreign.add(struct.parent);
  }
  return [...foreign];
}

/**
 * Thrown from `beforeSync` to refuse the update before it is applied.
 *
 * Hocuspocus closes the document's connection with the error's `reason`, which
 * is how the browser learns to drop its offline copy.
 */
export class ForeignHistoryError extends Error {
  public readonly reason = COLLABORATION_FOREIGN_HISTORY_REASON;

  constructor(public readonly roots: string[]) {
    super(`Refused an update without shared history (root types: ${roots.join(', ')})`);
    this.name = 'ForeignHistoryError';
  }
}
