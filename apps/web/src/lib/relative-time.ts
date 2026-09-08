/**
 * "vor 3 Stunden" instead of a timestamp.
 *
 * A landing view and a conversation list both answer "how long ago", and an
 * absolute timestamp makes the reader do the subtraction. Kept in one place so
 * the two never drift into different wordings for the same distance.
 */
const RELATIVE_TIME = new Intl.RelativeTimeFormat('de-DE', { numeric: 'auto' });

export function formatRelativeTime(iso: string): string {
  const deltaMs = new Date(iso).getTime() - Date.now();
  const deltaMinutes = Math.round(deltaMs / 60_000);
  if (Math.abs(deltaMinutes) < 60) return RELATIVE_TIME.format(deltaMinutes, 'minute');
  const deltaHours = Math.round(deltaMinutes / 60);
  if (Math.abs(deltaHours) < 24) return RELATIVE_TIME.format(deltaHours, 'hour');
  const deltaDays = Math.round(deltaHours / 24);
  if (Math.abs(deltaDays) < 31) return RELATIVE_TIME.format(deltaDays, 'day');
  return RELATIVE_TIME.format(Math.round(deltaDays / 30), 'month');
}
