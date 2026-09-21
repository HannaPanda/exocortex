/**
 * Shared text-formatting helpers for tool results. Every tool that can return
 * an unbounded amount of text (a whole page, a hundred database rows) must cap
 * its `text` output — an uncapped tool result is how a tool loop eats its own
 * context.
 */

import { type DocumentMapDto, type DocumentMapEntryDto } from '@exocortex/contracts';

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
function groupDigits(value: number): string {
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

function renderEntry(entry: DocumentMapEntryDto): string {
  const address =
    entry.fromBlockId === null
      ? '(ohne Blockkennung, nicht einzeln lesbar)'
      : entry.toBlockId === null
        ? `^${entry.fromBlockId}`
        : `^${entry.fromBlockId} bis ^${entry.toBlockId}`;
  const kind = entry.level === null ? '' : `H${entry.level} `;
  const size = `${groupDigits(entry.chars)} Zeichen, ${groupDigits(entry.blocks)} Blöcke`;
  return `- ${kind}${entry.title} — ${address} (${size})`;
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
