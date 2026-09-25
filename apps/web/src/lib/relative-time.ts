import { useLocale } from 'next-intl';
import { useCallback } from 'react';

/**
 * "vor 3 Stunden" instead of a timestamp.
 *
 * A landing view and a conversation list both answer "how long ago", and an
 * absolute timestamp makes the reader do the subtraction. Kept in one place so
 * the two never drift into different wordings for the same distance. The
 * wording is the reader's language (issue #98); one formatter per locale.
 */
const FORMATTERS = new Map<string, Intl.RelativeTimeFormat>();

function formatterFor(locale: string): Intl.RelativeTimeFormat {
  let formatter = FORMATTERS.get(locale);
  if (formatter === undefined) {
    formatter = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
    FORMATTERS.set(locale, formatter);
  }
  return formatter;
}

export function formatRelativeTime(iso: string, locale: string): string {
  const format = formatterFor(locale);
  const deltaMs = new Date(iso).getTime() - Date.now();
  const deltaMinutes = Math.round(deltaMs / 60_000);
  if (Math.abs(deltaMinutes) < 60) return format.format(deltaMinutes, 'minute');
  const deltaHours = Math.round(deltaMinutes / 60);
  if (Math.abs(deltaHours) < 24) return format.format(deltaHours, 'hour');
  const deltaDays = Math.round(deltaHours / 24);
  if (Math.abs(deltaDays) < 31) return format.format(deltaDays, 'day');
  return format.format(Math.round(deltaDays / 30), 'month');
}

/** `formatRelativeTime` in the active locale. */
export function useRelativeTime(): (iso: string) => string {
  const locale = useLocale();
  return useCallback((iso: string) => formatRelativeTime(iso, locale), [locale]);
}
