import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { config as loadEnvFile } from 'dotenv';
import { defineConfig } from 'prisma/config';

/**
 * Configuration for the Prisma CLI.
 *
 * Prisma 7 moved two things out of the places this repository used to keep
 * them. `datasource db { url = env("DATABASE_URL") }` in `schema.prisma` is now
 * a validation error (P1012), and the `prisma` key in `package.json` is gone.
 * Both live here instead, which is why this file exists at all.
 *
 * It is read by the Prisma CLI before any workspace package has been built --
 * `build.sh` generates the client in step 3 and compiles in step 5 -- so it
 * cannot import `loadDotEnv` from `@exocortex/config` the way every runtime
 * process does. The few lines below are that function, deliberately duplicated
 * rather than reached for across a boundary that does not exist yet at this
 * point in a build.
 *
 * Reading `.env` from the repository root and not from anywhere else is load
 * bearing for `scripts/check-migrations-reproducible.sh`: it replays migrations
 * from a scratch directory outside the repository, where the walk below finds
 * no root, so `DATABASE_URL` can only come from the throwaway container it
 * exported. A config that resolved the URL from a file next to the schema would
 * point that gate at production.
 */
function findRepositoryRoot(startDirectory: string): string | null {
  let current = resolve(startDirectory);

  while (true) {
    if (existsSync(join(current, 'pnpm-workspace.yaml'))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

const repositoryRoot = findRepositoryRoot(process.cwd());
if (repositoryRoot !== null) {
  // `.env.local` first so its values win: nothing already set is overwritten,
  // and a real environment variable always beats both files.
  for (const file of ['.env.local', '.env']) {
    const path = join(repositoryRoot, file);
    if (existsSync(path)) loadEnvFile({ path, override: false, quiet: true });
  }
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  // Left undefined rather than made to throw when unset: `prisma generate`
  // needs no database, and it runs in places that have none.
  datasource: { url: process.env.DATABASE_URL },
});
