import { defineConfig, devices } from '@playwright/test';

/**
 * The suite runs against a real deployment: nginx terminates TLS and protects the
 * app with HTTP basic auth, so `httpCredentials` is part of the configuration.
 *
 * Override with:
 *   E2E_BASE_URL       default https://exocortex.app
 *   E2E_BASIC_USER     default johanna
 *   E2E_BASIC_PASSWORD default test123
 *   E2E_SKIP_CLEANUP   set to 1 to keep the workspaces the run created
 */
const baseURL = process.env.E2E_BASE_URL ?? 'https://exocortex.app';
const basicUser = process.env.E2E_BASIC_USER ?? 'johanna';
const basicPassword = process.env.E2E_BASIC_PASSWORD ?? 'test123';

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
    httpCredentials: { username: basicUser, password: basicPassword },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    locale: 'de-DE',
    timezoneId: 'Europe/Berlin',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
