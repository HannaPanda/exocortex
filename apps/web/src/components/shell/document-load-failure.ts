import { ApiError } from '@/lib/api/client';

/**
 * Whether a failed load of the page's details takes the page away (issue #285).
 *
 * The details are fetched again now and then while the page is open: an event
 * invalidates them, the network comes back, a component mounts after they went
 * stale. When that refetch failed because the API was briefly out of reach (a
 * deploy restarting it, a phone between two cells), the query went into its
 * error state with the page's data still in hand, and the view swapped the
 * whole page -- title, editor, connection -- for the error panel. When the
 * page came back it was built from scratch, at the top.
 *
 * So the error panel is for a page that never loaded, and for an answer that
 * is final: a 4xx says the page is gone or no longer this reader's, and showing
 * the stale copy would be a lie. Anything else is an outage, and the page that
 * is already on screen stays while the next fetch tries again.
 */
export function replacesPageOnError(error: unknown, hasData: boolean): boolean {
  if (!hasData) return true;
  return error instanceof ApiError && error.status < 500;
}
