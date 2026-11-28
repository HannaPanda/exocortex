#!/usr/bin/env node
/**
 * Gate: every namespace and every literal key the code asks a translator for
 * exists in the German catalogue (issue #325).
 *
 * The type checker would say the same thing, but at a price this host cannot
 * pay. The German catalogue is the `Messages` type every `t()` is checked
 * against, and when a namespace is missing, every call in the file becomes an
 * error tsc explains against the whole catalogue: on 2026-11-27 one
 * `useTranslations('database.aiFill')` without its namespace took the web
 * typecheck past 5 GB and held the host for most of an hour (in October a
 * stale `dist/` of `@exocortex/i18n` did the same, past 6 GB). The same
 * mistake costs this script a second, and it names the file and the line.
 *
 * What it reads, in `apps/` and `packages/`:
 *
 *   * `useTranslations(ns)` and `getTranslations(ns | { namespace })` from
 *     next-intl or use-intl, and `serverTranslator(locale, ns)` from
 *     `@exocortex/i18n`: the namespace has to be an object in the German
 *     catalogue (`database.aiFill` is `aiFill` inside `de/database.json`);
 *   * every call of the translator those return, `t(key)`, `t.rich(key)`,
 *     `t.markup(key)` and `t.raw(key)`, whose key is a literal (or a ternary
 *     of literals): the key has to exist under that namespace, and as text
 *     unless it is read raw.
 *
 * What it skips, on purpose: a key built at run time (`t(\`errors.${code}\`)`),
 * a translator handed to another function, `t.has()`, which asks rather than
 * asserts. Guessing at those would make findings nobody can fix; the type
 * checker still sees them, and the memory limit around it (`scripts/memory-scope.sh`)
 * is what bounds the cost when it does.
 *
 * Unlike the other gates this one needs `pnpm install`: it parses with
 * `@babel/core` (a root devDependency already, for ESLint), because what a
 * name like `t` refers to is a question of scope, and a regex answers it wrong
 * as soon as a helper takes a translator as a parameter. `build.sh` runs it
 * after the install, before anything type-checks.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import babel from '@babel/core';

import { fail, info, ok, step } from './lib/gate-log.mjs';
import { namespacesOf, readNamespace, repoRoot, SOURCE_LOCALE } from './lib/i18n-catalog.mjs';

const { parseSync, traverse } = babel;

step('Message keys in use: namespaces and literal keys against the German catalogue');

const INTL_MODULES = new Set(['next-intl', 'next-intl/server', 'use-intl', 'use-intl/core']);
const INTL_HOOKS = new Set(['useTranslations', 'getTranslations']);
/** `@exocortex/i18n` from outside the package, `./catalog.js` from inside it. */
const SERVER_TRANSLATOR_MODULES = /^(@exocortex\/i18n|\.\/catalog(\.js)?)$/;
const TRANSLATOR_METHODS = new Set(['rich', 'markup', 'raw']);

const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'generated',
  'coverage',
  'test-results',
  'playwright-report',
]);
const CODE = /\.(ts|tsx|mts|cts)$/;
/** Cheap pre-filter: a file that names none of these cannot call one. */
const MENTIONS = /useTranslations|getTranslations|serverTranslator/;

function* sourceFiles(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(path);
    else if (CODE.test(entry.name) && !entry.name.endsWith('.d.ts')) yield path;
  }
}

const catalogue = Object.fromEntries(
  namespacesOf(SOURCE_LOCALE).map((name) => [name, readNamespace(SOURCE_LOCALE, name)]),
);

/** The catalogue value at a dotted path, or `undefined`. */
function lookup(path) {
  let value = catalogue;
  for (const segment of path.split('.')) {
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, segment)) {
      return undefined;
    }
    value = value[segment];
  }
  return value;
}

const isObject = (value) => value !== null && typeof value === 'object';

/** A string the source states outright, or `null` for anything computed. */
function literal(node) {
  if (node?.type === 'StringLiteral') return node.value;
  if (node?.type === 'TemplateLiteral' && node.expressions.length === 0) {
    return node.quasis[0].value.cooked;
  }
  return null;
}

/** The literal keys an argument can be: one, both branches of a ternary, or none. */
function literalKeys(node) {
  if (node?.type === 'ConditionalExpression') {
    const branches = [literalKeys(node.consequent), literalKeys(node.alternate)];
    return branches.every((keys) => keys !== null) ? branches.flat() : null;
  }
  const value = literal(node);
  return value === null ? null : [value];
}

/**
 * The namespace a translator call asks for: a string, `''` for the whole
 * catalogue, or `null` when the code computes it.
 */
function namespaceArgument(kind, args) {
  if (kind === 'serverTranslator') return literal(args[1]);
  const [first] = args;
  if (first === undefined) return '';
  if (first.type === 'ObjectExpression') {
    const property = first.properties.find(
      (entry) =>
        entry.type === 'ObjectProperty' &&
        !entry.computed &&
        (entry.key.name ?? entry.key.value) === 'namespace',
    );
    return property === undefined ? '' : literal(property.value);
  }
  return literal(first);
}

/** Which translator factory a callee is, judged by its import, or `null`. */
function factoryOf(path) {
  const callee = path.node.callee;
  if (callee.type !== 'Identifier') return null;
  const binding = path.scope.getBinding(callee.name);
  if (binding?.kind !== 'module') return null;
  const declaration = binding.path.parentPath?.node;
  const specifier = binding.path.node;
  if (declaration?.type !== 'ImportDeclaration' || specifier.type !== 'ImportSpecifier') {
    return null;
  }
  const imported = specifier.imported.name ?? specifier.imported.value;
  const from = declaration.source.value;
  if (INTL_HOOKS.has(imported) && INTL_MODULES.has(from)) return imported;
  if (imported === 'serverTranslator' && SERVER_TRANSLATOR_MODULES.test(from)) return imported;
  return null;
}

const findings = [];
let files = 0;
let namespacesChecked = 0;
let keysChecked = 0;

function checkKey(where, namespace, method, argument) {
  const keys = literalKeys(argument);
  if (keys === null) return;
  for (const key of keys) {
    keysChecked += 1;
    const full = namespace === '' ? key : `${namespace}.${key}`;
    const value = lookup(full);
    const call = `${method}('${key}')`;
    if (value === undefined) {
      findings.push(`${where}: ${call}: '${full}' is not in the German catalogue`);
    } else if (method !== 't.raw' && typeof value !== 'string') {
      findings.push(`${where}: ${call}: '${full}' is a group of messages, not a message`);
    }
  }
}

/** Every use of a translator bound to a name: calls are checked, the rest is left alone. */
function checkUses(file, binding, namespace) {
  for (const reference of binding.referencePaths) {
    const parent = reference.parentPath;
    const line = reference.node.loc?.start.line;
    const where = `${file}:${line}`;
    if (parent.isCallExpression() && parent.node.callee === reference.node) {
      checkKey(where, namespace, binding.identifier.name, parent.node.arguments[0]);
      continue;
    }
    if (
      parent.isMemberExpression() &&
      parent.node.object === reference.node &&
      !parent.node.computed &&
      TRANSLATOR_METHODS.has(parent.node.property.name) &&
      parent.parentPath.isCallExpression() &&
      parent.parentPath.node.callee === parent.node
    ) {
      checkKey(
        where,
        namespace,
        `${binding.identifier.name}.${parent.node.property.name}`,
        parent.parentPath.node.arguments[0],
      );
    }
  }
}

for (const top of ['apps', 'packages']) {
  for (const absolute of sourceFiles(join(repoRoot, top))) {
    const source = readFileSync(absolute, 'utf8');
    if (!MENTIONS.test(source)) continue;
    const file = relative(repoRoot, absolute);
    let ast;
    try {
      ast = parseSync(source, {
        filename: absolute,
        configFile: false,
        babelrc: false,
        parserOpts: {
          sourceType: 'module',
          // NestJS services use decorators; `jsx` only for .tsx, where `<T,>` is not a cast.
          plugins: [
            'typescript',
            'decorators-legacy',
            ...(absolute.endsWith('.tsx') ? ['jsx'] : []),
          ],
        },
      });
    } catch (error) {
      findings.push(`${file}: could not be parsed (${error.message.split('\n')[0]})`);
      continue;
    }
    files += 1;
    traverse(ast, {
      CallExpression(path) {
        const kind = factoryOf(path);
        if (kind === null) return;
        const namespace = namespaceArgument(kind, path.node.arguments);
        if (namespace === null) return;
        const where = `${file}:${path.node.loc?.start.line}`;
        namespacesChecked += 1;
        if (namespace !== '' && !isObject(lookup(namespace))) {
          const [head, ...rest] = namespace.split('.');
          const reason =
            lookup(namespace) !== undefined
              ? 'is a message, not a namespace'
              : rest.length === 0 || lookup(head) === undefined
                ? `has no file ${SOURCE_LOCALE}/${head}.json`
                : `is not in ${SOURCE_LOCALE}/${head}.json`;
          findings.push(`${where}: ${kind}('${namespace}'): the namespace ${reason}`);
          return;
        }
        // `serverTranslator(locale, 'mail')('common.untitledPage')`
        if (path.parentPath.isCallExpression() && path.parentPath.node.callee === path.node) {
          checkKey(where, namespace, kind, path.parentPath.node.arguments[0]);
          return;
        }
        const holder = path.parentPath.isAwaitExpression() ? path.parentPath : path;
        const declarator = holder.parentPath;
        if (!declarator?.isVariableDeclarator() || declarator.node.id.type !== 'Identifier') {
          return;
        }
        const binding = declarator.scope.getBinding(declarator.node.id.name);
        if (binding === undefined || binding.constantViolations.length > 0) return;
        checkUses(file, binding, namespace);
      },
    });
  }
}

if (findings.length > 0) {
  fail(
    `${findings.length} translation(s) the German catalogue does not have`,
    findings,
    `Add the namespace or key to packages/i18n/src/messages/${SOURCE_LOCALE}/ first, then run \`pnpm i18n:translate --all\` and \`pnpm --filter @exocortex/i18n build\`. Do not type-check before: tsc explains a missing namespace against the whole catalogue and needs gigabytes for it.`,
  );
}

info(
  `${files} files, ${namespacesChecked} translators, ${keysChecked} literal keys checked; computed keys are left to the type checker.`,
);
ok('Every namespace and literal key in use is in the German catalogue.');
