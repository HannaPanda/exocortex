import { defineConfig, devices } from '@playwright/test';

import { BASIC_AUTH_CREDENTIALS } from './support/basic-auth';
import { loadRepositoryEnv } from './support/env';

// `import` is hoisted, so a module that reads `process.env` while it is being
// evaluated cannot be helped by a call placed above it here. Every such module
// loads the file itself; this call is for the variables read below.
loadRepositoryEnv();

/**
 * The suite runs against a real deployment, and signs in as the seeded test
 * accounts (`johanna@exocortex.app`, `stefan@exocortex.app`) in the "Exocortex
 * Team" workspace — never as the person who owns the deployment. Their passwords
 * come from the repository's `.env`; `docs/local-development.md` says how to
 * reissue one.
 *
 * Override with:
 *   E2E_BASE_URL       default https://exocortex.app
 *   E2E_BASIC_USER     default johanna
 *   E2E_BASIC_PASSWORD only if the deployment under test has a basic auth realm
 *   E2E_SKIP_CLEANUP   set to 1 to keep the workspaces the run created
 */
const baseURL = process.env.E2E_BASE_URL ?? 'https://exocortex.app';

export default defineConfig({
  testDir: './tests',
  globalSetup: './support/global-setup.ts',
  // Deletes the workspaces the run created; see the file for why the tests
  // cannot do it themselves.
  globalTeardown: './support/global-teardown.ts',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  forbidOnly: process.env.CI === 'true',
  retries: process.env.CI === 'true' ? 1 : 0,
  workers: 1,
  reporter: process.env.CI === 'true' ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL,
    httpCredentials: BASIC_AUTH_CREDENTIALS,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    locale: 'de-DE',
    timezoneId: 'Europe/Berlin',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
