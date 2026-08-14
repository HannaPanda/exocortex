#!/usr/bin/env node
/**
 * Gate: `.env.example` describes the configuration that actually exists.
 *
 * A fresh clone is configured by copying `.env.example` and filling it in. When
 * a variable is missing from it, that clone starts without a value nobody knew
 * to set, and the failure arrives later and somewhere else. When a variable
 * lingers in it that nothing reads any more, the file documents configuration
 * that does not exist, which is how a setting gets "changed" for an hour with
 * no effect.
 *
 * Three places declare a variable in this repository, and all three are read:
 *
 *   1. `packages/config/src/schemas.ts` -- the zod schemas that validate the
 *      environment at boot. This is the real contract for the four services.
 *   2. a `process.env` reference anywhere in `apps`, `packages`, `scripts`,
 *      `tools` and `e2e` -- the scripts, hooks and tests that run outside
 *      those schemas.
 *   3. `docker-compose.yml` -- `${X}` interpolation and `environment:` keys,
 *      which is where the port and credential variables for the local
 *      infrastructure come from.
 *
 * There is no bypass: both directions of drift are a documentation bug, and
 * both are a one-line fix.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { fail, info, ok, step } from './lib/gate-log.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Variables that exist but do not belong in the example file.
 *
 * `NODE_ENV` and `CI` come from whoever starts the process. `DATABASE_URL` is
 * in the schemas and therefore documented; the rest here are injected by a
 * runner, a container or a gate, never written into a `.env`.
 */
const NOT_CONFIGURATION = new Set([
  'NODE_ENV',
  'CI',
  'PORT',
  'HOME',
  'PATH',
  'TZ',
  'FORCE_COLOR',
  'NO_COLOR',
  'TERM',
  'VITEST',
  'npm_lifecycle_event',
]);

const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  '.next',
  '.turbo',
  'coverage',
  'generated',
  'playwright-report',
  'test-results',
]);

const CODE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs'];

function walk(dir, extensions, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) walk(abs, extensions, acc);
    else if (extensions.some((extension) => entry.endsWith(extension))) acc.push(abs);
  }
  return acc;
}

/** name -> one place it is referenced, for the error message. */
const referenced = new Map();
function note(name, where) {
  if (!referenced.has(name)) referenced.set(name, where);
}

// --- 1. the zod schemas -----------------------------------------------------
// Keys of the `z.object({ … })` literals: an indented SCREAMING_SNAKE key
// followed by a colon. Nothing else in this file is written that way.
const schemasPath = join(repoRoot, 'packages/config/src/schemas.ts');
if (!existsSync(schemasPath)) {
  fail(
    'packages/config/src/schemas.ts is missing',
    [],
    'This gate reads the environment contract from there. If the file moved, point the gate at the new location.',
  );
}
const schemaSource = readFileSync(schemasPath, 'utf8');
for (const match of schemaSource.matchAll(/^\s+([A-Z][A-Z0-9_]{2,}):/gm)) {
  note(match[1], 'packages/config/src/schemas.ts');
}

// --- 2. process.env references ----------------------------------------------
const PROCESS_ENV =
  /process\.env\.([A-Za-z_][A-Za-z0-9_]*)|process\.env\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\]/g;
// Only JavaScript and TypeScript. The shell scripts under `deploy/` are
// deliberately not scanned: `$BACKUP_STAMP` in a bash script reads a local as
// often as it reads the environment, and nothing in the syntax tells the two
// apart -- scanning them adds two dozen findings that are all wrong. Those
// scripts document their own knobs at the top of each file.
for (const dir of ['apps', 'packages', 'scripts', 'tools', 'e2e']) {
  for (const file of walk(join(repoRoot, dir), CODE_EXTENSIONS)) {
    const where = relative(repoRoot, file);
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(PROCESS_ENV)) note(match[1] ?? match[2], where);
  }
}

// --- 3. docker-compose ------------------------------------------------------
const INTERPOLATION = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::[-?+][^}]*)?\}/g;
const composePath = join(repoRoot, 'docker-compose.yml');
if (existsSync(composePath)) {
  const compose = readFileSync(composePath, 'utf8');
  for (const match of compose.matchAll(INTERPOLATION)) note(match[1], 'docker-compose.yml');
}

// --- what the example file documents ----------------------------------------
const examplePath = join(repoRoot, '.env.example');
if (!existsSync(examplePath)) {
  fail(
    '.env.example is missing',
    [],
    'Create it: this gate treats it as the configuration contract.',
  );
}
const documented = new Set();
for (const line of readFileSync(examplePath, 'utf8').split('\n')) {
  // A commented-out assignment still documents the variable -- that is how an
  // optional key with no sensible default is written in this file.
  const match = line.match(/^#?\s*([A-Za-z_][A-Za-z0-9_]*)=/);
  if (match !== null) documented.add(match[1]);
}

step('Configuration example sync (.env.example ↔ schemas, code, compose)');

const missing = [];
for (const [name, where] of referenced) {
  if (documented.has(name) || NOT_CONFIGURATION.has(name)) continue;
  missing.push(`${name} — used in ${where}, absent from .env.example`);
}
const orphaned = [];
for (const name of documented) {
  if (!referenced.has(name)) orphaned.push(`${name} — in .env.example, read by nothing`);
}

if (missing.length > 0 || orphaned.length > 0) {
  fail(
    '.env.example does not match the configuration that exists',
    [...missing.sort(), ...orphaned.sort()],
    'Add the missing keys with a dummy value and delete the orphaned ones, in the same commit as the change that moved them.',
  );
}

info(`${referenced.size} variable(s) referenced, ${documented.size} documented`);
ok('.env.example is in sync.');
