import { z } from 'zod';

/**
 * Where each page of a Docling conversion begins in its Markdown (issue #133,
 * ADR-101).
 *
 * Docling's Markdown has no page boundaries of its own, and its
 * `md_page_break_placeholder` is no answer: it is written only between two
 * items on different pages, while a paragraph running from one page onto the
 * next is one item (measured on 2026-11-28: twelve pages, three placeholders).
 * The JSON beside it does know: every item carries one provenance per page it
 * touches, with the character span of that page's share of the item's text.
 *
 * So each page is placed by its first share in reading order: a short stretch
 * of that item's text, from where the page's span begins, is looked for in the
 * Markdown after the previous page's start. The Markdown escapes a few
 * characters the JSON does not (`\_`, `&amp;`), which the pattern allows for.
 * A page whose text cannot be placed (a picture alone, a table whose first cell
 * is empty, an escape this does not know) is reported as `-1` rather than
 * guessed, and the reader joins it to the page before it: "pages 4 to 5" is
 * honest where "page 4" with page 5's text in it is not.
 */

const refSchema = z.object({ $ref: z.string() });

const provSchema = z.object({
  page_no: z.number().int(),
  charspan: z.array(z.number().int()).optional(),
});

const itemSchema = z.object({
  label: z.string().optional(),
  content_layer: z.string().optional(),
  text: z.string().optional(),
  children: z.array(refSchema).optional(),
  prov: z.array(provSchema).optional(),
  data: z
    .object({
      table_cells: z.array(z.object({ text: z.string().optional() })).optional(),
    })
    .optional(),
});

/** The part of a `DoclingDocument` this reads; everything else is ignored. */
export const doclingLayoutSchema = z.object({
  body: z.object({ children: z.array(refSchema).default([]) }).optional(),
  texts: z.array(itemSchema).default([]),
  tables: z.array(itemSchema).default([]),
  pictures: z.array(itemSchema).default([]),
  groups: z.array(itemSchema).default([]),
  pages: z.record(z.string(), z.unknown()).nullable().default(null),
});
export type DoclingLayout = z.infer<typeof doclingLayoutSchema>;

type Item = z.infer<typeof itemSchema>;

/** One item's share of one page: a stretch of its text and where in the item it begins. */
interface Share {
  page: number;
  snippet: string;
  /** Offset of the share inside the item's text; 0 is the item's own start. */
  offset: number;
}

const SNIPPET_CHARS = 32;
const MIN_SNIPPET_CHARS = 6;
/** How far past the cursor an item is looked for, beyond its own offset. */
const SEARCH_WINDOW = 20_000;

function resolve(layout: DoclingLayout, ref: string): Item | null {
  const match = /^#\/(texts|tables|pictures|groups)\/(\d+)$/.exec(ref);
  if (match === null) return null;
  const list = layout[match[1] as 'texts' | 'tables' | 'pictures' | 'groups'];
  return list[Number(match[2])] ?? null;
}

/** The text an item shows in the Markdown, for the purpose of finding it there. */
function itemText(item: Item): { text: string; table: boolean } {
  if (typeof item.text === 'string') return { text: item.text, table: false };
  const cell = item.data?.table_cells?.find((entry) => (entry.text ?? '').trim().length > 0);
  return { text: cell?.text ?? '', table: true };
}

/** Every item's share of every page, in reading order, furniture left out as the Markdown leaves it out. */
function shares(layout: DoclingLayout): Share[] {
  const found: Share[] = [];
  const seen = new Set<string>();
  const walk = (refs: readonly { $ref: string }[]): void => {
    for (const { $ref } of refs) {
      if (seen.has($ref)) continue;
      seen.add($ref);
      const item = resolve(layout, $ref);
      if (item === null) continue;
      if (item.content_layer !== undefined && item.content_layer !== 'body') continue;
      const { text, table } = itemText(item);
      for (const prov of item.prov ?? []) {
        const offset = prov.charspan?.[0] ?? 0;
        const snippet = text.slice(offset, offset + SNIPPET_CHARS * 2).trim();
        if (snippet.length > 0) found.push({ page: prov.page_no, snippet, offset });
        // A table is one Markdown block found by its first cell; where its
        // later pages begin inside it cannot be told.
        if (table) break;
      }
      walk(item.children ?? []);
    }
  };
  walk(layout.body?.children ?? []);
  return found;
}

const ENTITIES: Record<string, string> = {
  '&': '(?:&|&amp;)',
  '<': '(?:<|&lt;)',
  '>': '(?:>|&gt;)',
};

/** A pattern for `snippet` as the Markdown serializer may have written it. */
function snippetPattern(snippet: string, chars: number): RegExp {
  const parts: string[] = [];
  let taken = 0;
  for (const char of snippet) {
    if (taken >= chars) break;
    if (/\s/.test(char)) {
      if (taken > 0 && parts.at(-1) !== '\\s+') parts.push('\\s+');
      continue;
    }
    taken += 1;
    // The serializer escapes some punctuation with a backslash; allow it before any.
    parts.push(`\\\\?${ENTITIES[char] ?? char.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&')}`);
  }
  if (parts.at(-1) === '\\s+') parts.pop();
  return new RegExp(parts.join(''));
}

/** Where `snippet` begins in `markdown` between `from` and `until`, or -1. */
function find(markdown: string, snippet: string, from: number, until: number): number {
  // Too short to tell one place from another ("1", "a)").
  if (snippet.replace(/\s+/g, '').length < MIN_SNIPPET_CHARS) return -1;
  const haystack = markdown.slice(from, until + SNIPPET_CHARS * 4);
  for (const chars of [SNIPPET_CHARS, MIN_SNIPPET_CHARS * 2]) {
    const match = snippetPattern(snippet, chars).exec(haystack);
    if (match !== null && from + match.index <= until) return from + match.index;
  }
  return -1;
}

/**
 * Page starts in `markdown`, entry `i` for page `i + 1`, `-1` where a page
 * could not be placed. Null when the layout names no pages at all.
 *
 * Items are found one after another, each after the one before it, so a
 * phrase that repeats (a running title, a formula) is found where it stands in
 * the order and not at its first appearance in the document. A page begins
 * where its first share was found; an item that cannot be found moves nothing.
 */
export function locateDoclingPages(markdown: string, layout: DoclingLayout): number[] | null {
  const pageNumbers = Object.keys(layout.pages ?? {})
    .map(Number)
    .filter((value) => Number.isInteger(value) && value > 0);
  if (pageNumbers.length === 0) return null;
  const pageCount = Math.max(...pageNumbers);

  const starts: number[] = Array.from({ length: pageCount }, () => -1);
  starts[0] = 0;
  let cursor = 0;
  let lastPlaced = 0;
  for (const share of shares(layout)) {
    const index = find(markdown, share.snippet, cursor, cursor + share.offset + SEARCH_WINDOW);
    if (index === -1) continue;
    cursor = index + 1;
    const page = share.page;
    if (page < 2 || page > pageCount || starts[page - 1] !== -1) continue;
    // An item's own start includes the line's Markdown prefix (`## `, `- `).
    const position =
      share.offset === 0 ? Math.max(lastPlaced + 1, markdown.lastIndexOf('\n', index) + 1) : index;
    // A page found before a page with a lower number is out of order (a float,
    // a footnote); it is left unplaced rather than allowed to run backwards.
    if (position <= lastPlaced || starts.slice(page).some((value) => value !== -1)) continue;
    starts[page - 1] = position;
    lastPlaced = position;
  }
  return starts;
}
