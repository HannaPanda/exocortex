/**
 * Injection tokens for the two web-research back ends.
 *
 * Their own file rather than `platform-tokens.ts`: these are not infrastructure
 * the whole application shares, they are two optional HTTP clients one module
 * uses. Both providers resolve to `null` when their base URL is unset, which is
 * how "this deployment has no browser" stays a value instead of a crash.
 */
export const WEB_SEARCHER = Symbol('EXOCORTEX_WEB_SEARCHER');
export const WEB_FETCHER = Symbol('EXOCORTEX_WEB_FETCHER');
