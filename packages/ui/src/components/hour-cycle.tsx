'use client';

import * as React from 'react';

import { type HourCycle } from '../lib/time-of-day';

/**
 * The clock this person reads times on (issue #255), for everything below it:
 * `TimeInput`, and the formatter `apps/web` wraps around `useFormatter`.
 *
 * `undefined`, the default without a provider, means "as the interface
 * language writes it", which is what `Intl` does on its own. The app shell
 * provides the account's choice; a page outside it (sign-in, a public link)
 * has no account and keeps the language's clock.
 */
const HourCycleContext = React.createContext<HourCycle | undefined>(undefined);

export function HourCycleProvider({
  value,
  children,
}: {
  value: HourCycle | undefined;
  children: React.ReactNode;
}) {
  return <HourCycleContext.Provider value={value}>{children}</HourCycleContext.Provider>;
}

export function useHourCycle(): HourCycle | undefined {
  return React.useContext(HourCycleContext);
}
