import { z } from 'zod';

/**
 * The interface languages this deployment speaks (issue #98, ADR-062).
 *
 * German comes first and is the source: every other catalogue in
 * `@exocortex/i18n` is translated from it, and a key missing anywhere falls
 * back to it. Adding a language is one entry here plus its message files --
 * `pnpm i18n:translate --locale <id>` writes those -- and nothing else in the
 * application changes.
 *
 * The ids are BCP 47 tags as `Intl` accepts them, so the same string drives the
 * message catalogue, `Intl.DateTimeFormat` and `<html lang>`.
 */
export const SUPPORTED_LOCALES = ['de', 'en', 'es', 'fr', 'it', 'nl', 'pl', 'pt-BR'] as const;

export type Locale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'de';

export const localeSchema = z.enum(SUPPORTED_LOCALES);

/**
 * Each language in its own words, because a person looking for their language
 * in a list of foreign ones reads its name in their own script, not in ours.
 * Deliberately not a message: this list must be readable whatever the
 * interface currently speaks.
 */
export const LOCALE_ENDONYMS: Record<Locale, string> = {
  de: 'Deutsch',
  en: 'English',
  es: 'Español',
  fr: 'Français',
  it: 'Italiano',
  nl: 'Nederlands',
  pl: 'Polski',
  'pt-BR': 'Português (Brasil)',
};

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

/**
 * The account's own settings that belong to the person rather than to a
 * workspace or a device. One field today; the object is the shape so the next
 * one does not need a route of its own.
 *
 * `locale: null` means the account never chose. It is a different answer from
 * `'de'`: an undecided account follows its browser, a decided one does not.
 */
export const userPreferencesSchema = z.object({
  locale: localeSchema.nullable(),
});
export type UserPreferences = z.infer<typeof userPreferencesSchema>;

export const updateUserPreferencesRequestSchema = z.object({
  locale: localeSchema.nullable(),
});
export type UpdateUserPreferencesRequest = z.infer<typeof updateUserPreferencesRequestSchema>;
