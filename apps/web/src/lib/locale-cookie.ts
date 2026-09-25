import { LOCALE_COOKIE, type Locale } from '@exocortex/i18n';

/**
 * The browser's copy of the interface language (issue #98). The server reads
 * it on every request, because the account's own choice only arrives with the
 * session, in the browser.
 *
 * A year, like any preference; `Lax` because it is read on top-level
 * navigations only; `Secure` whenever the page itself is.
 */
export function writeLocaleCookie(locale: Locale): void {
  const secure = window.location.protocol === 'https:' ? '; secure' : '';
  document.cookie = `${LOCALE_COOKIE}=${locale}; path=/; max-age=31536000; samesite=lax${secure}`;
}

/** Back to the browser's `Accept-Language`, for an account that chose nothing. */
export function clearLocaleCookie(): void {
  document.cookie = `${LOCALE_COOKIE}=; path=/; max-age=0; samesite=lax`;
}
