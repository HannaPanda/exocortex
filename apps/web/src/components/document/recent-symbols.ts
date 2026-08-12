'use client';

import * as React from 'react';

import { usePersistentState } from '@/lib/use-persistent-state';

/**
 * The last symbols this browser picked, newest first.
 *
 * A picker over 1,914 emoji and 1,756 icons is only fast for the second pick if
 * it remembers the first. Without this, growing the sets would have made the
 * common case *slower* than the curated shortlist it replaced.
 *
 * Per browser and not per account: it is a convenience, and syncing it would
 * mean a write to the server for every symbol anyone tries out.
 */
const MAX_RECENT = 16;

/** Stable fallback: `usePersistentState` memoizes on the identity of this. */
const EMPTY: readonly string[] = [];

function parseRecent(raw: string): readonly string[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) return EMPTY;
  return parsed.filter((value): value is string => typeof value === 'string').slice(0, MAX_RECENT);
}

export function useRecentSymbols(
  kind: 'emoji' | 'icon',
): [readonly string[], (value: string) => void] {
  const [recent, setRecent] = usePersistentState<readonly string[]>(
    `exocortex.symbols.recent.${kind}`,
    EMPTY,
    parseRecent,
  );

  const remember = React.useCallback(
    (value: string) => {
      setRecent([value, ...recent.filter((entry) => entry !== value)].slice(0, MAX_RECENT));
    },
    [recent, setRecent],
  );

  return [recent, remember];
}
