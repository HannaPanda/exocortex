/**
 * Shared text-formatting helpers for tool results. Every tool that can return
 * an unbounded amount of text (a whole page, a hundred database rows) must cap
 * its `text` output — an uncapped tool result is how a tool loop eats its own
 * context.
 */

const TRUNCATION_NOTE = '… (gekürzt)';

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
