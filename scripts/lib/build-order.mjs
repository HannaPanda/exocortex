#!/usr/bin/env node
/**
 * Prints the workspace packages in the order they have to be built, one per
 * line, for `scripts/build.sh` to walk one at a time.
 *
 * Derived from `dependency-graph.mjs` rather than written out, because a
 * hand-kept list is a list that forgets the package added last week -- and a
 * package that never gets built fails at runtime, in production, as a missing
 * `dist/`.
 *
 * Two rules on top of the topological order:
 *
 *   * only packages that declare a `build` script appear (`@exocortex/e2e`
 *     does not),
 *   * `@exocortex/web` goes last no matter what. The Next.js build is the one
 *     step big enough to summon the OOM killer on this host, and it should meet
 *     a machine that has just finished everything else rather than one still
 *     holding a tsc process.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ALLOWED_INTERNAL_DEPENDENCIES } from '../dependency-graph.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');
const LAST = '@exocortex/web';

/** `@exocortex/api` lives in `apps/api`, everything else in `packages/`. */
function directoryOf(name) {
  const short = name.slice('@exocortex/'.length);
  for (const group of ['apps', 'packages']) {
    const candidate = join(repoRoot, group, short);
    if (existsSync(join(candidate, 'package.json'))) return candidate;
  }
  return null;
}

function hasBuildScript(name) {
  const dir = directoryOf(name);
  if (dir === null) return false;
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  return typeof manifest.scripts?.build === 'string';
}

const ordered = [];
const seen = new Set();
const visiting = new Set();

function visit(name) {
  if (seen.has(name)) return;
  if (visiting.has(name)) {
    // The boundary gate reports cycles properly; here it is enough not to hang.
    throw new Error(`Dependency cycle involving ${name}`);
  }
  visiting.add(name);
  for (const dependency of ALLOWED_INTERNAL_DEPENDENCIES[name] ?? []) visit(dependency);
  visiting.delete(name);
  seen.add(name);
  ordered.push(name);
}

for (const name of Object.keys(ALLOWED_INTERNAL_DEPENDENCIES)) {
  if (name !== LAST) visit(name);
}
visit(LAST);

for (const name of ordered) {
  if (hasBuildScript(name)) console.log(name);
}
