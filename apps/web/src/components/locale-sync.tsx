'use client';

import { useRouter } from 'next/navigation';
import { useLocale } from 'next-intl';
import * as React from 'react';

import { useSessionQuery } from '@/lib/api/session-queries';
import { writeLocaleCookie } from '@/lib/locale-cookie';

/**
 * Brings this browser to the language the account chose (issue #98).
 *
 * The server renders from the cookie and `Accept-Language`, because the
 * session is only known here. When the account has a choice and this page was
 * rendered in another language -- a new device, or a choice made in another
 * tab -- the cookie is moved and the server components render again. An
 * account without a choice changes nothing: the browser decides.
 */
export function LocaleSync() {
  const session = useSessionQuery();
  const locale = useLocale();
  const router = useRouter();
  const chosen = session.data?.user?.locale ?? null;

  React.useEffect(() => {
    if (chosen === null || chosen === locale) return;
    writeLocaleCookie(chosen);
    router.refresh();
  }, [chosen, locale, router]);

  return null;
}
