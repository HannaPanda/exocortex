#!/usr/bin/env node
/**
 * Runs a turbo test task with the parallelism this machine can afford.
 *
 *   node scripts/run-tests.mjs test:unit [turbo arguments …]
 *
 * This is the one place where test parallelism is decided (issue #313), and
 * `pnpm test:unit` and `scripts/test-integration.sh` both go through it, so
 * `build.sh`, `deploy.sh` and the CI all follow the same rule.
 *
 * Why it exists. Left alone, turbo runs ten workspaces at once and every
 * vitest in them starts one worker per core but one. On this host (8 cores,
 * shared with the four live units and everything else on the machine) that
 * was up to 70 test processes and a load of 60 to 70, and tests that take
 * well under two seconds alone ran into their 5 s limit: eight of twenty
 * workspaces red, all of them green when run one by one. A build that goes
 * green on the second attempt teaches everybody to ignore red, so the answer
 * is fewer processes, not longer limits.
 *
 * The budget is a number of CPUs the tests may keep busy. It is split into
 * workspaces running side by side (turbo's `--concurrency`) and workers per
 * workspace (`VITEST_MAX_WORKERS`, which vitest reads itself and which
 * `turbo.json` passes through without making it part of the cache key):
 *
 *   EXOCORTEX_TEST_CPUS unset   half the cores -- the default, for a host that
 *                               keeps serving while it tests
 *   EXOCORTEX_TEST_CPUS=all     every core, for a machine that does nothing
 *                               else (the CI runner)
 *   EXOCORTEX_TEST_CPUS=<n>     exactly n
 *
 * Arguments after the task name go to turbo unchanged; a `--concurrency` among
 * them wins over the computed one.
 */

import { spawnSync } from 'node:child_process';
import { availableParallelism } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
// The repository's own turbo, so the script works from a bare `bash` as well as
// from a pnpm script, which is the only place `node_modules/.bin` is on PATH.
const turbo = join(repoRoot, 'node_modules', '.bin', 'turbo');

const [task, ...turboArgs] = process.argv.slice(2);
if (task === undefined || task.startsWith('-')) {
  console.error('usage: node scripts/run-tests.mjs <turbo task> [turbo arguments …]');
  process.exit(2);
}

const cores = availableParallelism();

/** How many CPUs the tests may keep busy. */
function testCpus() {
  const raw = (process.env.EXOCORTEX_TEST_CPUS ?? '').trim();
  if (raw === '') return Math.max(1, Math.floor(cores / 2));
  if (raw === 'all') return cores;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    console.error(`EXOCORTEX_TEST_CPUS must be a positive whole number or "all", not "${raw}".`);
    process.exit(2);
  }
  return value;
}

const budget = testCpus();
// Two workers per suite, and the rest of the budget as suites side by side.
// Measured on this host (issue #313, all twenty workspaces, cache off): two
// suites of two workers took 77 s at a load of 5, four of two 49 s at a load
// of 8, the unlimited default 279 s at a load of 70 with eight suites red.
// Most suites are small and spend their time importing, so more suites at
// once pays better than more workers inside one.
const workers = Math.min(2, budget);
const concurrency = Math.max(1, Math.floor(budget / workers));

const explicitConcurrency = turboArgs.some((arg) => arg.startsWith('--concurrency'));
const args = [
  'run',
  task,
  ...(explicitConcurrency ? [] : [`--concurrency=${concurrency}`]),
  ...turboArgs,
];

console.log(
  `Test parallelism: ${budget} of ${cores} CPUs -- ${explicitConcurrency ? 'concurrency as given' : `${concurrency} workspace(s)`} × ${workers} vitest worker(s) (EXOCORTEX_TEST_CPUS=${process.env.EXOCORTEX_TEST_CPUS ?? 'unset'})`,
);

const result = spawnSync(turbo, args, {
  cwd: repoRoot,
  stdio: 'inherit',
  env: { ...process.env, VITEST_MAX_WORKERS: String(workers) },
});
if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
