'use client';

import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';

import { isLocale, LOCALE_ENDONYMS, SUPPORTED_LOCALES } from '@exocortex/i18n';
import {
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@exocortex/ui';

import { writeLocaleCookie } from '@/lib/locale-cookie';

/**
 * The interface language for somebody who is not signed in (issue #98,
 * ADR-062).
 *
 * There is no account to store the choice on, so it goes into the cookie
 * only, and the server components render again in the new language. After
 * signing in, `LocaleSync` moves the cookie to the account's own choice if
 * the account has one; otherwise this choice stays.
 */
export function AuthLanguagePicker() {
  const t = useTranslations('auth.languagePicker');
  const router = useRouter();
  const current = useLocale();
  const selected = isLocale(current) ? current : 'de';

  const change = (value: string | null) => {
    if (value === null || !isLocale(value) || value === selected) return;
    writeLocaleCookie(value);
    router.refresh();
  };

  return (
    <div className="flex items-center gap-2">
      <Label htmlFor="auth-language" className="text-xs font-normal text-muted-foreground">
        {t('label')}
      </Label>
      <Select value={selected} onValueChange={change}>
        <SelectTrigger
          id="auth-language"
          size="sm"
          className="w-40 text-xs"
          data-testid="auth-language"
        >
          <SelectValue>{() => LOCALE_ENDONYMS[selected]}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {SUPPORTED_LOCALES.map((option) => (
            <SelectItem key={option} value={option} lang={option}>
              {LOCALE_ENDONYMS[option]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
