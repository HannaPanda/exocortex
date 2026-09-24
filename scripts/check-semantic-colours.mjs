#!/usr/bin/env node
/**
 * Gate: every colour the interface draws is a semantic token.
 *
 * CLAUDE.md rule 9, and the first of the machine-checkable rules of the design
 * system workflow (DESIGN.md §7, issue #128). A literal colour is the one kind
 * of arbitrary visual value that is objectively wrong rather than a matter of
 * taste: it cannot follow a theme, it bypasses the contrast the tokens were
 * measured for, and it is invisible in `/design-system`, which only shows the
 * tokens. Spacing and sizes are deliberately not checked here: an arbitrary
 * `w-[17rem]` can be the right answer, and a regex cannot tell which one is.
 *
 * What counts as a literal, in `apps/web/src` and `packages/ui/src`:
 *
 *   * a hex colour (`#F9AA33`, `#fff`) in code, a string or a stylesheet,
 *   * a colour function (`rgb()`, `hsl()`, `oklch()` and the rest) -- a
 *     `color-mix()` over `var()`s is a derived token and passes,
 *   * a class from Tailwind's default palette (`text-red-500`, `bg-white`),
 *     which is a colour with a name that is not ours.
 *
 * Comments are masked first, so `#127` naming an issue is not a colour. Test
 * files are out of scope: a test may assert on the computed value.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { fail, info, ok, step } from './lib/gate-log.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const SCOPE = ['apps/web/src', 'packages/ui/src'];

/**
 * The places a literal is correct. Each one is matched by file and by a
 * substring of the offending line, and each has to still match something: an
 * exemption whose line is gone is reported, so the list cannot outlive its
 * reasons.
 */
const EXEMPT = [
  {
    file: 'packages/ui/src/tokens.css',
    marker: null,
    reason: 'The token definitions themselves: the one file where a colour is written as a value.',
  },
  {
    file: 'packages/ui/src/components/logo.tsx',
    marker: 'const BRAND_',
    reason: 'Rule 9: a logo keeps its colour whatever surface it sits on.',
  },
  {
    file: 'apps/web/src/app/manifest.ts',
    marker: "_color: '#",
    reason: 'The web app manifest is read by the operating system, which knows no CSS variable.',
  },
  {
    file: 'apps/web/src/app/layout.tsx',
    marker: "themeColor: '#",
    reason:
      'The `theme-color` meta tag is read by the browser chrome, which knows no CSS variable.',
  },
  {
    file: 'apps/web/src/lib/connection-log.ts',
    marker: "'color:#",
    reason: 'A `%c` style in the developer console, which cannot resolve the page tokens.',
  },
  {
    file: 'apps/web/src/lib/connection-diagnostics.ts',
    marker: "'color:#",
    reason: 'A `%c` style in the developer console, which cannot resolve the page tokens.',
  },
];

const PALETTE =
  'red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone';
const UTILITIES =
  'bg|text|border|border-[trblxy]|ring|ring-offset|outline|fill|stroke|from|via|to|divide|decoration|shadow|accent|caret|placeholder';

const PATTERNS = [
  {
    name: 'hex colour',
    // After something that can open a value, never after a word character, so
    // `&#8203;` and an anchor like `#section` are not read as colours.
    regex:
      /(?<=^|[\s'"`[(:,=])#(?=[0-9]*[a-fA-F])(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])/,
  },
  {
    // Digits only is how German UI text names an issue ("Issue #129"), so
    // here the hex has to stand where a value starts: after a colon or an
    // equals sign, or as the first thing in a string or a bracket.
    name: 'hex colour',
    regex: /(?:(?<=[:=]\s*)|(?<=['"`[]))#(?:[0-9]{8}|[0-9]{6}|[0-9]{3,4})(?![\w-])/,
  },
  {
    name: 'colour function',
    regex: /(?<![\w-])(?:rgba?|hsla?|hwb|oklch|oklab|lab|lch|color)\(/,
  },
  {
    name: 'palette class',
    regex: new RegExp(
      `(?<![\\w-])(?:${UTILITIES})-(?:(?:${PALETTE})-\\d{2,3}|black|white)(?![\\w-])`,
    ),
  },
];

function candidateFiles() {
  // `--others --exclude-standard`, as in the other gates: a file written a
  // minute ago is exactly when somebody wants to hear about it.
  const output = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '--', ...SCOPE],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  return output
    .split('\n')
    .filter((line) => /\.(ts|tsx|css)$/.test(line))
    .filter((line) => !/\.(test|spec)\.tsx?$/.test(line));
}

/** Blanks comments out, keeping the line numbers the real ones. */
function maskComments(source, file) {
  const blank = (match) => match.replace(/[^\n]/g, ' ');
  const withoutBlocks = source.replace(/\/\*[\s\S]*?\*\//g, blank);
  if (file.endsWith('.css')) return withoutBlocks;
  // A `//` inside a string (a URL) is not a comment; the lookbehind keeps
  // `https://` intact, which is the only shape that occurs in scope.
  return withoutBlocks.replace(/(?<!:)\/\/[^\n]*/g, blank);
}

step('Semantic colours (no literal colour outside the tokens)');

const findings = [];
const used = new Set();
const files = candidateFiles();

for (const file of files) {
  const wholeFile = EXEMPT.find((entry) => entry.file === file && entry.marker === null);
  if (wholeFile) {
    used.add(wholeFile);
    continue;
  }
  const lines = maskComments(readFileSync(join(repoRoot, file), 'utf8'), file).split('\n');
  for (const [index, line] of lines.entries()) {
    const hit = PATTERNS.find((pattern) => pattern.regex.test(line));
    if (!hit) continue;
    const exemption = EXEMPT.find((entry) => entry.file === file && line.includes(entry.marker));
    if (exemption) {
      used.add(exemption);
      continue;
    }
    findings.push(`${file}:${index + 1}: ${hit.name}: ${line.trim().slice(0, 100)}`);
  }
}

const stale = EXEMPT.filter((entry) => !used.has(entry)).map(
  (entry) => `${entry.file}${entry.marker ? ` (${entry.marker})` : ''}: ${entry.reason}`,
);

if (findings.length > 0) {
  fail(
    `${findings.length} literal colour(s) outside the tokens`,
    findings,
    'Use a semantic token through its Tailwind utility (packages/ui/src/tokens.css, DESIGN.md §2). If no token fits, that is a new token: add it to tokens.css, give it a role in the styleguide token catalogue, and say why in DESIGN.md. A literal that must stay a literal goes into EXEMPT in this file, with the reason.',
  );
}

if (stale.length > 0) {
  fail(
    `${stale.length} exemption(s) no longer match anything`,
    stale,
    'Delete the entry from EXEMPT in scripts/check-semantic-colours.mjs: the literal it excused is gone.',
  );
}

info(`${files.length} file(s) in ${SCOPE.join(', ')}, ${EXEMPT.length} exemption(s)`);
ok('Every colour in the interface is a semantic token.');
