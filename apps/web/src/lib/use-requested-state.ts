'use client';

import * as React from 'react';

/**
 * State that starts at what the address asked for and follows it when the
 * address changes, while staying free to change on its own in between.
 *
 * The settings pages open a group or a tab from a query parameter (issue
 * #148). A palette command pointing at another group while the page is
 * already open changes only the address, not the mounted component, so the
 * state has to follow the request without being reset by a `key`: a key
 * would throw away the unsaved draft beside it. `null` asks for nothing and
 * leaves the state where it is.
 */
export function useRequestedState<T>(
  requested: T | null,
  fallback: T,
): [T, React.Dispatch<React.SetStateAction<T>>] {
  const [value, setValue] = React.useState<T>(requested ?? fallback);
  const [lastRequested, setLastRequested] = React.useState(requested);
  if (lastRequested !== requested) {
    setLastRequested(requested);
    if (requested !== null) setValue(requested);
  }
  return [value, setValue];
}
