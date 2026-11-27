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
 * How the AI chat's transcript moves while an answer arrives (issue #282).
 *
 * `follow` keeps the newest line in view until the reader scrolls up (issue
 * #242), and is the default. `answerStart` brings the question to the top of
 * the transcript once, when the answer starts, and then leaves the view
 * alone: the answer grows downwards out of sight and is read from its first
 * line.
 */
export const CHAT_SCROLL_MODES = ['follow', 'answerStart'] as const;
export const chatScrollModeSchema = z.enum(CHAT_SCROLL_MODES);
export type ChatScrollMode = z.infer<typeof chatScrollModeSchema>;
export const DEFAULT_CHAT_SCROLL_MODE: ChatScrollMode = 'follow';

/**
 * Where a pinned page outline sits (issue #283).
 *
 * `column` gives the list a column of the page area and the text moves aside
 * (issue #267), and is the default. `overlay` leaves the text where it is and
 * lays the list over it, covering what lies underneath where the margin is
 * too narrow to hold it.
 */
export const OUTLINE_PINNED_MODES = ['column', 'overlay'] as const;
export const outlinePinnedModeSchema = z.enum(OUTLINE_PINNED_MODES);
export type OutlinePinnedMode = z.infer<typeof outlinePinnedModeSchema>;
export const DEFAULT_OUTLINE_PINNED_MODE: OutlinePinnedMode = 'column';

/**
 * How much of the text an overlaid outline lets through (issue #283): `none`
 * is opaque, `light` and `strong` let the covered text show through, and the
 * list comes back to full strength under the pointer or the keyboard focus.
 * Only read while `outlinePinned` is `overlay`.
 */
export const OUTLINE_TRANSPARENCIES = ['none', 'light', 'strong'] as const;
export const outlineTransparencySchema = z.enum(OUTLINE_TRANSPARENCIES);
export type OutlineTransparency = z.infer<typeof outlineTransparencySchema>;
export const DEFAULT_OUTLINE_TRANSPARENCY: OutlineTransparency = 'none';

/**
 * Whether an overlaid outline steps aside for the line being written on
 * (issue #283): with the caret on a line the list covers, the list moves up
 * or down out of the way. On by default, because it only acts on a list the
 * reader already chose to lay over the text, and a hidden caret is the one
 * thing that choice should not cost. Only read while `outlinePinned` is
 * `overlay`.
 */
export const DEFAULT_OUTLINE_DODGE = true;

/**
 * Whether the outline's scale opens its list as soon as the pointer rests on
 * it, the way Notion's does, rather than on a click (issue #283). A middle
 * way between the scale and a pinned list. Off by default, which is the
 * behaviour since #194; touch and the keyboard open it as before either way.
 */
export const DEFAULT_OUTLINE_HOVER_EXPAND = false;

/**
 * How a time of day is written for this person (issue #255).
 *
 * `auto` follows the interface language, the way `Intl` writes it: German
 * 14:30, English 2:30 PM. `24h` and `12h` hold the clock whatever the
 * language, for a person who reads English with a European clock or the
 * reverse. Only the rendering: an instant is stored and exchanged as UTC, and
 * a date without a time has no clock at all.
 */
export const TIME_FORMATS = ['auto', '24h', '12h'] as const;
export const timeFormatSchema = z.enum(TIME_FORMATS);
export type TimeFormat = z.infer<typeof timeFormatSchema>;
export const DEFAULT_TIME_FORMAT: TimeFormat = 'auto';

/**
 * The account's own settings that belong to the person rather than to a
 * workspace or a device: the interface language, how a time of day is
 * written, how the AI chat scrolls and how a pinned page outline behaves.
 *
 * `locale: null` means the account never chose. It is a different answer from
 * `'de'`: an undecided account follows its browser, a decided one does not.
 */
export const userPreferencesSchema = z.object({
  locale: localeSchema.nullable(),
  chatScroll: chatScrollModeSchema,
  outlinePinned: outlinePinnedModeSchema,
  outlineTransparency: outlineTransparencySchema,
  outlineDodge: z.boolean(),
  outlineHoverExpand: z.boolean(),
  timeFormat: timeFormatSchema,
});
export type UserPreferences = z.infer<typeof userPreferencesSchema>;

/**
 * A change to some of them: a field left out stays as it is, so a client
 * that only knows the language cannot reset the scrolling or the outline,
 * and the reverse.
 * `locale: null` is not "leave it", it clears the choice.
 */
export const updateUserPreferencesRequestSchema = z
  .object({
    locale: localeSchema.nullable().optional(),
    chatScroll: chatScrollModeSchema.optional(),
    outlinePinned: outlinePinnedModeSchema.optional(),
    outlineTransparency: outlineTransparencySchema.optional(),
    outlineDodge: z.boolean().optional(),
    outlineHoverExpand: z.boolean().optional(),
    timeFormat: timeFormatSchema.optional(),
  })
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: 'At least one field must be provided',
  });
export type UpdateUserPreferencesRequest = z.infer<typeof updateUserPreferencesRequestSchema>;
