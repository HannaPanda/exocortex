/**
 * Reads the design tokens out of the stylesheets that define them.
 *
 * The styleguide (`/design-system`, issue #125) shows every token with its name
 * and value, and it must never become a second place where those are written
 * down: a list typed out here would be correct on the day it was typed and
 * wrong the first time somebody changed `tokens.css`. So the page parses the
 * real files at build time and shows what they say.
 *
 * Pure string handling, no filesystem: the caller hands in the CSS, which is
 * what keeps this testable against the real files and usable at build time.
 */

export interface CustomProperty {
  name: string;
  value: string;
}

export interface ParsedBlock {
  properties: CustomProperty[];
  /**
   * Names declared more than once in the block. The later declaration wins in
   * CSS, silently, which is how `--shadow-md` stood where `--shadow-lg` belonged
   * for a week (0ebed50). A non-empty list is always a defect.
   */
  duplicates: string[];
}

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * The body of the first block opened by `header` (for example `:root` or
 * `@theme inline`), without its braces. Nested braces are balanced, so a block
 * that contains another block is returned whole.
 */
function blockBody(css: string, header: string): string | null {
  const start = css.indexOf(`${header} {`);
  if (start === -1) return null;
  const open = css.indexOf('{', start);
  let depth = 1;
  let cursor = open + 1;
  while (cursor < css.length && depth > 0) {
    if (css[cursor] === '{') depth += 1;
    else if (css[cursor] === '}') depth -= 1;
    cursor += 1;
  }
  return depth === 0 ? css.slice(open + 1, cursor - 1) : null;
}

/** Every `--name: value;` declared directly in the block opened by `header`. */
export function parseCustomProperties(css: string, header: string): ParsedBlock {
  const body = blockBody(stripComments(css), header);
  if (body === null) return { properties: [], duplicates: [] };

  const byName = new Map<string, string>();
  const duplicates: string[] = [];
  // A value may span lines (a two-layer shadow does), so a declaration runs to
  // the next semicolon rather than to the end of the line.
  for (const match of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    const name = match[1] ?? '';
    const value = (match[2] ?? '').replace(/\s+/g, ' ').trim();
    if (byName.has(name) && !duplicates.includes(name)) duplicates.push(name);
    byName.set(name, value);
  }
  return {
    properties: [...byName].map(([name, value]) => ({ name, value })),
    duplicates,
  };
}

export interface TypeRung {
  /** The utility's suffix: `title` for `text-title`. */
  name: string;
  fontSize: string;
  lineHeight?: string;
  fontWeight?: string;
  letterSpacing?: string;
}

/**
 * The type ladder from the `--text-*` theme variables, in declaration order.
 *
 * Tailwind spells a rung's companions as `--text-title--line-height` and so
 * on; they are folded into the rung they belong to.
 */
export function typeLadder(theme: ParsedBlock): TypeRung[] {
  const rungs = new Map<string, TypeRung>();
  for (const { name, value } of theme.properties) {
    const match = /^--text-([a-z]+)(?:--([a-z-]+))?$/.exec(name);
    if (match === null) continue;
    const rungName = match[1] ?? '';
    const companion = match[2];
    const rung = rungs.get(rungName) ?? { name: rungName, fontSize: '' };
    if (companion === undefined) rung.fontSize = value;
    else if (companion === 'line-height') rung.lineHeight = value;
    else if (companion === 'font-weight') rung.fontWeight = value;
    else if (companion === 'letter-spacing') rung.letterSpacing = value;
    rungs.set(rungName, rung);
  }
  return [...rungs.values()].filter((rung) => rung.fontSize !== '');
}
