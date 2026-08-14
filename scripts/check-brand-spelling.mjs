#!/usr/bin/env node
/**
 * Gate: the brand is written `eXocortex` wherever a human reads it.
 *
 * CLAUDE.md rule 10. The name has a small `e` and a capital `X`, and the plain
 * `Exocortex` is the spelling that creeps back in: it is what autocorrect, muscle
 * memory and every editor's sentence-casing produce. One wrong spelling in a
 * heading or a seeded page is not a bug anyone files, so nothing ever catches it.
 *
 * What is in scope, deliberately narrowly:
 *
 *   * string literals in TypeScript and JavaScript -- UI text, page titles,
 *     mail headers, seeded content,
 *   * Markdown prose, which rule 10 names as documentation,
 *   * `description` fields in `package.json`.
 *
 * What is not: code comments. Rule 10 lists the surfaces a *user* meets, and a
 * comment is developer prose. Including them would put two thirds of the
 * findings in files no reader of the product ever opens, and a gate whose
 * findings are mostly noise gets skipped. Identifiers are out of scope for the
 * same rule, and fall out of the matching anyway: `ExocortexApiClient` has
 * letters on both sides of the name and never matches.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { fail, info, ok, step } from './lib/gate-log.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

// Assembled rather than written out, so this file does not report itself and
// then need an exemption for the exemption.
const WRONG = `E${'xocortex'}`;
const RIGHT = `eX${'ocortex'}`;
// Standalone only: letters on either side mean an identifier, which rule 10
// leaves alone. A leading `@` or `/` means a package name or a path.
//
// The second lookbehind is for `'…\nExocortex…'`: inside a string literal the
// escape puts an `n` immediately before the name, which the first lookbehind
// would read as the middle of a word. That is a sentence start in the rendered
// text, and the most common one -- a heading followed by a paragraph.
const OCCURRENCE = new RegExp(`(?:(?<![A-Za-z@/])|(?<=\\\\[nrt]))${WRONG}(?![A-Za-z])`);

/**
 * Places the plain spelling is correct.
 *
 * A line matching any of these substrings is skipped. Each one is a technical
 * identifier that a protocol, not a person, reads.
 */
const EXEMPT = [
  {
    marker: '-//' + WRONG + '//',
    reason: 'iCalendar PRODID. A product identifier in an .ics file, parsed by other calendars.',
  },
];

const CODE = /\.(ts|tsx|mts|cts|js|mjs|cjs)$/;

function candidateFiles() {
  // `--others --exclude-standard` adds files that are not committed yet but are
  // not ignored either. Without it the gate would pass on a file written a
  // minute ago, which is exactly when someone wants to hear about it.
  const output = execFileSync(
    'git',
    [
      'ls-files',
      '--cached',
      '--others',
      '--exclude-standard',
      '*.ts',
      '*.tsx',
      '*.mts',
      '*.cts',
      '*.js',
      '*.mjs',
      '*.cjs',
      '*.md',
      '*.json',
    ],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  return output
    .split('\n')
    .filter((line) => line.length > 0)
    .filter((line) => !line.includes('node_modules/'));
}

/**
 * Blanks out what is not human-readable text, keeping line numbers intact.
 *
 * For code that is comments; for Markdown it is fenced and inline code, where
 * the name may legitimately appear as a command or a package. Replacing rather
 * than deleting keeps the reported line number the real one.
 */
function maskNonProse(source, file) {
  if (CODE.test(file)) {
    return source
      .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ' '))
      .replace(/\/\/[^\n]*/g, (match) => ' '.repeat(match.length));
  }
  if (file.endsWith('.md')) {
    return source
      .replace(/```[\s\S]*?```/g, (match) => match.replace(/[^\n]/g, ' '))
      .replace(/`[^`\n]*`/g, (match) => ' '.repeat(match.length));
  }
  return source;
}

/** In package.json only the human-facing fields count; the rest is identifiers. */
function isRelevantJsonLine(line) {
  return /^\s*"(description|title|name|summary)"\s*:/.test(line);
}

step(`Brand spelling (${RIGHT} in human-readable text)`);

const findings = [];
let scanned = 0;

for (const file of candidateFiles()) {
  const source = readFileSync(join(repoRoot, file), 'utf8');
  if (!source.includes(WRONG)) continue;
  scanned += 1;
  const masked = maskNonProse(source, file);
  for (const [index, line] of masked.split('\n').entries()) {
    if (!OCCURRENCE.test(line)) continue;
    if (file.endsWith('.json') && !isRelevantJsonLine(line)) continue;
    if (EXEMPT.some((entry) => line.includes(entry.marker))) continue;
    findings.push(`${file}:${index + 1}: ${line.trim().slice(0, 100)}`);
  }
}

if (findings.length > 0) {
  fail(
    `${findings.length} place(s) spell the brand ${WRONG} where a human reads it`,
    findings,
    `Write ${RIGHT} — small e, capital X — including at the start of a sentence. Technical identifiers (the @exocortex/* packages, EXOCORTEX_* variables, the domain, the systemd units) keep the lowercase form and are not what this gate matches.`,
  );
}

info(`${scanned} file(s) mention the name`);
ok(`The brand is written ${RIGHT} everywhere a human reads it.`);
