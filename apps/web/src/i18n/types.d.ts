import { type Locale, type Messages } from '@exocortex/i18n';

/**
 * Types every `useTranslations()` and `t()` against the German catalogue,
 * which is the source every other locale is translated from. A key that
 * German does not have is a compile error (issue #98).
 */
declare module 'next-intl' {
  interface AppConfig {
    Locale: Locale;
    Messages: Messages;
  }
}
