import { getTranslations } from 'next-intl/server';

import { ExocortexWordmark } from '@exocortex/ui';

import { AuthLanguagePicker } from '@/components/auth/auth-language-picker';

/**
 * Centered layout for all authentication screens.
 *
 * The language picker sits here, below the card, because nobody is signed in
 * yet: the choice goes into the cookie only, and `LocaleSync` hands over to
 * the account's own choice once there is a session (ADR-062).
 */
export default async function AuthLayout({ children }: { children: React.ReactNode }) {
  const t = await getTranslations('auth.layout');
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-6 px-4 py-10">
      <ExocortexWordmark className="h-10" />
      <div className="w-full max-w-sm">{children}</div>
      <div className="flex max-w-sm flex-col items-center gap-3">
        <p className="text-center text-xs text-muted-foreground">{t('selfHosted')}</p>
        <AuthLanguagePicker />
      </div>
    </div>
  );
}
