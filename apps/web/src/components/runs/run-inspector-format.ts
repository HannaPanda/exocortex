'use client';

import { useFormatter } from 'next-intl';
import * as React from 'react';

/** Numbers, money and durations the way the reader's language writes them. */
export function useRunFormat() {
  const format = useFormatter();
  return React.useMemo(() => {
    const count = (value: number): string => format.number(value);
    const money = (microUsd: number): string =>
      format.number(microUsd / 1_000_000, {
        style: 'currency',
        currency: 'USD',
        maximumFractionDigits: 4,
      });
    /** `840 ms` below a second, `1,8 s` above, `3:42 min` above a minute. */
    const duration = (ms: number): string => {
      if (ms < 1000) return `${format.number(Math.round(ms))} ms`;
      if (ms < 60_000) {
        return `${format.number(ms / 1000, { maximumFractionDigits: 1, minimumFractionDigits: 1 })} s`;
      }
      const minutes = Math.floor(ms / 60_000);
      const seconds = Math.round((ms % 60_000) / 1000);
      return `${String(minutes)}:${String(seconds).padStart(2, '0')} min`;
    };
    /** Where a step sits relative to the run's creation, as the timeline's left column. */
    const offset = (at: string, origin: string): string => {
      const ms = Math.max(0, Date.parse(at) - Date.parse(origin));
      const minutes = Math.floor(ms / 60_000);
      const seconds = (ms % 60_000) / 1000;
      return `${String(minutes).padStart(2, '0')}:${format.number(seconds, {
        minimumIntegerDigits: 2,
        minimumFractionDigits: 1,
        maximumFractionDigits: 1,
      })}`;
    };
    const moment = (iso: string): string =>
      format.dateTime(new Date(iso), {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    return { count, money, duration, offset, moment };
  }, [format]);
}

export type RunFormat = ReturnType<typeof useRunFormat>;
