#!/usr/bin/env node
/**
 * Gate: every TypeScript file is reached by a typecheck that actually runs.
 *
 * A `tsconfig.json` that emits says what goes into the bundle, and for a long
 * time that was read as also saying what gets checked. It is not the same list.
 * `apps/api/tsconfig.json` included `src/**` and nothing else, so the operator
 * scripts beside it -- the Obsidian import, the workspace deletion, the
 * test-data prune, the token creation -- were compiled by nobody. ESLint saw
 * them, and ESLint checks syntax and style, not types.
 *
 * What that cost is issue #95: `apps/api/scripts/import-obsidian/verify.ts` had
 * lost every one of its imports. Ten undefined names, in a file that reads the
 * live database, and it would have thrown a ReferenceError on the first
 * `--verify-only` run. The build was green the whole time, because it was never
 * asked.
 *
 * So the question here is not "does this compile" -- the typecheck step asks
 * that. It is whether the typecheck step was handed the file at all:
 *
 *   1. every `.ts`, `.tsx`, `.mts` and `.cts` file appears in the resolved file
 *      list of at least one project that a `typecheck` script runs. Resolved by
 *      `tsc --showConfig` rather than by re-implementing `include` and
 *      `exclude` here: a glob this gate got subtly wrong would report coverage
 *      nobody has, which is the failure it exists to prevent.
 *   2. every `tsconfig*.json` is named by a `typecheck` or a `build` script. A
 *      project file that exists and is run by nothing looks exactly like
 *      coverage from the outside. Only the typecheck projects count towards
 *      (1): a `tsconfig.build.json` is the shorter list that goes into `dist/`,
 *      and the workspace's `tsconfig.json` beside it is what checks everything.
 *
 * There is no carve-out. Test files were one until issue #99: the emitting
 * packages excluded `src/**` test files from their projects, which left about
 * 160 of them outside every typecheck, and a test that only compiles because
 * nobody looked at it usually checks something other than what it claims.
 */

import { execFile } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { fail, info, ok, step } from './lib/gate-log.mjs';

const run = promisify(execFile);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
// Located through `package.json` rather than by resolving `typescript/bin/tsc`
// directly: TypeScript 7 declares an `exports` map, and `./bin/tsc` is not in
// it, so resolving the entry point is the only way in that both compilers
// answer. The file is there either way.
const tsc = join(
  dirname(createRequire(import.meta.url).resolve('typescript/package.json')),
  'bin',
  'tsc',
);

/** Directories that hold dependencies, build output or generated code. */
const SKIP_DIRS = new Set([
  '.git',
  '.next',
  '.turbo',
  'coverage',
  'dist',
  'generated',
  'node_modules',
  'test-results',
]);

/** Sources this gate is about. A `.d.ts` is matched by the `.ts` pattern. */
const SOURCE_FILE = /\.[cm]?tsx?$/;

/** Shared bases: compiler settings only, no `include`, never run as a project. */
const SHARED_BASES = new Set(['tsconfig.base.json', 'tsconfig.node.json', 'tsconfig.react.json']);

/**
 * One walk of the tree, collecting the three things this gate compares:
 * the sources, the manifests that say what gets typechecked, and the project
 * files that could be doing it.
 *
 * The filesystem rather than `git ls-files`, for the same reason
 * `check-test-split.mjs` walks: a gate is only as good as its own test, and the
 * test writes a probe file into the tree without committing it.
 */
function collect(dir = repoRoot, found = { sources: [], manifests: [], projects: [] }) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const absolute = join(dir, entry);
    if (statSync(absolute).isDirectory()) {
      collect(absolute, found);
      continue;
    }
    const path = relative(repoRoot, absolute);
    if (SOURCE_FILE.test(entry)) found.sources.push(path);
    else if (entry === 'package.json') found.manifests.push(path);
    else if (/^tsconfig.*\.json$/.test(entry)) found.projects.push(path);
  }
  return found;
}

/**
 * The projects one named script hands to `tsc`, as `{ dir, config }`.
 *
 * Read out of the scripts rather than off the disk, because a project is
 * covered by being run: `turbo run typecheck` runs exactly what the workspaces
 * declare, and a config file nobody names runs nowhere.
 */
function projectsOf(manifests, scriptName) {
  const found = [];
  for (const manifest of manifests) {
    const script = JSON.parse(readFileSync(join(repoRoot, manifest), 'utf8')).scripts?.[scriptName];
    if (script === undefined) continue;
    const dir = dirname(manifest);
    for (const match of script.matchAll(/-p\s+(\S+)/g)) {
      found.push({ dir, config: match[1], declaredIn: manifest });
    }
  }
  return found;
}

/** The files `tsc` would check for one project, as repository-relative paths. */
async function filesOf(project) {
  const cwd = join(repoRoot, project.dir);
  const { stdout } = await run(process.execPath, [tsc, '-p', project.config, '--showConfig'], {
    cwd,
    maxBuffer: 64 * 1024 * 1024,
  });
  return (JSON.parse(stdout).files ?? []).map((file) => relative(repoRoot, resolve(cwd, file)));
}

step('Typecheck coverage (every TypeScript file is handed to a typecheck that runs)');

const tree = collect();
const projects = projectsOf(tree.manifests, 'typecheck');
const emitted = projectsOf(tree.manifests, 'build');

const covered = new Set();
for (const files of await Promise.all(
  projects.map(async (project) => {
    try {
      return await filesOf(project);
    } catch (error) {
      fail(
        `${project.declaredIn}: \`typecheck\` names ${project.config}, which tsc cannot read`,
        [error instanceof Error ? error.message.split('\n')[0] : String(error)],
        'Fix the project file or the script. A typecheck that cannot start is one that never goes red.',
      );
      return [];
    }
  }),
)) {
  for (const file of files) covered.add(file);
}

const findings = [];
let checked = 0;

for (const file of tree.sources) {
  if (covered.has(file)) {
    checked += 1;
  } else {
    findings.push({
      line: `${file}: outside every tsconfig a \`typecheck\` script runs`,
      hint: "Add it to the project that owns it, or give its directory a `tsconfig.scripts.json` beside the emitting one (see `apps/api/tsconfig.scripts.json`) and name that file in the workspace's `typecheck` script.",
    });
  }
}

const named = new Set(
  [...projects, ...emitted].map((project) => join(project.dir, project.config)),
);
for (const config of tree.projects) {
  if (SHARED_BASES.has(config) || named.has(config)) continue;
  findings.push({
    line: `${config}: no \`typecheck\` or \`build\` script runs this project`,
    hint: "Name it in the workspace's `typecheck` script, or delete it. A project file nobody runs reads like coverage and is none.",
  });
}

if (findings.length > 0) {
  const hints = [...new Set(findings.map((finding) => finding.hint))];
  fail(
    `${findings.length} file(s) that no typecheck looks at`,
    findings.map((finding) => finding.line),
    hints.length === 1 ? hints[0] : `${hints.length} different causes; see the lines above.`,
  );
}

info(`${checked} files across ${projects.length} projects`);
ok('Every TypeScript file is handed to a typecheck.');
