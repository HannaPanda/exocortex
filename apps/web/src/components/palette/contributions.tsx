'use client';

import * as React from 'react';

import { type PaletteCommand } from './palette-command';

interface ContributionsValue {
  commands: readonly PaletteCommand[];
  set: (source: string, commands: readonly PaletteCommand[] | null) => void;
}

const ContributionsContext = React.createContext<ContributionsValue | null>(null);

/**
 * The commands that belong to whatever is on screen right now (issue #148).
 *
 * A page's actions, a database's views: their handlers and dialogs live in the
 * component that draws the page, far below the shell the palette is mounted
 * in. Rather than lifting every dialog into `AppShell`, the component offers
 * its commands here while it is mounted, and the palette lists them. Leaving
 * the page removes them, which is what "only what makes sense here" means.
 */
export function PaletteContributionsProvider({ children }: { children: React.ReactNode }) {
  const [bySource, setBySource] = React.useState<Record<string, readonly PaletteCommand[]>>({});

  const set = React.useCallback((source: string, commands: readonly PaletteCommand[] | null) => {
    setBySource((previous) => {
      if (commands === null) {
        if (!(source in previous)) return previous;
        const { [source]: _removed, ...rest } = previous;
        return rest;
      }
      return { ...previous, [source]: commands };
    });
  }, []);

  const value = React.useMemo<ContributionsValue>(
    () => ({ commands: Object.values(bySource).flat(), set }),
    [bySource, set],
  );
  return <ContributionsContext.Provider value={value}>{children}</ContributionsContext.Provider>;
}

/** Everything the mounted surfaces offer, for the registry. */
export function usePaletteContributions(): readonly PaletteCommand[] {
  return React.useContext(ContributionsContext)?.commands ?? EMPTY;
}

const EMPTY: readonly PaletteCommand[] = [];

/**
 * Offers `commands` while the calling component is mounted.
 *
 * `source` names the contributor, so two surfaces on one screen (the page's
 * top bar and its body) do not replace each other. Memoize `commands`: every
 * new array is a render of the shell. Outside the provider (a shared page, the
 * styleguide) this does nothing.
 */
export function usePaletteContribution(source: string, commands: readonly PaletteCommand[]): void {
  const set = React.useContext(ContributionsContext)?.set;
  React.useEffect(() => {
    if (set === undefined) return;
    set(source, commands);
    return () => set(source, null);
  }, [commands, set, source]);
}

/**
 * The latest value of `handlers`, for a `run` that must not rebuild the
 * command list whenever a mutation's state object changes identity.
 */
export function useLatest<T>(value: T): React.RefObject<T> {
  const ref = React.useRef(value);
  React.useLayoutEffect(() => {
    ref.current = value;
  });
  return ref;
}
