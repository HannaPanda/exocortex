/**
 * The time zone dates are shown in (issue #98).
 *
 * A date on screen is formatted by `useFormatter()`, and next-intl formats in
 * the zone of its configuration. Left alone, that is the zone of the process
 * that rendered the page, which on a server is usually UTC, so every time of
 * day would be off by the reader's offset. The browser knows the reader's
 * zone; it hands it to the server in this cookie, the same way it hands over
 * the language.
 */
export const TIME_ZONE_COOKIE = 'exocortex.tz';

/**
 * What the server renders in before a browser has said anything: the zone of
 * the default locale's readers. The browser corrects it on its first visit.
 */
export const DEFAULT_TIME_ZONE = 'Europe/Berlin';

/**
 * `value` if it names an IANA zone this runtime knows, otherwise `null`.
 * Kept as written rather than canonicalised: a browser saying
 * `Asia/Calcutta` would otherwise never see its own zone come back and
 * would refresh on every visit.
 */
export function validTimeZone(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === '' || value.length > 64) return null;
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return value;
  } catch {
    return null;
  }
}
