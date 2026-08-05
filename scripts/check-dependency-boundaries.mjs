/**
 * Static dependency-boundary check.
 *
 * Reads every workspace package manifest and asserts that its internal
 * (`@exocortex/*`) dependencies are allowed by `dependency-graph.ts`.
 * Also detects dependency cycles between workspace packages.
 *
 * Run via `pnpm lint`.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ALLOWED_INTERNAL_DEPENDENCIES, INTERNAL_SCOPE } from './dependency-graph.mjs';

const repositoryRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const workspaceGlobs = ['apps', 'packages'];

/**
 * @typedef {{ name?: string, dependencies?: Record<string,string>, devDependencies?: Record<string,string>, peerDependencies?: Record<string,string> }} Manifest
 */

/** @param {string} path @returns {Manifest | null} */
function readManifest(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/** @type {Map<string, { dir: string, internal: string[] }>} */
const packages = new Map();

for (const group of workspaceGlobs) {
  const groupDir = join(repositoryRoot, group);
  /** @type {string[]} */
  let entries = [];
  try {
    entries = readdirSync(groupDir);
  } catch {
    continue;
  }
  for (const entry of entries) {
    const dir = join(groupDir, entry);
    if (!statSync(dir).isDirectory()) continue;
    const manifest = readManifest(join(dir, 'package.json'));
    if (!manifest?.name) continue;
    const internal = [
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.devDependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
    ].filter((name) => name.startsWith(INTERNAL_SCOPE));
    packages.set(manifest.name, { dir, internal: [...new Set(internal)] });
  }
}

/** @type {string[]} */
const errors = [];

for (const [name, info] of packages) {
  const allowed = ALLOWED_INTERNAL_DEPENDENCIES[name];
  if (!allowed) {
    errors.push(
      `Package "${name}" (${info.dir}) is missing from scripts/dependency-graph.ts. ` +
        `Add it with an explicit allow list.`,
    );
    continue;
  }
  for (const dependency of info.internal) {
    if (!allowed.includes(dependency)) {
      errors.push(
        `Forbidden dependency: "${name}" must not depend on "${dependency}". ` +
          `Allowed: ${allowed.length > 0 ? allowed.join(', ') : '(none)'}`,
      );
    }
  }
}

// Cycle detection over the declared graph.
const visiting = new Set();
const visited = new Set();

/** @param {string} name @param {string[]} stack */
function walk(name, stack) {
  if (visited.has(name)) return;
  if (visiting.has(name)) {
    errors.push(`Dependency cycle detected: ${[...stack, name].join(' -> ')}`);
    return;
  }
  visiting.add(name);
  for (const dependency of packages.get(name)?.internal ?? []) {
    walk(dependency, [...stack, name]);
  }
  visiting.delete(name);
  visited.add(name);
}

for (const name of packages.keys()) {
  walk(name, []);
}

if (errors.length > 0) {
  console.error('Dependency boundary violations:\n');
  for (const error of errors) console.error(`  - ${error}`);
  console.error('');
  process.exit(1);
}

console.log(`Dependency boundaries OK (${packages.size} workspace packages).`);
