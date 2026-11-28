/**
 * Shared text-formatting helpers for tool results. Every tool that can return
 * an unbounded amount of text (a whole page, a hundred database rows) must cap
 * its `text` output — an uncapped tool result is how a tool loop eats its own
 * context.
 */

import {
  type AttachmentTextMap,
  type AttachmentTextMapEntry,
  type AttachmentTextRange,
  type DocumentMapDto,
  type DocumentMapEntryDto,
} from '@exocortex/contracts';

const TRUNCATION_NOTE = '… (gekürzt)';

/**
 * The budget a page read answers within before it answers with a map instead
 * (issue #118).
 *
 * Roughly three quarters of the smallest tool-result cap in the system, so a
 * page that passes it here is not cut somewhere downstream. Ninety-seven
 * percent of the pages in a real workspace are below it and are answered with
 * their text, unchanged.
 */
export const PAGE_CONTENT_BUDGET_CHARS = 10_000;

/** Entries a map lists before it merges neighbours instead of growing. */
export const PAGE_MAP_MAX_ENTRIES = 40;

/** `12345` as `12.345`, because a size is read by a person as often as by a model. */
export function groupDigits(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

/**
 * A cut that states its own size.
 *
 * Reached only where there is nothing left to divide: a single block bigger
 * than the budget. A reader that is told "gekürzt" and nothing else cannot
 * tell that from a block that ends there, and goes looking for the rest.
 */
export function truncateWithSize(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return (
    `${text.slice(0, maxLength)}\n\n… gekürzt: ${groupDigits(maxLength)} von ` +
    `${groupDigits(text.length)} Zeichen stehen hier. Dieser Teil ist ein einzelner Block und ` +
    'lässt sich nicht weiter unterteilen; der Rest ist über dieses Werkzeug nicht erreichbar.'
  );
}

/**
 * Where a window inside a list sits, in words (issue #274).
 *
 * The map carries positions, not a sentence; the path alternates the block
 * that is a list and the point opened inside it, read here from the inside
 * out: "Punkte 3 bis 7 der Liste in Block 2 in Punkt 28 der Liste in Block 4".
 */
function locationLabel(location: NonNullable<DocumentMapEntryDto['location']>): string {
  const { path, points, first, last } = location;
  const span = points
    ? first === last
      ? `Punkt ${first}`
      : `Punkte ${first} bis ${last}`
    : `Blöcke ${first} bis ${last}`;
  const containers: string[] = [];
  for (let index = path.length - 1; index >= 0; index -= 1) {
    containers.push(
      index % 2 === 0 ? `der Liste in Block ${path[index]}` : `in Punkt ${path[index]}`,
    );
  }
  return [span, ...containers].join(' ');
}

function renderEntry(entry: DocumentMapEntryDto): string {
  const address =
    entry.fromBlockId === null
      ? '(ohne Blockkennung, nicht einzeln lesbar)'
      : entry.toBlockId === null
        ? `^${entry.fromBlockId}`
        : `^${entry.fromBlockId} bis ^${entry.toBlockId}`;
  const kind = entry.level === null ? '' : `H${entry.level} `;
  const size = `${groupDigits(entry.chars)} Zeichen, ${groupDigits(entry.blocks)} Blöcke`;
  const title =
    entry.location === null
      ? entry.title
      : `${locationLabel(entry.location)}${entry.title.length > 0 ? `: ${entry.title}` : ''}`;
  return `- ${kind}${title} — ${address} (${size})`;
}

/**
 * A page, or a part of one, rendered as its structure instead of its text.
 *
 * The wording matters as much as the numbers. It must not read like the
 * beginning of the page, because a reader that believes it has the beginning
 * reads on; it has to read like a table of contents, so the next call is a
 * choice and not a continuation (issue #118).
 */
export function renderDocumentMap(map: DocumentMapDto, lead: string): string {
  const size = `${groupDigits(map.totalChars)} Zeichen, ${groupDigits(map.totalBlocks)} Blöcke`;
  const how =
    map.mode === 'sections'
      ? 'Lies einen Abschnitt mit exo_page_block_read (blockId).'
      : 'Dieser Teil hat keine Überschriften. Lies ein Fenster mit exo_page_block_read ' +
        '(blockId und toBlockId).';
  const coarse = map.coarsened
    ? ' Benachbarte Teile sind hier zusammengefasst; ein Aufruf auf einen davon zeigt ihn feiner.'
    : '';
  const entries =
    map.entries.length === 0
      ? '(keine adressierbaren Teile)'
      : map.entries.map(renderEntry).join('\n');
  return `${lead} (${size}). Kein Textauszug, sondern die Gliederung. ${how}${coarse}\n\n${entries}`;
}

/** An attachment map entry's address, in the words of the tool's own parameters. */
function attachmentAddress(entry: AttachmentTextMapEntry, byPage: boolean): string {
  if (byPage && entry.fromPage !== null && entry.toPage !== null) {
    return entry.fromPage === entry.toPage
      ? `fromPage ${entry.fromPage}`
      : `fromPage ${entry.fromPage}, toPage ${entry.toPage}`;
  }
  return `fromChar ${entry.fromChar}, toChar ${entry.toChar}`;
}

function renderAttachmentEntry(entry: AttachmentTextMapEntry, byPage: boolean): string {
  const where =
    entry.kind === 'pages'
      ? entry.fromPage === entry.toPage
        ? `Seite ${entry.fromPage}`
        : `Seiten ${entry.fromPage} bis ${entry.toPage}`
      : entry.kind === 'section'
        ? entry.level === null
          ? 'Vorspann'
          : `H${entry.level}`
        : 'Absätze';
  const onPages =
    entry.kind !== 'pages' && entry.fromPage !== null && entry.toPage !== null
      ? entry.fromPage === entry.toPage
        ? `, Seite ${entry.fromPage}`
        : `, Seiten ${entry.fromPage} bis ${entry.toPage}`
      : '';
  const merged = entry.parts > 1 ? `, ${entry.parts} Teile zusammengefasst` : '';
  const title = entry.title.length === 0 ? '(ohne Text)' : `„${entry.title}“`;
  return (
    `- ${where}: ${title} — ${attachmentAddress(entry, byPage)} ` +
    `(${groupDigits(entry.chars)} Zeichen${onPages}${merged})`
  );
}

/**
 * A long attachment text rendered as its outline instead of its text
 * (issue #133, ADR-101). Worded like a page map for the same reason: it must
 * read as a table of contents, so the next call is a choice and not a
 * continuation. The entries' titles are the document's own first lines, which
 * is why the tool fences this answer like the text itself.
 */
export function renderAttachmentTextMap(
  map: AttachmentTextMap,
  context: {
    filename: string;
    range: AttachmentTextRange | null;
    totalChars: number | null;
    pages: number | null;
  },
): string {
  const { range, totalChars, pages } = context;
  const whole =
    range === null || totalChars === null || (range.fromChar === 0 && range.toChar === totalChars);
  const size = range === null ? '' : `${groupDigits(range.toChar - range.fromChar)} Zeichen`;
  const pageCount = whole && pages !== null ? `, ${pages} Seiten` : '';
  const part = whole
    ? `${context.filename} ist lang (${size}${pageCount})`
    : `Dieser Teil von ${context.filename} ist zu lang für eine Antwort (${size}` +
      (range.fromPage !== null && range.toPage !== null
        ? range.fromPage === range.toPage
          ? `, Seite ${range.fromPage})`
          : `, Seiten ${range.fromPage} bis ${range.toPage})`
        : ')');
  const byPage = map.mode === 'pages';
  const how = byPage
    ? 'Lies einen Bereich mit exo_attachment_read_text und fromPage/toPage.'
    : map.mode === 'sections'
      ? 'Lies einen Abschnitt mit exo_attachment_read_text und fromChar/toChar.'
      : 'Dieser Teil hat keine Überschriften. Lies ein Fenster mit exo_attachment_read_text und ' +
        'fromChar/toChar.';
  const coarse = map.coarsened
    ? ' Benachbarte Teile sind hier zusammengefasst; ein Aufruf auf einen davon zeigt ihn feiner.'
    : '';
  const entries =
    map.entries.length === 0
      ? '(keine adressierbaren Teile)'
      : map.entries.map((entry) => renderAttachmentEntry(entry, byPage)).join('\n');
  const find =
    ' Jede Zeile zeigt nur den Anfang ihres Teils; ein bestimmtes Wort findet exo_attachment_read_text ' +
    'mit find.';
  return `${part}. Kein Textauszug, sondern die Gliederung. ${how}${coarse}${find}\n\n${entries}`;
}

/**
 * The line every page read ends with, and the only place a write's
 * `expectedYjsUpdatedAt` may come from (issue #120).
 *
 * It is written into the text rather than only into `data`, because the model
 * sees the text and nothing else: the worker hands `result.text` to the loop
 * and drops the structured payload. A read that carried the revision only in
 * `data` is a read that does not carry it.
 *
 * Named `Revision` and not `yjsUpdatedAt` in the prose, with the field name
 * beside it, so the value cannot be mistaken for the `updatedAt` in the
 * frontmatter above it. That mistake is what this line exists for: every
 * read-then-write in the first model benchmark sent the frontmatter timestamp
 * and was refused.
 */
export function revisionLine(yjsUpdatedAt: string): string {
  return `Revision dieser Seite: ${yjsUpdatedAt} (als expectedYjsUpdatedAt beim Schreiben angeben).`;
}

/** Truncates `text` at `maxLength` characters, appending a German note. */
export function truncateText(
  text: string,
  maxLength: number,
): { text: string; truncated: boolean } {
  if (text.length <= maxLength) {
    return { text, truncated: false };
  }
  return { text: `${text.slice(0, maxLength)}${TRUNCATION_NOTE}`, truncated: true };
}

/** Renders a Markdown table from column headers and row cells. */
export function renderMarkdownTable(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
): string {
  const escape = (cell: string): string => cell.replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const headerLine = `| ${headers.map(escape).join(' | ')} |`;
  const separatorLine = `| ${headers.map(() => '---').join(' | ')} |`;
  const rowLines = rows.map((row) => `| ${row.map(escape).join(' | ')} |`);
  return [headerLine, separatorLine, ...rowLines].join('\n');
}
