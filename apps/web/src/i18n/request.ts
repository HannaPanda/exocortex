import { cookies, headers } from 'next/headers';
import { getRequestConfig } from 'next-intl/server';

import {
  DEFAULT_TIME_ZONE,
  LOCALE_COOKIE,
  resolveLocale,
  TIME_ZONE_COOKIE,
  validTimeZone,
} from '@exocortex/i18n';
import { pickMessages } from '@exocortex/i18n/catalog';

import { WEB_NAMESPACES } from './namespaces';

/**
 * Which language this request renders in (issue #98, ADR-062).
 *
 * No locale in the URL: the app sits behind a login, and a language is a
 * property of the person, not of the address. The account's own choice is
 * not known here -- the session is loaded in the browser -- so the server
 * resolves from the cookie and the browser's `Accept-Language`, and
 * `LocaleSync` moves the cookie to the account's choice once the session has
 * arrived. On a device the account already used, the two agree from the
 * first frame. The time zone travels the same way (`TimeZoneSync`), because
 * the process rendering this runs in UTC and the reader does not.
 */
export default getRequestConfig(async () => {
  const [cookieStore, headerStore] = await Promise.all([cookies(), headers()]);
  const locale = resolveLocale({
    cookie: cookieStore.get(LOCALE_COOKIE)?.value ?? null,
    acceptLanguage: headerStore.get('accept-language'),
  });
  const timeZone = validTimeZone(cookieStore.get(TIME_ZONE_COOKIE)?.value) ?? DEFAULT_TIME_ZONE;
  return { locale, timeZone, messages: pickMessages(locale, WEB_NAMESPACES) };
});
