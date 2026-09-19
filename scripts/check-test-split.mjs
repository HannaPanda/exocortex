#!/usr/bin/env node
/**
 * Gate: every test runs somewhere, and the default set needs no infrastructure.
 *
 * Two failures this repository had at the same time (issue #93). The default
 * test step in `build.sh` named its packages by hand, so `apps/api`,
 * `apps/web`, `apps/worker` and `apps/collaboration` were never run by CI at
 * all: nine tests had been failing on `master` for days behind a green build,
 * and nothing was looking. And several tests that *were* nominally unit tests
 * opened a connection to Postgres, which on the deployment host means the live
 * database -- they only passed because the infrastructure happened to be there.
 *
 * So the split is by file name, and this gate is what makes the name true:
 *
 *   *.integration.test.ts   needs a database, Redis or object storage.
 *                           Run by `pnpm test:integration`, never by CI.
 *   everything else         runs anywhere, including a fresh checkout with no
 *                           containers. Run by `pnpm test:unit`, which is what
 *                           `build.sh` and therefore CI runs.
 *
 * Three things are checked, and each one is a way the split can rot quietly:
 *
 *   1. a workspace with test files declares both scripts, spelled the same way
 *      everywhere, so `turbo run test:unit` reaches it. A new app whose
 *      `package.json` says only `test` would otherwise drop out of CI in
 *      silence, which is exactly how this started.
 *   2. no unit test constructs an infrastructure client. The list below is of
 *      constructors, not of imports: a test may import `type PrismaClient` and
 *      hand the service a fake, and most of them do.
 *   3. a workspace whose scripts exist has them pointing at vitest with the
 *      right filter, because a `test:unit` that quietly runs everything is the
 *      first failure again with extra steps.
 *   4. a workspace that has integration tests loads the guard that keeps them
 *      away from the deployment's database (issue #94). The guard lives in a
 *      `setupFiles` entry, and a `setupFiles` entry is easy to forget in a new
 *      workspace -- at which point its tests would reach whatever the
 *      repository's `.env` points at, silently and on the first run.
 *
 * There is no bypass and no allowlist. A test that needs infrastructure is
 * renamed; it is one `git mv`.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { fail, info, ok, step } from './lib/gate-log.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The workspace roots, in the order `pnpm-workspace.yaml` lists them. */
const WORKSPACE_ROOTS = ['apps', 'packages'];

/** Directories that hold build output or dependencies, never sources. */
const SKIP_DIRS = new Set(['node_modules', 'dist', '.next', '.turbo', 'coverage', 'generated']);

/** The canonical scripts. Spelled once here and compared literally. */
const UNIT_SCRIPT = "vitest run --exclude '**/*.integration.test.*' --passWithNoTests";
const INTEGRATION_SCRIPT = 'vitest run --passWithNoTests integration.test';

/**
 * Constructing one of these opens a socket to something.
 *
 * Each entry is the text that appears in a test and the infrastructure it
 * reaches, so the finding can say which one rather than only that there was
 * one. `Test.createTestingModule` is in the list because compiling the Nest
 * module graph initialises Better Auth, which writes its OAuth resource rows
 * on init and therefore connects before any test body runs.
 */
const INFRASTRUCTURE = [
  { marker: 'createPrismaClient(', reaches: 'PostgreSQL' },
  { marker: 'createRedisConnection(', reaches: 'Redis' },
  { marker: 'new Redis(', reaches: 'Redis' },
  { marker: "from 'ioredis'", reaches: 'Redis' },
  { marker: 'new QueueRegistry(', reaches: 'Redis' },
  { marker: 'new RedisEventBus(', reaches: 'Redis' },
  { marker: 'new RedisRevocationBus(', reaches: 'Redis' },
  { marker: 'createTypedWorker(', reaches: 'Redis' },
  { marker: 'new S3ObjectStorage(', reaches: 'object storage' },
  { marker: 'Test.createTestingModule(', reaches: 'PostgreSQL (through the module graph)' },
];

const INTEGRATION_SUFFIX = '.integration.test.';

/**
 * The guard from issue #94, as a workspace's vitest config has to name it. It
 * refuses to let an integration test open a connection to anything but the
 * throwaway stack `scripts/test-integration.sh` creates.
 */
const GUARD_SETUP_FILE = 'vitest.setup.integration.ts';

function walk(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const absolute = join(dir, entry);
    if (statSync(absolute).isDirectory()) walk(absolute, acc);
    else if (/\.test\.(ts|tsx|mts)$/.test(entry)) acc.push(absolute);
  }
  return acc;
}

/** Every workspace directory that has a `package.json`. */
function workspaces() {
  const found = [];
  for (const root of WORKSPACE_ROOTS) {
    const absolute = join(repoRoot, root);
    if (!existsSync(absolute)) continue;
    for (const entry of readdirSync(absolute)) {
      const dir = join(absolute, entry);
      if (!statSync(dir).isDirectory()) continue;
      if (existsSync(join(dir, 'package.json'))) found.push(dir);
    }
  }
  return found;
}

step('Test split (every test runs somewhere, and the default set needs no infrastructure)');

const findings = [];
let unitFiles = 0;
let integrationFiles = 0;

for (const dir of workspaces()) {
  const name = relative(repoRoot, dir);
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const scripts = manifest.scripts ?? {};
  const tests = walk(dir);

  if (tests.length === 0) {
    if (scripts['test:unit'] !== undefined) {
      findings.push({
        line: `${name}/package.json: declares \`test:unit\` but has no test files`,
        hint: 'Remove the scripts, or add the tests they were written for.',
      });
    }
    continue;
  }

  for (const [script, expected] of [
    ['test:unit', UNIT_SCRIPT],
    ['test:integration', INTEGRATION_SCRIPT],
  ]) {
    if (scripts[script] === undefined) {
      findings.push({
        line: `${name}/package.json: has ${tests.length} test file(s) but no \`${script}\` script`,
        hint: `Add "${script}": "${expected}". Without it, \`turbo run ${script}\` skips this workspace and its tests run nowhere.`,
      });
    } else if (scripts[script] !== expected) {
      findings.push({
        line: `${name}/package.json: \`${script}\` is "${scripts[script]}", not the canonical command`,
        hint: `Use "${expected}". The filter is the whole of the split; a different one splits somewhere else.`,
      });
    }
  }

  // The guard is loaded per workspace, so a workspace that has integration
  // tests has to name it. Checked against the vitest config rather than against
  // the test files: `setupFiles` is what actually runs it, and a test file that
  // imported it by hand would be one import away from not doing so.
  if (tests.some((file) => file.includes(INTEGRATION_SUFFIX))) {
    const configPath = join(dir, 'vitest.config.mts');
    const config = existsSync(configPath) ? readFileSync(configPath, 'utf8') : '';
    if (!config.includes(GUARD_SETUP_FILE)) {
      findings.push({
        line: `${name}/vitest.config.mts: has integration tests but does not load ${GUARD_SETUP_FILE}`,
        hint: `Add "setupFiles: ['../../${GUARD_SETUP_FILE}']". Without it these tests open whatever DATABASE_URL points at, which on the deployment host is production.`,
      });
    }
  }

  for (const file of tests) {
    const relativePath = relative(repoRoot, file);
    if (relativePath.includes(INTEGRATION_SUFFIX)) {
      integrationFiles += 1;
      continue;
    }
    unitFiles += 1;
    const source = readFileSync(file, 'utf8');
    for (const { marker, reaches } of INFRASTRUCTURE) {
      if (!source.includes(marker)) continue;
      const index = source.split('\n').findIndex((line) => line.includes(marker));
      findings.push({
        line: `${relativePath}:${index + 1}: \`${marker}\` reaches ${reaches}, in a file the default test set runs`,
        hint: `Rename it to *${INTEGRATION_SUFFIX}ts, or give the subject a fake instead of a real client. On the deployment host the default set runs against the live database, so this is not only a CI concern.`,
      });
    }
  }
}

if (findings.length > 0) {
  const hints = [...new Set(findings.map((finding) => finding.hint))];
  fail(
    `${findings.length} place(s) where the unit/integration split does not hold`,
    findings.map((finding) => finding.line),
    hints.length === 1 ? hints[0] : `${hints.length} different causes; see the lines above.`,
  );
}

info(`${unitFiles} test files run without infrastructure, ${integrationFiles} need it`);
ok('Every workspace with tests is in the default set, and none of it needs a database.');
