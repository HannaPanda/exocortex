import { expect, test } from '@playwright/test';

import { requireSeedCredentials } from '../support/fixtures';
import { storageStatePath } from '../support/global-setup';

test.use({ storageState: storageStatePath('johanna') });

test.beforeAll(() => {
  requireSeedCredentials();
});

/**
 * That the two deployment-wide reading rooms exist and answer (issues #46, #47).
 *
 * Both are reached through the account menu at every width: the header's row of
 * icons is gone, so the path here is the path a person takes.
 *
 * Both shipped as tools with no screen at all: an agent could list entities,
 * confirm a proposed name and promote a fact into a curated workspace, and a
 * person could do none of it -- even though ADR-021 calls promotion a human
 * act. A smoke test rather than a workflow, because what broke here was never
 * the logic; it was that nothing rendered it.
 */
test.describe('Entitäten und Gedächtnis', () => {
  test('sind aus dem Kopf der Anwendung erreichbar', async ({ page }) => {
    await page.goto('/arbeitsbereich');
    await page.waitForURL(/\/arbeitsbereich\/[a-z0-9]+/, { timeout: 60_000 });

    await page.getByTestId('open-global-menu').click();
    await page.getByTestId('menu-open-entities').click();
    await page.waitForURL(/\/entitaeten$/, { timeout: 30_000 });
    await expect(page.getByRole('heading', { name: 'Entitäten', level: 1 })).toBeVisible();
    // Either the list or the empty state, but never a crash and never a
    // permanent spinner: the page answers even without an entity database.
    await expect(page.getByTestId('entity-search').or(page.getByRole('alert')).first()).toBeVisible(
      { timeout: 30_000 },
    );

    await page.getByTestId('open-global-menu').click();
    await page.getByTestId('menu-open-memory').click();
    await page.waitForURL(/\/gedaechtnis$/, { timeout: 30_000 });
    await expect(page.getByRole('heading', { name: 'Gedächtnis', level: 1 })).toBeVisible();
    await expect(page.getByTestId('memory-status')).toBeVisible({ timeout: 30_000 });
  });
});
