#!/usr/bin/env node
/**
 * Gate: every interface language says everything German says, in the same
 * shape (issue #98, ADR-062).
 *
 * German is the source catalogue in `packages/i18n/src/messages/de`; the
 * other locales are translated from it, mostly by `pnpm i18n:translate`. What
 * this refuses:
 *
 *   * a namespace file or a key a locale lacks, and one German does not have,
 *   * an empty string, or an object where German has text (or the reverse),
 *   * a message that does not parse as ICU, or whose arguments, argument
 *     types, rich-text tags or select options differ from the German source,
 *   * a plural that lacks a category the target language needs (`few` and
 *     `many` in Polish),
 *   * the brand written any other way than eXocortex,
 *   * a translation made from an older German text: the German changed and
 *     nobody ran the translation tool, or a hand-written translation was not
 *     confirmed again (`--accept`),
 *   * a `catalog.generated.ts` that no longer matches the message files.
 *
 * Type safety of the keys themselves is `pnpm typecheck`'s job: the German
 * catalogue is the `Messages` type next-intl checks every `t()` against.
 */

import { readFileSync } from 'node:fs';
import { relative } from 'node:path';

import { fail, info, ok, step } from './lib/gate-log.mjs';
import {
  flatten,
  generatedCatalogPath,
  generatedCatalogSource,
  keyStatus,
  namespacesOf,
  readNamespace,
  readState,
  repoRoot,
  SOURCE_LOCALE,
  supportedLocales,
} from './lib/i18n-catalog.mjs';
import { compareIcu, parseIcu } from './lib/icu.mjs';

step('Interface languages: key parity, ICU structure, translation state');

const BRAND = `eX${'ocortex'}`;
const WRONG_BRAND = new RegExp(
  `(?<![A-Za-z@/.-])E${'xocortex'}(?![A-Za-z])|(?<![A-Za-z@/.-])${'exocortex'}(?![A-Za-z.:/-])`,
  'i',
);

const locales = supportedLocales();
const namespaces = namespacesOf(SOURCE_LOCALE);
const state = readState();
const findings = [];

const source = new Map();
for (const namespace of namespaces) {
  const entries = flatten(readNamespace(SOURCE_LOCALE, namespace));
  source.set(namespace, entries);
  for (const [path, text] of entries) {
    const where = `${SOURCE_LOCALE}/${namespace}.json ${path}`;
    if (typeof text !== 'string' || text.trim() === '') {
      findings.push(`${where}: must be non-empty text`);
      continue;
    }
    try {
      parseIcu(text);
    } catch (error) {
      findings.push(`${where}: does not parse as ICU (${error.message})`);
    }
  }
}

let checked = 0;
for (const locale of locales.filter((entry) => entry !== SOURCE_LOCALE)) {
  const own = new Set(namespacesOf(locale));
  for (const extra of [...own].filter((namespace) => !namespaces.includes(namespace))) {
    findings.push(`${locale}/${extra}.json: German has no such namespace`);
  }
  for (const namespace of namespaces) {
    if (!own.has(namespace)) {
      findings.push(`${locale}/${namespace}.json: missing`);
      continue;
    }
    const target = flatten(readNamespace(locale, namespace));
    for (const path of target.keys()) {
      if (!source.get(namespace).has(path)) {
        findings.push(`${locale}/${namespace}.json ${path}: German has no such key`);
      }
    }
    for (const [path, german] of source.get(namespace)) {
      const where = `${locale}/${namespace}.json ${path}`;
      const text = target.get(path);
      checked += 1;
      if (text === undefined) {
        findings.push(`${where}: missing`);
        continue;
      }
      if (typeof text !== 'string' || text.trim() === '') {
        findings.push(`${where}: must be non-empty text`);
        continue;
      }
      for (const problem of compareIcu(german, text, locale)) findings.push(`${where}: ${problem}`);
      if (german.includes(BRAND) && !text.includes(BRAND)) {
        findings.push(`${where}: the brand is written ${BRAND}`);
      }
      if (WRONG_BRAND.test(text.replaceAll(BRAND, ''))) {
        findings.push(
          `${where}: the brand is written ${BRAND}, not "${text.match(WRONG_BRAND)[0]}"`,
        );
      }
      const status = keyStatus(german, text, state[locale]?.[`${namespace}.${path}`]);
      if (status === 'stale') {
        findings.push(`${where}: translated from an older German text`);
      } else if (status === 'review') {
        findings.push(`${where}: hand-written, and not confirmed for the current German text`);
      }
    }
  }
}

const expectedCatalog = generatedCatalogSource(locales, namespaces);
let actualCatalog = '';
try {
  actualCatalog = readFileSync(generatedCatalogPath, 'utf8');
} catch {
  // Reported below as a mismatch; a missing file is the same finding.
}
if (actualCatalog !== expectedCatalog) {
  findings.push(`${relative(repoRoot, generatedCatalogPath)}: out of date`);
}

if (findings.length > 0) {
  fail(
    `${findings.length} problem(s) in the message catalogues`,
    findings,
    'Run `pnpm i18n:translate --all` after changing German text (it fills gaps, redoes stale machine translations and regenerates the catalogue). A hand-written translation is confirmed with `--accept <locale>:<key>`.',
  );
}

info(
  `${locales.length} locales, ${namespaces.length} namespaces, ${checked} translated messages checked.`,
);
ok('Every locale says what German says, in the same shape.');
