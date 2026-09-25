#!/usr/bin/env node
/**
 * Gate: German interface text in code only ever gets less (issue #98).
 *
 * The interface moves into the message catalogues namespace by namespace,
 * over several commit series, and until it has, most screens still carry
 * their German inline. This is the ratchet under that migration: a baseline
 * per file of how many lines of German text it holds, and a build that goes
 * red when a file holds more than its baseline -- so a new screen cannot be
 * written the old way -- and when it holds fewer, so the baseline tightens in
 * the commit that earned it instead of leaving room to grow back.
 *
 *   node scripts/check-i18n-literals.mjs            check
 *   node scripts/check-i18n-literals.mjs --update   rewrite the baseline
 *
 * What counts is a line of code (comments and route paths removed) that
 * carries German: an umlaut or ß, one of the German words below as a whole
 * word, or a word with a German ending (-ung, -keit, -lich, -ieren and the
 * like). That is a measure, not a parser. The endings were added in phase 7,
 * when "Erneut versuchen" and "Hintergrundaufgabe fehlgeschlagen" turned out
 * to be German the word list alone never saw. `--update` may lower a count or drop a file,
 * and refuses to raise one: that is the point of a ratchet.
 *
 * Out of scope, with the reason, in EXEMPT below.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { fail, info, ok, step } from './lib/gate-log.mjs';
import { repoRoot } from './lib/i18n-catalog.mjs';

const baselinePath = join(repoRoot, 'scripts', 'i18n-literals-baseline.json');
const update = process.argv.includes('--update');

const SCOPE = [
  /^apps\/web\/src\/.*\.tsx?$/,
  /^packages\/ui\/src\/.*\.tsx?$/,
  // The editor's node views build their DOM by hand and run in the browser, so
  // their words are interface text as much as a React component's are.
  /^packages\/editor\/src\/.*\.tsx?$/,
];

const EXEMPT = [
  {
    pattern: /\.test\.tsx?$/,
    reason: 'Tests assert on text; they follow the default locale, German.',
  },
  {
    pattern: /^apps\/web\/src\/(components|app)\/design-system\//,
    reason:
      'Demo text of the styleguide, a developer surface. The components it shows are translated; the sentences that exercise them stay German (decided in #98).',
  },
  {
    pattern: /^packages\/editor\/src\/editor-words\.ts$/,
    reason:
      'The German default of the node views, for a server render and the tests. The browser always hands in the words of editor.nodeViews instead.',
  },
  {
    pattern: /^packages\/editor\/src\/(entity-matching|fixtures)\.ts$/,
    reason:
      'Data, not interface: the German stop words entity matching skips, and the sample documents the editor tests are built from.',
  },
];

/**
 * The small words count in both spellings: a label starts with a capital
 * ("Kein Zugriff", "Neue Regel", "Alle"), and before these were matched
 * capitalised too, about sixty such lines went uncounted.
 */
const SMALL_WORDS = [
  'und',
  'oder',
  'nicht',
  'kein',
  'keine',
  'keinen',
  'der',
  'die',
  'das',
  'dem',
  'den',
  'des',
  'ist',
  'sind',
  'wird',
  'werden',
  'wurde',
  'kann',
  'können',
  'ein',
  'eine',
  'einen',
  'einem',
  'mit',
  'für',
  'auf',
  'aus',
  'bei',
  'nach',
  'noch',
  'schon',
  'dein',
  'deine',
  'deinen',
  'dich',
  'dir',
  'du',
  'hier',
  'alle',
  'neu',
  'neue',
  'zum',
  'zur',
  'vom',
  'beim',
  'sich',
  'uns',
  'jetzt',
  'dann',
  'wenn',
  'weil',
  'dass',
  'aber',
  'auch',
  'nur',
  'wie',
  'ihr',
  'ihre',
  'sein',
  'seine',
  'erneut',
];
const NOUNS = [
  'Seite',
  'Seiten',
  'Arbeitsbereich',
  'Speichern',
  'Abbrechen',
  'Schließen',
  'Bitte',
  'Zurück',
  'Weiter',
  'Fehler',
  'Einstellungen',
  'Datei',
  'Dateien',
  'Titel',
  'Bild',
  'Bilder',
  'Suche',
  'Suchen',
  'Hilfe',
  'Ansicht',
  'Ansehen',
  'Spalte',
  'Zeile',
  'Eintrag',
  'Vorlage',
  'Freigabe',
  'Kommentar',
  'Kommentare',
  'Antwort',
  'versuchen',
  'auslesen',
  'anzeigen',
  'fehlgeschlagen',
];
/**
 * German endings, after a stem of at least three letters. English has almost no
 * word ending like this. The stem is lowercase after its first letter, so a
 * camel-cased identifier like `TypeRung` is two words and not one.
 */
const ENDINGS = [
  'ung',
  'ungen',
  'heit',
  'heiten',
  'keit',
  'keiten',
  'lich',
  'liche',
  'lichen',
  'licher',
  'ieren',
  'iert',
  'ierte',
];
const capitalised = (word) => word[0].toUpperCase() + word.slice(1);
const GERMAN = new RegExp(
  `[äöüÄÖÜß]|\\b(?:${[...SMALL_WORDS, ...SMALL_WORDS.map(capitalised), ...NOUNS].join('|')})\\b` +
    `|\\b[A-Za-z][a-z]{2,}(?:${ENDINGS.join('|')})\\b`,
);

/**
 * A route is an address, not a sentence: `/einstellungen/benachrichtigungen`
 * stays German in every locale, because a language is a property of the
 * person and never of the URL (ADR-062). A route pattern (`/arbeitsbereich/:x`)
 * and a query string (`?gruppe=ai`) are addresses too.
 */
const ROUTE_LITERAL = /(['"`])\/[\w\-/[\]${}.:?=&]*\1/g;

/**
 * The source with every comment blanked out, newlines kept, so a German
 * comment -- and most comments in `apps/web` are German -- never counts.
 * Strings and template literals are stepped over, which is what keeps the
 * `//` in a URL from starting a comment.
 */
function withoutComments(text) {
  let out = '';
  let index = 0;
  while (index < text.length) {
    const pair = text.slice(index, index + 2);
    let step;
    if (pair === '//') step = skipLineComment(text, index);
    else if (pair === '/*') step = skipBlockComment(text, index);
    else if (QUOTES.has(text[index])) step = copyString(text, index);
    else step = { kept: text[index], next: index + 1 };
    out += step.kept;
    index = step.next;
  }
  return out;
}

const QUOTES = new Set(["'", '"', '`']);

function skipLineComment(text, index) {
  const end = text.indexOf('\n', index);
  return { kept: '', next: end === -1 ? text.length : end };
}

/** A block comment keeps its newlines, so line numbers stay meaningful. */
function skipBlockComment(text, index) {
  const end = text.indexOf('*/', index + 2);
  const stop = end === -1 ? text.length : end + 2;
  return { kept: text.slice(index, stop).replace(/[^\n]/g, ''), next: stop };
}

/**
 * A string literal, kept whole. A quote or double quote ends at the line
 * break at the latest, which also contains an apostrophe in JSX prose.
 */
function copyString(text, index) {
  const quote = text[index];
  let position = index + 1;
  while (position < text.length && text[position] !== quote) {
    if (text[position] === '\\') position += 1;
    else if (quote !== '`' && text[position] === '\n') break;
    position += 1;
  }
  return { kept: text.slice(index, position + 1), next: position + 1 };
}

export function germanLines(text) {
  return withoutComments(text)
    .split('\n')
    .filter((line) => GERMAN.test(line.replace(ROUTE_LITERAL, ''))).length;
}

function trackedFiles() {
  // Untracked files too: a screen written the old way should go red before
  // its first commit, not after.
  const args = ['ls-files', '-z', '--cached', '--others', '--exclude-standard'];
  return execFileSync('git', [...args, 'apps/web/src', 'packages/ui/src', 'packages/editor/src'], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
    .split('\0')
    .filter((file) => file !== '' && SCOPE.some((pattern) => pattern.test(file)))
    .filter((file, index, all) => all.indexOf(file) === index)
    .filter((file) => !EXEMPT.some((entry) => entry.pattern.test(file)))
    .filter((file) => existsSync(join(repoRoot, file)))
    .sort();
}

step('Inline German interface text: the ratchet');

const counts = {};
for (const file of trackedFiles()) {
  const count = germanLines(readFileSync(join(repoRoot, file), 'utf8'));
  if (count > 0) counts[file] = count;
}
const baseline = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, 'utf8')) : {};

const grown = [];
const shrunk = [];
for (const [file, count] of Object.entries(counts)) {
  const allowed = baseline[file] ?? 0;
  if (count > allowed) grown.push(`${file}: ${count} lines of German, baseline ${allowed}`);
  if (count < allowed) shrunk.push(file);
}
for (const file of Object.keys(baseline)) {
  if (counts[file] === undefined) shrunk.push(file);
}

if (update) {
  // The very first baseline records the state the ratchet starts from; every
  // later one may only lower it.
  if (grown.length > 0 && existsSync(baselinePath)) {
    fail(
      'The baseline only goes down',
      grown,
      'Move the new text into packages/i18n/src/messages/de and use it through useTranslations(); then --update again.',
    );
  }
  writeFileSync(baselinePath, `${JSON.stringify(counts, null, 2)}\n`, 'utf8');
  ok(`Baseline written: ${Object.keys(counts).length} files still carry inline German.`);
  process.exit(0);
}

if (grown.length > 0) {
  fail(
    `${grown.length} file(s) gained inline German text`,
    grown,
    'Interface text goes into packages/i18n/src/messages/de and is read through useTranslations() (docs/i18n.md). German in a comment does not count.',
  );
}
if (shrunk.length > 0) {
  fail(
    `${shrunk.length} file(s) carry less inline German than the baseline allows`,
    shrunk,
    'Good. Tighten the ratchet in this commit: node scripts/check-i18n-literals.mjs --update',
  );
}

const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
info(`${Object.keys(counts).length} files, ${total} lines of inline German left to migrate.`);
ok('No file gained inline German text.');
