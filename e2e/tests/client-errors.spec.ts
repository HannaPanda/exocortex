import { expect, test } from '@playwright/test';

import { requireSeedCredentials } from '../support/fixtures';
import { storageStatePath } from '../support/global-setup';

// Reuse the session created by the global setup instead of logging in again:
// sign-in is rate limited by design.
test.use({ storageState: storageStatePath('johanna') });

test.beforeAll(() => {
  requireSeedCredentials();
});

/**
 * Every authenticated route has to survive hydration.
 *
 * This exists because of a class of defect that no other layer can see: a module
 * that throws while the browser evaluates it. Typecheck, lint and the unit tests
 * were all green, the server rendered the markup, and `/admin` still died the
 * moment its bundle ran -- Turbopack's scope hoisting had merged
 * `prosemirror-tables` into a factory shared by 41 module ids, so its
 * `Selection.jsonID('cell')` side effect ran twice. Only a production build
 * hoists, and only a browser evaluates, so this suite is the one place that can
 * catch it.
 *
 * The routes below are those a signed-in user reaches without a workspace id;
 * `/admin` is deliberately included even though the seed user is not an
 * administrator, because the bundle is evaluated before the guard renders.
 */
const ROUTES = ['/arbeitsbereich', '/admin', '/admin/einstellungen', '/einstellungen/verbindungen'];

test.describe('client runtime', () => {
  for (const route of ROUTES) {
    test(`renders ${route} without an uncaught error`, async ({ page }) => {
      const failures: string[] = [];
      page.on('pageerror', (error) => failures.push(`${error.name}: ${error.message}`));

      await page.goto(route);
      // The connection indicator is a client component in the shell, so waiting
      // for it means waiting for hydration rather than for the server's markup.
      await expect(page.getByTestId('connection-status')).toBeVisible();

      // Both boundaries above the route: the segment one keeps the shell, the
      // root one replaces it.
      await expect(page.getByText('Diese Seite konnte nicht geladen werden')).toHaveCount(0);
      await expect(page.getByText('Diese Ansicht konnte nicht geladen werden')).toHaveCount(0);
      expect(failures, `uncaught client errors on ${route}`).toEqual([]);
    });
  }
});
