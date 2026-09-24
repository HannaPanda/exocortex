import { defineConfig, devices } from '@playwright/test';

/**
 * The styleguide gate (issue #127): screenshots, accessibility and keyboard
 * checks against /design-system, plus the behaviour tests of the page itself.
 *
 * Separate from `playwright.config.ts` because it needs none of what that suite
 * needs: no deployment, no seeded accounts, no sign-in. The page is public and
 * draws only local fixtures, so `scripts/test-styleguide.sh` serves the web
 * build that `build.sh` just produced on a port of its own and points this
 * config at it. That is what lets it run in CI, before anything is deployed.
 *
 * Always run it through that script, never with a bare `playwright test`: the
 * script runs the browser inside the pinned Playwright image, and the baselines
 * are only comparable between runs that rasterise text with the same fonts,
 * FreeType and Chromium. A screenshot taken on the host differs from the
 * container's in antialiasing alone.
 */
const baseURL = process.env.STYLEGUIDE_BASE_URL ?? 'http://127.0.0.1:3290';

export default defineConfig({
  testDir: './styleguide',
  // One file per baseline, without the platform suffix: there is exactly one
  // platform, the container, and a suffix would only invite a second set.
  snapshotPathTemplate: '{testDir}/__screenshots__/{testFileName}/{arg}{ext}',
  timeout: 60_000,
  expect: {
    timeout: 10_000,
    toHaveScreenshot: {
      // Also the defaults; stated because they are the determinism contract.
      animations: 'disabled',
      caret: 'hide',
      scale: 'css',
    },
  },
  fullyParallel: false,
  forbidOnly: process.env.CI === 'true',
  // No retries: a screenshot that needs a second attempt is flaky, and a flaky
  // baseline is one nobody believes when it is red for a real reason.
  retries: 0,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    locale: 'de-DE',
    timezoneId: 'Europe/Berlin',
    colorScheme: 'dark',
    reducedMotion: 'reduce',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } },
    },
  ],
});
