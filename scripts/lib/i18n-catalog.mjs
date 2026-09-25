/**
 * Reading and writing the message catalogues in `packages/i18n` (issue #98).
 *
 * Shared by the i18n gate, the catalogue generator and the translation tool,
 * so the three agree on what a key is, which locales exist and what "this
 * translation still belongs to its German source" means. Dependency-free like
 * every gate helper.
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const packageDir = join(repoRoot, 'packages', 'i18n');
export const messagesDir = join(packageDir, 'src', 'messages');
export const statePath = join(packageDir, 'translation-state.json');
export const glossaryPath = join(packageDir, 'glossary.json');
export const contextDir = join(packageDir, 'context');
export const generatedCatalogPath = join(packageDir, 'src', 'catalog.generated.ts');

export const SOURCE_LOCALE = 'de';

/**
 * The supported locales, read out of the contract rather than repeated here,
 * so adding a language is one edit in `packages/contracts/src/locale.ts`.
 */
export function supportedLocales() {
  const source = readFileSync(join(repoRoot, 'packages', 'contracts', 'src', 'locale.ts'), 'utf8');
  const match = source.match(/SUPPORTED_LOCALES\s*=\s*\[([^\]]*)\]/);
  if (match === null)
    throw new Error('SUPPORTED_LOCALES not found in packages/contracts/src/locale.ts');
  const locales = [...match[1].matchAll(/'([^']+)'/g)].map((entry) => entry[1]);
  if (locales[0] !== SOURCE_LOCALE) {
    throw new Error(`SUPPORTED_LOCALES must start with the source locale "${SOURCE_LOCALE}"`);
  }
  return locales;
}

/** Namespace names of one locale, from its JSON files, sorted. */
export function namespacesOf(locale) {
  const dir = join(messagesDir, locale);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith('.json'))
    .map((file) => file.slice(0, -'.json'.length))
    .sort();
}

export function namespacePath(locale, namespace) {
  return join(messagesDir, locale, `${namespace}.json`);
}

/** One namespace file as an object, or `null` when the file does not exist. */
export function readNamespace(locale, namespace) {
  const path = namespacePath(locale, namespace);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}

/**
 * Flattens a namespace object into `path -> value` in document order.
 * An object leaf and a string leaf at the same path are different shapes, and
 * the gate says so rather than comparing them.
 */
export function flatten(value, prefix = '', into = new Map()) {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) {
      flatten(child, prefix === '' ? key : `${prefix}.${key}`, into);
    }
    return into;
  }
  into.set(prefix, value);
  return into;
}

/** The inverse of `flatten`, keeping the order of `entries`. */
export function unflatten(entries) {
  const root = {};
  for (const [path, value] of entries) {
    const parts = path.split('.');
    let node = root;
    for (const part of parts.slice(0, -1)) {
      node[part] ??= {};
      node = node[part];
    }
    node[parts.at(-1)] = value;
  }
  return root;
}

/** Stable JSON: two spaces, a trailing newline, the key order it was given. */
export function formatJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** Short content hash: what the state file records instead of the text. */
export function hashText(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/**
 * The translation state: per locale and `namespace.path`, the hash of the
 * German text a translation was made from (`source`) and, while nobody has
 * edited it by hand, the hash of what the tool wrote (`output`). An entry
 * without `output` is a translation a person wrote or accepted.
 */
export function readState() {
  if (!existsSync(statePath)) return {};
  return JSON.parse(readFileSync(statePath, 'utf8'));
}

/** State with locales and keys sorted, so the file diffs line by line. */
export function formatState(state) {
  const sorted = {};
  for (const locale of Object.keys(state).sort()) {
    sorted[locale] = {};
    for (const key of Object.keys(state[locale]).sort()) sorted[locale][key] = state[locale][key];
  }
  return formatJson(sorted);
}

/**
 * Where one translated key stands against its German source.
 *
 *   current   translated from today's German text
 *   missing   no translation at all
 *   stale     machine translation of an older German text; the tool redoes it
 *   review    hand-written or hand-corrected, and the German changed since;
 *             nobody overwrites it without being asked
 */
export function keyStatus(sourceText, targetText, entry) {
  if (targetText === undefined) return 'missing';
  if (entry !== undefined && entry.source === hashText(sourceText)) return 'current';
  if (entry?.output !== undefined && entry.output === hashText(targetText)) return 'stale';
  return 'review';
}

function identifier(locale, namespace) {
  return `${locale.replace(/[^A-Za-z0-9]/g, '_')}_${namespace.replace(/[^A-Za-z0-9]/g, '_')}`;
}

/**
 * The source of `catalog.generated.ts`: one static import per file, because
 * a bundler has to see every JSON file to ship it, and a loop over the
 * directory at run time would find nothing inside `.next/`.
 */
export function generatedCatalogSource(locales, namespaces) {
  const lines = [
    '// Generated by `node scripts/i18n/catalog.mjs` from src/messages. Do not edit:',
    '// the i18n gate fails when this file no longer matches the message files.',
    '',
  ];
  for (const locale of locales) {
    for (const namespace of namespaces) {
      lines.push(
        `import ${identifier(locale, namespace)} from './messages/${locale}/${namespace}.json';`,
      );
    }
  }
  lines.push('', `export const NAMESPACES = ${JSON.stringify(namespaces)} as const;`, '');
  lines.push('export const CATALOG = {');
  for (const locale of locales) {
    lines.push(`  '${locale}': {`);
    for (const namespace of namespaces) {
      lines.push(`    ${JSON.stringify(namespace)}: ${identifier(locale, namespace)},`);
    }
    lines.push('  },');
  }
  lines.push('} as const;', '');
  return lines.join('\n');
}
