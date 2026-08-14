/**
 * Gate: no package depends on one it is not allowed to.
 *
 * Reads every workspace package manifest and asserts that its internal
 * (`@exocortex/*`) dependencies are allowed by `dependency-graph.mjs`. Also
 * detects dependency cycles between workspace packages.
 *
 * This is the second half of a rule ESLint enforces at the import site
 * (`no-restricted-imports`, built from the same graph): a manifest can declare
 * a dependency long before anything imports it, and the import rule would not
 * see that. Both halves read one list, so they cannot drift apart.
 *
 * Run from `scripts/build.sh` alongside the other gates, and from `pnpm lint`.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ALLOWED_INTERNAL_DEPENDENCIES, INTERNAL_SCOPE } from './dependency-graph.mjs';
import { fail, info, ok, step } from './lib/gate-log.mjs';

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

step('Package boundaries (manifests ↔ scripts/dependency-graph.mjs)');

if (errors.length > 0) {
  fail(
    `${errors.length} package boundary violation(s)`,
    errors,
    'Either the dependency does not belong there, or the graph in scripts/dependency-graph.mjs is out of date. Change the one that is wrong -- eslint.config.mjs reads the same list, so widening it opens the import rule too.',
  );
}

info(`${packages.size} workspace package(s)`);
ok('Every internal dependency is allowed by the graph.');
