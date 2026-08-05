import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { config as loadDotEnvFile } from 'dotenv';

/**
 * Finds the repository root by walking upwards until a `pnpm-workspace.yaml`
 * is found. Returns `null` when the process runs outside the monorepo (for
 * example from a packaged deployment).
 */
export function findRepositoryRoot(startDirectory: string = process.cwd()): string | null {
  let current = resolve(startDirectory);
   
  while (true) {
    if (existsSync(join(current, 'pnpm-workspace.yaml'))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

let dotEnvLoaded = false;

/**
 * Loads `.env` (and `.env.local`, which wins) from the repository root exactly
 * once per process. Values already present in `process.env` are never
 * overwritten, so real environment variables always take precedence.
 */
export function loadDotEnv(startDirectory: string = process.cwd()): void {
  if (dotEnvLoaded) return;
  dotEnvLoaded = true;

  const root = findRepositoryRoot(startDirectory);
  if (root === null) return;

  // `.env.local` is loaded first so its values win (nothing is overwritten).
  for (const file of ['.env.local', '.env']) {
    const path = join(root, file);
    if (existsSync(path)) {
      loadDotEnvFile({ path, override: false, quiet: true });
    }
  }
}
