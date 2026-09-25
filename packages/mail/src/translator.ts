import { type Locale } from '@exocortex/contracts';
import { serverTranslator } from '@exocortex/i18n/catalog';

/**
 * The words of a mail, in the reader's language (issue #98, ADR-062).
 *
 * Every template gets one of these rather than a locale and a lookup of its
 * own, so the only way a template can say something is through the `mail`
 * namespace of the catalogue -- which is German at the source and translated
 * from there like every other screen.
 */
export type MailTranslator = ReturnType<typeof serverTranslator<'mail'>>;

/** What a template needs to speak: the words, and the locale to format dates in. */
export interface MailLanguage {
  locale: Locale;
  t: MailTranslator;
}

export function mailLanguage(locale: Locale): MailLanguage {
  return { locale, t: serverTranslator(locale, 'mail') };
}

/** A calendar day in the reader's words, e.g. „1. Oktober 2026“ or "October 1, 2026". */
export function formatDay(language: MailLanguage, value: Date): string {
  return new Intl.DateTimeFormat(language.locale, { dateStyle: 'long' }).format(value);
}
