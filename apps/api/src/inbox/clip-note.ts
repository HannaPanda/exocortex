import type { ClipRequest, WebFetchResponse } from '@exocortex/contracts';

import { shortenTitle, titleFromUrl } from './capture-note';

/**
 * The page a clip turns into (issue #72).
 *
 * The rules here are the ones a reader notices when they are broken:
 * provenance stands at the top rather than the bottom, because a clipped
 * article is long and a source line under twenty thousand characters is a
 * source line nobody reads; the selection is a quote, because it is somebody
 * else's sentence; and the fetched text is separated from both by a rule, so
 * it is visible where this deployment's words end and the web's begin.
 */
export interface ClipNote {
  title: string;
  markdown: string;
}

/**
 * How much fetched article a clip keeps. The capture path takes 100000
 * characters and the selection may already use 20000 of them, so this leaves
 * room rather than spending the whole budget.
 */
export const MAX_ARTICLE_CHARS = 60_000;

export function buildClipNote(input: {
  request: ClipRequest;
  page: WebFetchResponse | null;
  at: Date;
}): ClipNote {
  const title = clipTitle(input.request, input.page);
  const parts = [provenance(input.request.url, input.page, input.at)];

  const selection = input.request.selection?.trim();
  if (selection !== undefined && selection.length > 0) parts.push(quote(selection));

  const article = articleText(input.page, title);
  if (article.length > 0) parts.push('---', article);

  return { title, markdown: parts.join('\n\n') };
}

function clipTitle(request: ClipRequest, page: WebFetchResponse | null): string {
  const explicit = request.title?.trim();
  if (explicit !== undefined && explicit.length > 0) return shortenTitle(explicit);

  const fetched = page?.title?.trim();
  if (fetched !== undefined && fetched.length > 0) return shortenTitle(fetched);

  return shortenTitle(titleFromUrl(request.url) ?? request.url);
}

function provenance(url: string, page: WebFetchResponse | null, at: Date): string {
  const label = titleFromUrl(url) ?? url;
  const line = `Quelle: [${label}](${url}) (erfasst am ${stamp(at)})`;

  // A redirect means the text came from somewhere other than where the person
  // aimed, and on a page they will read months from now that difference is the
  // whole story of where a quote actually stands.
  if (page !== null && page.url !== url) return `${line}\n\nGelesen von: ${page.url}`;
  return line;
}

function stamp(at: Date): string {
  const two = (value: number): string => String(value).padStart(2, '0');
  return (
    `${two(at.getDate())}.${two(at.getMonth() + 1)}.${at.getFullYear()}, ` +
    `${two(at.getHours())}:${two(at.getMinutes())}`
  );
}

function quote(selection: string): string {
  return selection
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => (line.trim().length === 0 ? '>' : `> ${line.trimEnd()}`))
    .join('\n');
}

function articleText(page: WebFetchResponse | null, title: string): string {
  if (page === null) return '';
  return stripLeadingHeading(page.markdown.trim(), title);
}

/**
 * A fetched article usually opens with its own headline, and the page it lands
 * on already carries that headline as its title. Leaving both in place writes
 * the title twice, which is the one thing every other title path in this
 * repository avoids.
 */
function stripLeadingHeading(markdown: string, title: string): string {
  const match = /^#\s+(.+?)\s*(?:\n|$)/.exec(markdown);
  if (match === null) return markdown;
  if (normalize(match[1] ?? '') !== normalize(title)) return markdown;
  return markdown.slice(match[0].length).replace(/^\n+/, '');
}

function normalize(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}
