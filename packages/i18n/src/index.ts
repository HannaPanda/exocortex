/**
 * The interface languages (issue #98, ADR-062): which exist, how a request
 * is matched to one, and the message types. Safe for the browser; the
 * catalogue itself is the separate `@exocortex/i18n/catalog` entry point.
 */
export type { Messages, Namespace } from './catalog.js';
export { type LocaleSources, matchLocale, negotiateLocale, resolveLocale } from './negotiate.js';
export {
  DEFAULT_LOCALE,
  isLocale,
  type Locale,
  LOCALE_ENDONYMS,
  SUPPORTED_LOCALES,
} from '@exocortex/contracts';

/**
 * The cookie that carries the last resolved locale in this browser. The
 * `exocortex` prefix is the one every cookie of this deployment uses.
 */
export const LOCALE_COOKIE = 'exocortex.locale';
