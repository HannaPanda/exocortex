/**
 * Where an open row lives in the address (issue #239).
 *
 * `?p=<id>` beside the page's own path, the way Notion writes its side peek:
 * the address can be shared, a reload opens the same row again, and the
 * browser's Back closes the panel instead of leaving the database. Pure so the
 * rules are tested without a router.
 */
export const PEEK_PARAM = 'p';

/**
 * The row the address opens beside `documentId`, or `null`.
 *
 * A page cannot be opened beside itself: `?p=` naming the page that is already
 * shown is read as no panel at all, never as a second copy of the same editor.
 */
export function peekIdOf(search: Pick<URLSearchParams, 'get'>, documentId: string): string | null {
  const value = search.get(PEEK_PARAM);
  if (value === null || value.length === 0 || value === documentId) return null;
  return value;
}

/**
 * The address with the panel showing `rowId`, or without the panel for `null`.
 * Every other parameter, and the hash, stays as it was.
 */
export function peekAddress(
  location: Pick<Location, 'pathname' | 'search' | 'hash'>,
  rowId: string | null,
): string {
  const params = new URLSearchParams(location.search);
  if (rowId === null) params.delete(PEEK_PARAM);
  else params.set(PEEK_PARAM, rowId);
  const query = params.toString();
  return `${location.pathname}${query.length > 0 ? `?${query}` : ''}${location.hash}`;
}

/**
 * Whether opening a row adds a step to the browser's history.
 *
 * Opening the panel does, so Back closes it. Switching to another row while
 * it is open replaces the step, so one Back still closes the panel rather than
 * walking back through every row looked at on the way.
 */
export function opensWithNewHistoryStep(currentPeekId: string | null): boolean {
  return currentPeekId === null;
}
