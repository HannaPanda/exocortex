/**
 * Pure address analysis for the `href` a link mark or a page-link block carries.
 *
 * No `fetch`, no DOM, no routes: `apps/web` decides what to *do* with a target
 * (navigate, resolve a `wiki:` title, open a new tab), this module only decides
 * *what kind* of address it is looking at. Keeping that split here, in a leaf
 * package with jsdom-backed tests, is what makes it testable without a browser.
 */

export type LinkTarget =
  | { kind: 'wiki'; title: string }
  | { kind: 'external'; url: string }
  | { kind: 'mailto'; url: string }
  | { kind: 'attachment'; path: string } // /api/…
  | { kind: 'route'; path: string } // /arbeitsbereich/…
  | { kind: 'anchor'; blockId: string } // #blockId
  | { kind: 'unknown' };

// `wiki:` and `wiki://` both occur: the Tiptap Link extension is configured
// with `{ scheme: 'wiki', optionalSlashes: true }`.
const WIKI_SCHEME_PATTERN = /^wiki:\/{0,2}/i;

function decodeSafely(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    // Not valid percent-encoding: fall back to the raw value rather than throw.
    return value;
  }
}

/** Trims and collapses internal whitespace runs to a single space. */
export function normalizeWikiTitle(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ');
}

/**
 * Classifies an `href`. Anything not explicitly recognized is `unknown` — the
 * security barrier that keeps `javascript:`, `data:` and similar schemes from
 * ever reaching `window.open` or `window.location`.
 */
export function parseLinkHref(href: string | null | undefined): LinkTarget {
  if (href == null) return { kind: 'unknown' };
  const trimmed = href.trim();
  if (trimmed.length === 0) return { kind: 'unknown' };

  const wikiMatch = WIKI_SCHEME_PATTERN.exec(trimmed);
  if (wikiMatch !== null) {
    const rest = trimmed.slice(wikiMatch[0].length);
    const title = normalizeWikiTitle(decodeSafely(rest));
    return title.length > 0 ? { kind: 'wiki', title } : { kind: 'unknown' };
  }

  const lower = trimmed.toLowerCase();
  if (lower.startsWith('http://') || lower.startsWith('https://')) {
    return { kind: 'external', url: trimmed };
  }
  if (lower.startsWith('mailto:')) {
    return { kind: 'mailto', url: trimmed };
  }
  // Protocol-relative: resolves against whatever host loads the page, so it
  // is external, not an in-app route. Must be checked before the plain `/…`
  // case below.
  if (trimmed.startsWith('//')) {
    return { kind: 'external', url: trimmed };
  }
  if (trimmed.startsWith('/api/')) {
    return { kind: 'attachment', path: trimmed };
  }
  if (trimmed.startsWith('/')) {
    return { kind: 'route', path: trimmed };
  }
  if (trimmed.startsWith('#')) {
    return { kind: 'anchor', blockId: trimmed.slice(1) };
  }

  return { kind: 'unknown' };
}
