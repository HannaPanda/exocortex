import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Loads the repository's `.env` into `process.env`.
 *
 * The suite's credentials have always lived there — `pnpm db:seed` writes them
 * and `deploy/README.md` treats that file as the one place secrets sit on this
 * host — but Playwright is not started through anything that reads it, so a run
 * failed at the first assertion with "Missing password for seed user" until
 * somebody exported the two variables by hand. That is a trap: the value was
 * present, the process just could not see it.
 *
 * Parsed here rather than through `@exocortex/config`'s `loadDotEnv`, because
 * `@exocortex/e2e` depends on no workspace package on purpose
 * (`scripts/dependency-graph.mjs`): the suite tests the deployment from the
 * outside, and a suite that imports the code it is testing can pass because both
 * sides share a mistake.
 *
 * An existing variable always wins, so `E2E_BASE_URL=… pnpm test:e2e` still
 * points a run at a staging deployment.
 */
const ENV_FILE = join(__dirname, '..', '..', '.env');

let loaded = false;

export function loadRepositoryEnv(): void {
  if (loaded) return;
  loaded = true;
  if (!existsSync(ENV_FILE)) return;

  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;

    const separator = trimmed.indexOf('=');
    if (separator <= 0) continue;

    const key = trimmed.slice(0, separator).trim();
    if (process.env[key] !== undefined) continue;

    // Everything after the first `=` is the value, quotes stripped only when
    // they wrap the whole of it. `SMTP_FROM=eXocortex <a@b.de>` has to survive
    // verbatim.
    const raw = trimmed.slice(separator + 1).trim();
    const quote = raw.charAt(0);
    const quoted = raw.length >= 2 && (quote === '"' || quote === "'") && raw.endsWith(quote);
    process.env[key] = quoted ? raw.slice(1, -1) : raw;
  }
}
