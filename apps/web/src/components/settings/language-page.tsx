'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import * as React from 'react';

import {
  isLocale,
  type Locale,
  LOCALE_ENDONYMS,
  negotiateLocale,
  SUPPORTED_LOCALES,
} from '@exocortex/i18n';
import {
  Alert,
  AlertDescription,
  AppPage,
  ErrorState,
  Label,
  LoadingState,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@exocortex/ui';

import { useSetUserPreferences, useUserPreferences } from '@/lib/api/preferences-queries';
import { clearLocaleCookie, writeLocaleCookie } from '@/lib/locale-cookie';

/** The select's value for "no choice of my own". Not a locale, never sent. */
const FOLLOW_BROWSER = 'browser';

/** What this browser asks for, in its own words, for the "follow" hint. */
function browserLanguageName(): string {
  const negotiated = negotiateLocale(navigator.languages.join(','));
  return LOCALE_ENDONYMS[negotiated ?? 'de'];
}

/** The browser's languages only change with a restart; nothing to listen to. */
const noSubscription = () => () => {};

/**
 * The interface language of this account (issue #98, ADR-062).
 *
 * One select rather than a list of radio buttons: nine entries are a scan,
 * and each language is named in its own words so a person who landed in the
 * wrong one still finds theirs. Saving moves the cookie at once and renders
 * the server components again, so the page answers in the new language
 * without a reload.
 */
export function LanguagePage() {
  const t = useTranslations('settings.language');
  const router = useRouter();
  const query = useUserPreferences();
  const save = useSetUserPreferences();
  const [failed, setFailed] = React.useState(false);
  // German on the server, the browser's own answer after hydration.
  const browserName = React.useSyncExternalStore(
    noSubscription,
    browserLanguageName,
    () => LOCALE_ENDONYMS.de,
  );

  const change = (value: string | null) => {
    if (value === null) return;
    const next: Locale | null = isLocale(value) ? value : null;
    setFailed(false);
    save.mutate(
      { locale: next },
      {
        onSuccess: () => {
          if (next === null) clearLocaleCookie();
          else writeLocaleCookie(next);
          router.refresh();
        },
        onError: () => setFailed(true),
      },
    );
  };

  const current = query.data?.locale ?? null;
  const selected = current ?? FOLLOW_BROWSER;
  const labelOf = (value: string) =>
    isLocale(value) ? LOCALE_ENDONYMS[value] : t('followBrowser');

  return (
    <AppPage maxWidth="max-w-3xl" className="flex flex-col gap-6">
      <div>
        <h1 className="exocortex-page-title">{t('title')}</h1>
        <p className="mt-1 max-w-measure text-sm text-muted-foreground">{t('intro')}</p>
      </div>

      {failed ? (
        <Alert variant="destructive">
          <AlertDescription>{t('saveFailed')}</AlertDescription>
        </Alert>
      ) : null}

      {query.isPending ? (
        <LoadingState label={t('loading')} variant="skeleton" rows={1} />
      ) : query.isError ? (
        <ErrorState title={t('loadError')} onRetry={() => void query.refetch()} />
      ) : (
        <div className="flex flex-col gap-2">
          <Label htmlFor="interface-language">{t('legend')}</Label>
          <Select value={selected} disabled={save.isPending} onValueChange={change}>
            <SelectTrigger
              id="interface-language"
              className="w-full sm:w-72"
              data-testid="interface-language"
            >
              <SelectValue>{() => labelOf(selected)}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={FOLLOW_BROWSER}>{t('followBrowser')}</SelectItem>
              {SUPPORTED_LOCALES.map((option) => (
                <SelectItem key={option} value={option} lang={option}>
                  {LOCALE_ENDONYMS[option]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {current === null ? (
            <p className="max-w-measure text-xs text-muted-foreground">
              {t('followBrowserHint', { browser: browserName })}
            </p>
          ) : null}
        </div>
      )}
    </AppPage>
  );
}
