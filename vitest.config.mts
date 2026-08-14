import { defineConfig } from 'vitest/config';

/**
 * The root suite holds exactly one thing: `scripts/gates.test.ts`, which runs
 * the deploy gates against the real repository.
 *
 * It is separate from the per-package suites because it is not about any one
 * package -- it is about the repository as a whole -- and because it is slow in
 * a way unit tests should never be: each case shells out to a gate, and the
 * migration gate starts a Postgres container.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['scripts/**/*.test.ts'],
    // Serial. Several cases write a probe file into the working tree and remove
    // it again; two of them running at once would see each other's probes.
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 180_000,
  },
});
