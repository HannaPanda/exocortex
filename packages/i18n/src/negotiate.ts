import { DEFAULT_LOCALE, isLocale, type Locale, SUPPORTED_LOCALES } from '@exocortex/contracts';

interface WeightedTag {
  tag: string;
  quality: number;
  position: number;
}

/**
 * Reads an `Accept-Language` header into tags ordered by preference.
 *
 * Quality first, then the order the browser sent them in, which is what RFC
 * 9110 means by equal weights. A malformed `q` counts as absent rather than
 * zero, because a browser that writes `q=abc` still meant the language.
 */
function parseAcceptLanguage(header: string): WeightedTag[] {
  return header
    .split(',')
    .map((part, position): WeightedTag | null => {
      const [rawTag, ...parameters] = part.trim().split(';');
      const tag = rawTag?.trim() ?? '';
      if (tag === '' || tag === '*') return null;
      let quality = 1;
      for (const parameter of parameters) {
        const [name, value] = parameter.trim().split('=');
        if (name?.trim() !== 'q' || value === undefined) continue;
        const parsed = Number(value.trim());
        if (Number.isFinite(parsed)) quality = parsed;
      }
      return quality > 0 ? { tag, quality, position } : null;
    })
    .filter((entry): entry is WeightedTag => entry !== null)
    .sort((a, b) => b.quality - a.quality || a.position - b.position);
}

function baseLanguage(tag: string): string {
  return (tag.split('-')[0] ?? '').toLowerCase();
}

/**
 * The supported locale one BCP 47 tag asks for, or `null` if none fits.
 *
 * An exact match wins (`pt-BR`), then the language alone (`en-GB` is `en`,
 * `pt-PT` is `pt-BR` because that is the Portuguese this deployment speaks).
 * A region we do not have is still the language the person reads.
 */
export function matchLocale(tag: string): Locale | null {
  const lower = tag.toLowerCase();
  const exact = SUPPORTED_LOCALES.find((locale) => locale.toLowerCase() === lower);
  if (exact !== undefined) return exact;
  const base = baseLanguage(tag);
  return SUPPORTED_LOCALES.find((locale) => baseLanguage(locale) === base) ?? null;
}

/** The best supported locale for an `Accept-Language` header, or `null`. */
export function negotiateLocale(acceptLanguage: string | null | undefined): Locale | null {
  if (acceptLanguage === null || acceptLanguage === undefined) return null;
  for (const { tag } of parseAcceptLanguage(acceptLanguage)) {
    const match = matchLocale(tag);
    if (match !== null) return match;
  }
  return null;
}

export interface LocaleSources {
  /** `User.locale`: the account's own choice, `null` while it has none. */
  preference?: string | null;
  /** The locale cookie: the last answer this browser saw. */
  cookie?: string | null;
  /** The browser's `Accept-Language` header. */
  acceptLanguage?: string | null;
}

/**
 * The one resolution order (issue #98, ADR-062): the account's choice, then
 * this browser's cookie, then what the browser asks for, then German.
 *
 * Every layer is checked against the supported list rather than trusted,
 * because the cookie and the header are written by the client and a locale
 * that was removed from the deployment must not survive in a stale row either.
 */
export function resolveLocale(sources: LocaleSources): Locale {
  if (isLocale(sources.preference)) return sources.preference;
  if (isLocale(sources.cookie)) return sources.cookie;
  return negotiateLocale(sources.acceptLanguage) ?? DEFAULT_LOCALE;
}
