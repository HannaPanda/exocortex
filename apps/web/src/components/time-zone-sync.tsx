'use client';

import { useRouter } from 'next/navigation';
import { useTimeZone } from 'next-intl';
import * as React from 'react';

import { TIME_ZONE_COOKIE } from '@exocortex/i18n';

/**
 * Hands this browser's time zone to the server (issue #98).
 *
 * The server formats dates in the zone of the `exocortex.tz` cookie, and
 * before this browser ever sent one it guesses. When the guess was wrong,
 * the cookie is written and the server components render again, once per
 * device and again after travelling.
 */
export function TimeZoneSync() {
  const rendered = useTimeZone();
  const router = useRouter();

  React.useEffect(() => {
    const own = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (own === rendered) return;
    const secure = window.location.protocol === 'https:' ? '; secure' : '';
    document.cookie = `${TIME_ZONE_COOKIE}=${own}; path=/; max-age=31536000; samesite=lax${secure}`;
    router.refresh();
  }, [rendered, router]);

  return null;
}
